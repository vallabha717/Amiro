//! GitHub connection routes.
//!
//! The GitHub personal access token is no longer stored in plaintext. It lives
//! sealed in the encrypted credential store under service `github`, field
//! `token`, and is exported to runtime processes as `AMIRO_CRED_GITHUB_TOKEN`
//! (plus the conventional `GITHUB_TOKEN`/`GH_TOKEN` aliases). `store/github.json`
//! only ever records connection state and a masked hint.
//!
//! A legacy plaintext `store/github.json` is migrated into the store on first
//! read and rewritten without the token.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};
use crate::{composio_config, credentials};

const SERVICE: &str = "github";
const FIELD: &str = "token";
const LABEL: &str = "GitHub Personal Access Token";

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn store_path(state: &AppState, key: &str) -> PathBuf {
    state.home.join("store").join(key)
}

/// Write the connection record. The token is never written here.
async fn write_record(
    state: &AppState,
    connected: bool,
    hint: Option<String>,
) -> Result<(), ApiError> {
    let file = store_path(state, "github.json");
    let record = json!({
        "connected": connected,
        "token": Value::Null,
        "tokenHint": hint,
        "updatedAt": now_iso(),
    });
    let _lock = state.store.lock().await;
    write_json(&file, &record).await
}

/// Move a plaintext token from a legacy `store/github.json` into the encrypted
/// store and rewrite the file without it. Idempotent and safe to call on every
/// request.
async fn migrate_legacy(state: &AppState) -> Result<(), ApiError> {
    let file = store_path(state, "github.json");
    let cfg = read_json(&file, json!({ "connected": false })).await?;
    let legacy = cfg
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);
    let Some(token) = legacy else {
        return Ok(());
    };

    let metadata = credentials::set(state, SERVICE, FIELD, &token, Some(LABEL)).await?;
    write_record(state, true, Some(metadata.hint)).await?;
    composio_config::refresh_runtime_key(state);
    tracing::info!("migrated the legacy plaintext GitHub token into the encrypted credential store");
    Ok(())
}

async fn get_github_status(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    migrate_legacy(&state).await?;

    let secret = credentials::get_plaintext(&state, SERVICE, FIELD).await?;
    match secret {
        Some(secret) => Ok(Json(json!({
            "connected": true,
            "tokenHint": credentials::masked_hint(secret.expose()),
        }))),
        None => {
            let cfg = read_json(&store_path(&state, "github.json"), json!({})).await?;
            let explicitly_disconnected = cfg
                .get("connected")
                .and_then(Value::as_bool)
                .map(|connected| !connected)
                .unwrap_or(false);
            Ok(Json(json!({
                "connected": false,
                "tokenHint": cfg.get("tokenHint").cloned().unwrap_or(Value::Null),
                "disconnected": explicitly_disconnected,
            })))
        }
    }
}

async fn post_github_connect(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let token = body
        .get("token")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim();
    if token.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "token is required".to_string(),
        ));
    }

    let metadata = credentials::set(&state, SERVICE, FIELD, token, Some(LABEL)).await?;
    write_record(&state, true, Some(metadata.hint.clone())).await?;
    composio_config::refresh_runtime_key(&state);

    Ok(Json(json!({
        "connected": true,
        "tokenHint": metadata.hint,
    })))
}

async fn post_github_disconnect(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    credentials::delete(&state, SERVICE, FIELD).await?;
    write_record(&state, false, None).await?;
    composio_config::refresh_runtime_key(&state);

    Ok(Json(json!({ "success": true })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/github/status", get(get_github_status))
        .route("/api/github/connect", post(post_github_connect))
        .route("/api/github/disconnect", post(post_github_disconnect))
}
