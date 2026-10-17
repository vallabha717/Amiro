use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

use crate::state::{read_json, ApiError, AppState, AuthUser};

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

async fn verify_thread_ownership(
    state: &AppState,
    user: &AuthUser,
    thread_id: &str,
) -> Result<(), ApiError> {
    let uid = user_id_of(user);
    let role = user.0.get("role").and_then(|r| r.as_str()).unwrap_or("user");

    let threads_file = state.home.join("threads.json");
    let threads_doc = read_json(&threads_file, json!({})).await.unwrap_or(json!({}));

    if let Some(thread) = threads_doc.get(thread_id) {
        let t_uid = thread.get("userId").and_then(|u| u.as_str()).unwrap_or("");
        if t_uid != uid && role != "admin" {
            return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
        }
        Ok(())
    } else if role == "admin" {
        Ok(())
    } else {
        Err(ApiError(StatusCode::NOT_FOUND, "Thread not found".to_string()))
    }
}

#[derive(Debug, Deserialize, Default)]
struct CheckpointQuery {
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
    #[serde(rename = "turnId")]
    turn_id: Option<String>,
}

/// Resolve a checkpoint path inside the workspace.
///
/// A lexical `starts_with` is not enough: `workspace.join("../x")` still starts
/// with the workspace prefix while pointing outside it. Absolute paths, `..`
/// components, and symlinked ancestors that leave the workspace are rejected.
fn resolve_workspace_file(workspace: &Path, relative: &str) -> Result<PathBuf, ApiError> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "checkpoint path must not be empty".to_string(),
        ));
    }
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "checkpoint path escapes workspace".to_string(),
        ));
    }
    let target = workspace.join(relative);
    // Walk up to the deepest existing ancestor and prove it really is inside
    // the workspace, which also catches a symlinked directory in the chain.
    let mut ancestor = target.parent();
    while let Some(parent) = ancestor {
        if parent.exists() {
            let canonical = std::fs::canonicalize(parent).map_err(|error| {
                ApiError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("could not resolve checkpoint path: {error}"),
                )
            })?;
            if !canonical.starts_with(workspace) {
                return Err(ApiError(
                    StatusCode::FORBIDDEN,
                    "checkpoint path escapes workspace".to_string(),
                ));
            }
            break;
        }
        ancestor = parent.parent();
    }
    Ok(target)
}

async fn get_checkpoint_files(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<CheckpointQuery>,
) -> Result<Json<Value>, ApiError> {
    let thread_id = query.thread_id.unwrap_or_default().trim().to_string();
    let turn_id = query.turn_id.unwrap_or_default().trim().to_string();

    if thread_id.is_empty() || turn_id.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "threadId and turnId are required".to_string(),
        ));
    }

    verify_thread_ownership(&state, &user, &thread_id).await?;

    let checkpoints_file = store_path(&state, "checkpoints.json");
    let doc = read_json(&checkpoints_file, json!({})).await?;

    let key = format!("{thread_id}:{turn_id}");
    let empty_vec = Vec::new();
    let files = doc
        .get(&key)
        .and_then(|v| v.get("files"))
        .and_then(|f| f.as_array())
        .unwrap_or(&empty_vec);

    let mapped: Vec<Value> = files
        .iter()
        .map(|f| {
            json!({
                "path": f.get("path").cloned().unwrap_or(json!("")),
                "existedBefore": f.get("existedBefore").and_then(|b| b.as_bool()).unwrap_or(false),
            })
        })
        .collect();

    Ok(Json(json!({
        "turnId": turn_id,
        "files": mapped,
    })))
}

async fn restore_checkpoint(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let thread_id = body
        .get("threadId")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim();
    let turn_id = body
        .get("turnId")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim();

    if thread_id.is_empty() || turn_id.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "threadId and turnId are required".to_string(),
        ));
    }

    verify_thread_ownership(&state, &user, thread_id).await?;

    let checkpoints_file = store_path(&state, "checkpoints.json");
    let doc = read_json(&checkpoints_file, json!({})).await?;

    let key = format!("{thread_id}:{turn_id}");
    let entry = doc.get(&key);

    let empty_vec = Vec::new();
    let files = entry
        .and_then(|v| v.get("files"))
        .and_then(|f| f.as_array())
        .unwrap_or(&empty_vec);

    if files.is_empty() {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("No checkpoint found for turn {turn_id}"),
        ));
    }

    // Check if any file has actual content to restore or deletion capability
    let has_restorable_data = files.iter().any(|f| {
        f.get("content").is_some()
            || f.get("blobId").is_some()
            || f.get("blob_id").is_some()
            || (f.get("existedBefore").and_then(|b| b.as_bool()) == Some(false))
    });

    if !has_restorable_data {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "Checkpoint rewind restoration is not supported for snapshots without recorded file blobs".to_string(),
        ));
    }

    let mut restored_files = Vec::new();
    let workspace = std::fs::canonicalize(&state.workspace).map_err(|error| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("workspace is not available for restore: {error}"),
        )
    })?;

    for f in files {
        let file_path_rel = f.get("path").and_then(|p| p.as_str()).unwrap_or("");
        if file_path_rel.is_empty() {
            continue;
        }

        // Rejects traversal and symlinked escapes before anything is written.
        let target_path = resolve_workspace_file(&workspace, file_path_rel)?;

        let existed_before = f.get("existedBefore").and_then(|b| b.as_bool()).unwrap_or(false);

        if !existed_before {
            // File did not exist before turn; delete it on restore
            let _ = tokio::fs::remove_file(&target_path).await;
            restored_files.push(json!({
                "path": file_path_rel,
                "existedBefore": false,
                "restored": true,
            }));
        } else if let Some(content) = f.get("content").and_then(|c| c.as_str()) {
            if let Some(parent) = target_path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            tokio::fs::write(&target_path, content.as_bytes()).await.map_err(|e| {
                ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to restore file {file_path_rel}: {e}"))
            })?;
            restored_files.push(json!({
                "path": file_path_rel,
                "existedBefore": true,
                "restored": true,
            }));
        } else {
            return Err(ApiError(
                StatusCode::NOT_IMPLEMENTED,
                format!("Missing file snapshot data for {file_path_rel}"),
            ));
        }
    }

    Ok(Json(json!({
        "turnId": turn_id,
        "files": restored_files,
    })))
}

async fn dead_checkpoint_latest() -> Result<Json<Value>, ApiError> {
    Err(ApiError(StatusCode::NOT_FOUND, "removed".to_string()))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/checkpoint/files", get(get_checkpoint_files))
        .route("/api/checkpoint/restore", post(restore_checkpoint))
        .route("/api/checkpoint/latest", get(dead_checkpoint_latest))
}
