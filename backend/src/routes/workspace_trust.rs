use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

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

fn resolve_root(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let p = Path::new(raw);
    match std::fs::canonicalize(p) {
        Ok(c) => c.to_string_lossy().to_string(),
        Err(_) => {
            // If it doesn't exist on disk yet, clean it up with absolute path
            if p.is_absolute() {
                p.to_string_lossy().to_string()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("/"))
                    .join(p)
                    .to_string_lossy()
                    .to_string()
            }
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct TrustStatusQuery {
    root: Option<String>,
}

async fn list_workspace_trust(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let doc_file = store_path(&state, "workspace-trust.json");
    let doc = read_json(&doc_file, json!({})).await?;

    let grants = doc.get(&uid).and_then(|v| v.as_array());
    let mut user_grants = Vec::new();
    if let Some(list) = grants {
        for g in list {
            user_grants.push(json!({
                "resolvedRoot": g.get("resolvedRoot").cloned().unwrap_or(json!("")),
                "grantedAt": g.get("grantedAt").cloned().unwrap_or_else(|| json!(now_iso())),
                "grantedVia": g.get("grantedVia").cloned().unwrap_or(json!("prompt")),
            }));
        }
    }

    Ok(Json(json!({ "grants": user_grants })))
}

async fn get_workspace_trust_status(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<TrustStatusQuery>,
) -> Result<Json<Value>, ApiError> {
    let raw_root = query.root.unwrap_or_default().trim().to_string();
    if raw_root.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "root is required".to_string()));
    }

    let resolved = resolve_root(&raw_root);
    let default_root = resolve_root(&state.workspace.to_string_lossy());

    if !resolved.is_empty() && resolved == default_root {
        return Ok(Json(json!({ "trusted": true, "resolvedRoot": resolved })));
    }

    let uid = user_id_of(&user);
    let doc_file = store_path(&state, "workspace-trust.json");
    let doc = read_json(&doc_file, json!({})).await?;

    let mut trusted = false;
    if let Some(list) = doc.get(&uid).and_then(|v| v.as_array()) {
        trusted = list
            .iter()
            .any(|g| g.get("resolvedRoot").and_then(|r| r.as_str()) == Some(&resolved));
    }

    Ok(Json(json!({ "trusted": trusted, "resolvedRoot": resolved })))
}

async fn grant_workspace_trust(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let raw_root = body
        .get("root")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .trim();
    if raw_root.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "root is required".to_string()));
    }

    let resolved = resolve_root(raw_root);
    let now = now_iso();
    let uid = user_id_of(&user);

    let doc_file = store_path(&state, "workspace-trust.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&doc_file, json!({})).await?;

        let map = match doc.as_object_mut() {
            Some(m) => m,
            None => {
                doc = json!({});
                doc.as_object_mut().unwrap()
            }
        };

        let user_entry = map.entry(&uid).or_insert_with(|| json!([]));
        if let Some(list) = user_entry.as_array_mut() {
            if let Some(existing) = list
                .iter_mut()
                .find(|g| g.get("resolvedRoot").and_then(|r| r.as_str()) == Some(&resolved))
            {
                existing["grantedAt"] = json!(now);
            } else {
                list.push(json!({
                    "resolvedRoot": resolved,
                    "grantedAt": now,
                    "grantedVia": "prompt",
                }));
            }
        }

        write_json(&doc_file, &doc).await?;
    }
    Ok(Json(json!({ "trusted": true, "resolvedRoot": resolved })))
}

async fn revoke_workspace_trust(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let raw_root = body
        .get("root")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .trim();
    if raw_root.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "root is required".to_string()));
    }

    let resolved = resolve_root(raw_root);
    let uid = user_id_of(&user);

    let doc_file = store_path(&state, "workspace-trust.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&doc_file, json!({})).await?;

        if let Some(map) = doc.as_object_mut() {
            if let Some(user_entry) = map.get_mut(&uid) {
                if let Some(list) = user_entry.as_array_mut() {
                    list.retain(|g| g.get("resolvedRoot").and_then(|r| r.as_str()) != Some(&resolved));
                }
            }
        }

        write_json(&doc_file, &doc).await?;
    }
    Ok(Json(json!({ "success": true })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workspace-trust", get(list_workspace_trust))
        .route("/api/workspace-trust/status", get(get_workspace_trust_status))
        .route("/api/workspace-trust/grant", post(grant_workspace_trust))
        .route("/api/workspace-trust/revoke", post(revoke_workspace_trust))
}
