use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::state::{ApiError, AppState, AuthUser};

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "admin required".to_string()));
    }
    Ok(())
}

fn env_file_path(state: &AppState, provider_id: &str) -> std::path::PathBuf {
    state
        .runtime_home
        .join("config")
        .join("jcode")
        .join(format!("{provider_id}.env"))
}

async fn run_cli_json(state: &AppState, args: &[&str]) -> Option<Value> {
    let mut cmd = Command::new(&state.runtime_bin);
    cmd.args(args);
    cmd.env("AMIRO_HOME", &state.home);
    cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());

    let output = cmd.output().await.ok()?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str(text.trim()).ok()
    } else {
        None
    }
}

async fn get_provider_catalog(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let list_json = run_cli_json(&state, &["provider", "list", "--json"]).await;
    let auth_json = run_cli_json(&state, &["auth", "status", "--json"]).await;

    let empty_vec = Vec::new();
    let providers_list = list_json
        .as_ref()
        .and_then(|v| v.get("providers"))
        .and_then(|p| p.as_array())
        .unwrap_or(&empty_vec);

    let auth_list = auth_json
        .as_ref()
        .and_then(|v| v.get("providers"))
        .and_then(|p| p.as_array())
        .unwrap_or(&empty_vec);

    let mut result_providers = Vec::new();
    for p in providers_list {
        let id = p.get("id").and_then(|i| i.as_str()).unwrap_or("");
        let auth_entry = auth_list
            .iter()
            .find(|a| a.get("id").and_then(|i| i.as_str()) == Some(id));

        let status = auth_entry
            .and_then(|a| a.get("status"))
            .cloned()
            .unwrap_or_else(|| json!("not_configured"));

        let mut item = p.clone();
        if let Some(obj) = item.as_object_mut() {
            obj.insert("status".to_string(), status);
        }
        result_providers.push(item);
    }

    if result_providers.is_empty() {
        // Fallback standard catalog if CLI didn't respond
        let default_providers = json!([
            { "id": "openai", "name": "OpenAI", "mechanism": "api-key", "status": "not_configured" },
            { "id": "anthropic", "name": "Anthropic", "mechanism": "api-key", "status": "not_configured" },
            { "id": "openrouter", "name": "OpenRouter", "mechanism": "api-key", "status": "not_configured" },
            { "id": "gemini", "name": "Google Gemini", "mechanism": "api-key", "status": "not_configured" },
            { "id": "groq", "name": "Groq", "mechanism": "api-key", "status": "not_configured" },
            { "id": "openai-compatible", "name": "OpenAI Compatible", "mechanism": "api-key", "status": "not_configured" }
        ]);
        return Ok(Json(json!({ "providers": default_providers })));
    }

    Ok(Json(json!({ "providers": result_providers })))
}

async fn post_provider_api_key(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let provider_id = id.trim().to_lowercase();
    if provider_id.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "provider id required".to_string()));
    }

    let raw_key = body
        .get("apiKey")
        .or_else(|| body.get("key"))
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .trim();

    if raw_key.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "apiKey is required".to_string()));
    }
    if raw_key.len() < 4 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "apiKey too short".to_string()));
    }
    if raw_key.len() > 4096 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "apiKey too long".to_string()));
    }

    let api_base = body
        .get("apiBase")
        .or_else(|| body.get("baseUrl"))
        .and_then(|b| b.as_str())
        .map(|s| s.trim())
        .unwrap_or("");

    let mut cmd = Command::new(&state.runtime_bin);
    cmd.env("AMIRO_HOME", &state.home);
    cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);

    if provider_id == "openai-compatible" {
        if api_base.is_empty() {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "apiBase is required for openai-compatible".to_string(),
            ));
        }
        cmd.args([
            "login",
            &provider_id,
            "--api-base",
            api_base,
            "--api-key",
            raw_key,
            "--no-validate",
        ]);
        cmd.stdin(Stdio::null());
    } else {
        cmd.args(["login", &provider_id, "--no-validate"]);
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    if provider_id != "openai-compatible" {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(format!("{raw_key}\n").as_bytes()).await;
            let _ = stdin.flush().await;
        }
    }

    let output = child.wait_with_output().await.map_err(|e| {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    if !output.status.success() {
        let err_text = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            if err_text.trim().is_empty() {
                "Failed to store API key".to_string()
            } else {
                err_text.trim().to_string()
            },
        ));
    }

    Ok(Json(json!({
        "ok": true,
        "provider": provider_id,
        "available": true,
    })))
}

async fn delete_provider_credentials(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let provider_id = id.trim().to_lowercase();
    if provider_id.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "provider id required".to_string()));
    }

    let file = env_file_path(&state, &provider_id);
    let _ = tokio::fs::remove_file(&file).await;
    let _ = tokio::fs::remove_file(format!("{}.bak", file.to_string_lossy())).await;

    Ok(Json(json!({
        "ok": true,
        "provider": provider_id,
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers/catalog", get(get_provider_catalog))
        .route("/api/providers/{id}/api-key", post(post_provider_api_key))
        .route(
            "/api/providers/{id}/credentials",
            delete(delete_provider_credentials),
        )
}
