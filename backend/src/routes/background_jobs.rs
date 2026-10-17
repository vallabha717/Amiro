use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::{Path as FsPath, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use uuid::Uuid;

use crate::routes::fsbrowse::{is_denied, is_inside_roots, resolve_browse_roots};
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn user_id_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn store_path(state: &AppState, key: &str) -> PathBuf {
    state.home.join("store").join(key)
}

fn is_operator_authorized(user: &AuthUser) -> bool {
    let role = user.0.get("role").and_then(|r| r.as_str()).unwrap_or("user");
    if role == "admin" {
        return true;
    }
    let trusted = std::env::var("AMIRO_TRUSTED_OPERATOR").map(|v| v == "1").unwrap_or(false);
    let full_tools = std::env::var("AMIRO_TOOL_PROFILE").map(|v| v == "full").unwrap_or(false);
    trusted && full_tools
}

async fn is_workspace_trusted(state: &AppState, user_id: &str, target_path: &FsPath) -> bool {
    let target_canon = match std::fs::canonicalize(target_path) {
        Ok(c) => c,
        Err(_) => target_path.to_path_buf(),
    };
    let target_str = target_canon.to_string_lossy();

    let default_canon = match std::fs::canonicalize(&state.workspace) {
        Ok(c) => c,
        Err(_) => state.workspace.clone(),
    };
    if target_canon == default_canon {
        return true;
    }

    let trust_file = store_path(state, "workspace-trust.json");
    if let Ok(doc) = read_json(&trust_file, json!({})).await {
        if let Some(list) = doc.get(user_id).and_then(|v| v.as_array()) {
            return list.iter().any(|g| {
                g.get("resolvedRoot")
                    .and_then(|r| r.as_str())
                    .map(|r| r == target_str)
                    .unwrap_or(false)
            });
        }
    }
    false
}

async fn list_background_jobs(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let role = user.0.get("role").and_then(|r| r.as_str()).unwrap_or("user");

    let file = store_path(&state, "background-jobs.json");
    let doc = read_json(&file, json!({})).await?;

    let mut list = Vec::new();
    if let Some(map) = doc.as_object() {
        for j in map.values() {
            let j_uid = j.get("userId").and_then(|u| u.as_str()).unwrap_or("");
            if role == "admin" || j_uid == uid {
                list.push(j.clone());
            }
        }
    }

    list.sort_by(|a, b| {
        let b_started = b.get("startedAt").and_then(|s| s.as_str()).unwrap_or("");
        let a_started = a.get("startedAt").and_then(|s| s.as_str()).unwrap_or("");
        b_started.cmp(a_started)
    });

    Ok(Json(json!({ "jobs": list })))
}

async fn start_background_job(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    // 1. Authorization gate: admin or trusted operator with full tools required
    if !is_operator_authorized(&user) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Forbidden: background agent jobs require an admin or trusted operator with full tools enabled".to_string(),
        ));
    }

    let uid = user_id_of(&user);
    let prompt = body
        .get("prompt")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .trim();
    if prompt.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "prompt is required".to_string()));
    }

    let mode = body.get("mode").and_then(|m| m.as_str()).unwrap_or("");
    if mode != "edit" && mode != "auto" {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "mode must be \"edit\" or \"auto\" -- a background job has no one to ask, so plan and interactive are refused at creation".to_string(),
        ));
    }

    let default_root = state.workspace.to_string_lossy().to_string();
    let raw_root = body
        .get("workspaceRoot")
        .and_then(|w| w.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(&default_root);

    let workspace_path = FsPath::new(raw_root);
    if !workspace_path.is_absolute() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "workspaceRoot must be an absolute path".to_string(),
        ));
    }

    // 2. Allowlist and deny-list containment check BEFORE directory creation
    let roots = resolve_browse_roots();
    if is_denied(workspace_path) {
        return Err(ApiError(StatusCode::FORBIDDEN, "access denied".to_string()));
    }
    if !is_inside_roots(workspace_path, &roots) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "workspaceRoot is outside allowed browse roots".to_string(),
        ));
    }

    // 3. User workspace trust verification BEFORE directory creation
    if !is_workspace_trusted(&state, &uid, workspace_path).await {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "workspaceRoot has not been granted trust by the user".to_string(),
        ));
    }

    if let Err(e) = tokio::fs::create_dir_all(workspace_path).await {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("workspaceRoot is not a directory this server can reach: {e}"),
        ));
    }

    let id = Uuid::new_v4().to_string();
    let thread_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let auto_pr = body.get("autoPr").and_then(|b| b.as_bool()).unwrap_or(false);

    let job = json!({
        "id": id,
        "threadId": thread_id,
        "workspaceRoot": raw_root,
        "prompt": prompt,
        "mode": mode,
        "status": "running",
        "autoPr": auto_pr,
        "userId": uid,
        "startedAt": now,
        "finishedAt": Value::Null,
    });

    let file = store_path(&state, "background-jobs.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;
        if let Some(map) = doc.as_object_mut() {
            map.insert(id.clone(), job.clone());
        } else {
            let mut map = serde_json::Map::new();
            map.insert(id.clone(), job.clone());
            doc = Value::Object(map);
        }
        write_json(&file, &doc).await?;
    }

    // Spawn async background execution
    let bin_path = state.runtime_bin.clone();
    let job_id = id.clone();
    let store_file = file.clone();
    let home = state.home.clone();
    let runtime_home = state.runtime_home.clone();
    let run_root = workspace_path.to_path_buf();
    let run_prompt = prompt.to_string();
    let store_mutex = state.store.clone();

    tokio::spawn(async move {
        let mut cmd = Command::new(bin_path);
        cmd.args(["run", "--json", &run_prompt]);
        cmd.current_dir(run_root);
        cmd.env("AMIRO_HOME", &home);
        cmd.env("AMIRO_RUNTIME_HOME", &runtime_home);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let res = cmd.output().await;
        let finished_at = now_iso();

        let _lock = store_mutex.lock().await;
        if let Ok(mut doc) = read_json(&store_file, json!({})).await {
            if let Some(j) = doc.get_mut(&job_id) {
                match res {
                    Ok(output) => {
                        let success = output.status.success();
                        j["status"] = json!(if success { "done" } else { "failed" });
                        j["finishedAt"] = json!(finished_at);
                        if !success {
                            let err_msg = String::from_utf8_lossy(&output.stderr);
                            j["error"] = json!(err_msg.trim());
                        }
                    }
                    Err(e) => {
                        j["status"] = json!("failed");
                        j["finishedAt"] = json!(finished_at);
                        j["error"] = json!(e.to_string());
                    }
                }
                let _ = write_json(&store_file, &doc).await;
            }
        }
    });

    Ok(Json(job))
}

async fn dead_background_job_id(Path(_id): Path<String>) -> Result<Json<Value>, ApiError> {
    Err(ApiError(StatusCode::NOT_FOUND, "removed".to_string()))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/background-jobs", get(list_background_jobs).post(start_background_job))
        .route("/api/background-jobs/{id}", get(dead_background_job_id))
}
