use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::PathBuf;

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn store_path(state: &AppState, key: &str) -> PathBuf {
    state.home.join("store").join(key)
}

async fn get_github_status(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let file = store_path(&state, "github.json");
    let cfg = read_json(&file, json!({ "connected": false })).await?;

    let connected = cfg.get("connected").and_then(|c| c.as_bool()).unwrap_or(false);
    let token = cfg.get("token").and_then(|t| t.as_str()).unwrap_or("");

    Ok(Json(json!({ "connected": connected && !token.is_empty() })))
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
        return Err(ApiError(StatusCode::BAD_REQUEST, "token is required".to_string()));
    }

    let file = store_path(&state, "github.json");
    let record = json!({
        "connected": true,
        "token": token,
        "updatedAt": now_iso(),
    });
    {
        let _lock = state.store.lock().await;
        write_json(&file, &record).await?;
    }

    Ok(Json(json!({ "connected": true })))
}

async fn post_github_disconnect(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let file = store_path(&state, "github.json");
    let record = json!({
        "connected": false,
        "token": Value::Null,
        "updatedAt": now_iso(),
    });
    {
        let _lock = state.store.lock().await;
        write_json(&file, &record).await?;
    }

    Ok(Json(json!({ "success": true })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/github/status", get(get_github_status))
        .route("/api/github/connect", post(post_github_connect))
        .route("/api/github/disconnect", post(post_github_disconnect))
}
