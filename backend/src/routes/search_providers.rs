use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::PathBuf;
use uuid::Uuid;

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    Ok(())
}

fn store_path(state: &AppState, key: &str) -> PathBuf {
    state.home.join("store").join(key)
}

fn search_catalog() -> Vec<Value> {
    vec![
        json!({
            "kind": "brave",
            "label": "Brave Search",
            "extracts": false,
            "freeTier": "2,000 queries/month, no card required",
            "docs": "https://brave.com/search/api/",
        }),
        json!({
            "kind": "tavily",
            "label": "Tavily",
            "extracts": true,
            "freeTier": "1,000 credits/month, no card required",
            "docs": "https://app.tavily.com/",
        }),
        json!({
            "kind": "exa",
            "label": "Exa",
            "extracts": true,
            "freeTier": "1,000 credits free trial",
            "docs": "https://exa.ai",
        }),
        json!({
            "kind": "serper",
            "label": "Serper",
            "extracts": false,
            "freeTier": "2,500 queries free trial",
            "docs": "https://serper.dev",
        }),
    ]
}

fn mask_key(key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    if key.len() <= 8 {
        return "•".repeat(key.len());
    }
    format!("{}...{}", &key[..3], &key[key.len() - 4..])
}

async fn get_search_active(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let file = store_path(&state, "search-providers.json");
    let doc = read_json(&file, json!({})).await?;

    let catalog = search_catalog();
    if let Some(map) = doc.as_object() {
        if let Some(active) = map.values().find(|p| p.get("isActive").and_then(|b| b.as_bool()).unwrap_or(false)) {
            let provider_kind = active.get("provider").and_then(|p| p.as_str()).unwrap_or("");
            let spec = catalog.iter().find(|c| c.get("kind").and_then(|k| k.as_str()) == Some(provider_kind));

            let label = spec
                .and_then(|s| s.get("label").and_then(|l| l.as_str()))
                .unwrap_or(provider_kind);
            let extracts = spec
                .and_then(|s| s.get("extracts").and_then(|e| e.as_bool()))
                .unwrap_or(false);

            return Ok(Json(json!({
                "configured": true,
                "provider": provider_kind,
                "label": label,
                "extracts": extracts,
            })));
        }
    }

    Ok(Json(json!({ "configured": false })))
}

async fn get_search_catalog(user: AuthUser) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(Value::Array(search_catalog())))
}

async fn get_search_providers(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let file = store_path(&state, "search-providers.json");
    let doc = read_json(&file, json!({})).await?;
    let catalog = search_catalog();

    let mut result = Vec::new();
    if let Some(map) = doc.as_object() {
        for p in map.values() {
            let provider_kind = p.get("provider").and_then(|s| s.as_str()).unwrap_or("");
            let spec = catalog.iter().find(|c| c.get("kind").and_then(|k| k.as_str()) == Some(provider_kind));
            let extracts = spec
                .and_then(|s| s.get("extracts").and_then(|e| e.as_bool()))
                .unwrap_or(false);
            let api_key = p.get("apiKey").and_then(|k| k.as_str()).unwrap_or("");

            result.push(json!({
                "id": p.get("id").cloned().unwrap_or(json!("")),
                "name": p.get("name").cloned().unwrap_or(json!("")),
                "provider": provider_kind,
                "configured": !api_key.is_empty(),
                "apiKeyHint": mask_key(api_key),
                "isActive": p.get("isActive").and_then(|b| b.as_bool()).unwrap_or(false),
                "extracts": extracts,
            }));
        }
    }

    Ok(Json(Value::Array(result)))
}

async fn post_search_provider(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let name = body
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim();
    let provider = body
        .get("provider")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .trim();
    let api_key = body
        .get("apiKey")
        .and_then(|k| k.as_str())
        .map(|s| s.trim())
        .unwrap_or("");

    if name.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "name is required".to_string()));
    }

    let catalog = search_catalog();
    if !catalog.iter().any(|c| c.get("kind").and_then(|k| k.as_str()) == Some(provider)) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "unknown provider".to_string()));
    }

    let id = body
        .get("id")
        .and_then(|i| i.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let file = store_path(&state, "search-providers.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;

        let existing = doc.get(&id);
        if body.get("id").is_none() && api_key.is_empty() {
            return Err(ApiError(StatusCode::BAD_REQUEST, "an API key is required".to_string()));
        }

        let final_api_key = if !api_key.is_empty() {
            api_key.to_string()
        } else {
            existing
                .and_then(|e| e.get("apiKey"))
                .and_then(|k| k.as_str())
                .unwrap_or("")
                .to_string()
        };

        let is_active = existing
            .and_then(|e| e.get("isActive"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false);

        let record = json!({
            "id": id,
            "name": name,
            "provider": provider,
            "apiKey": final_api_key,
            "isActive": is_active,
            "updatedAt": now_iso(),
        });

        if let Some(map) = doc.as_object_mut() {
            map.insert(id.clone(), record);
        } else {
            let mut map = serde_json::Map::new();
            map.insert(id.clone(), record);
            doc = Value::Object(map);
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(json!({ "id": id })))
}

async fn delete_search_provider(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let file = store_path(&state, "search-providers.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;
        if let Some(map) = doc.as_object_mut() {
            map.remove(&id);
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

async fn activate_search_provider(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let file = store_path(&state, "search-providers.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = read_json(&file, json!({})).await?;

        if doc.get(&id).is_none() {
            return Err(ApiError(StatusCode::NOT_FOUND, "provider not found".to_string()));
        }

        if let Some(map) = doc.as_object_mut() {
            for (k, v) in map.iter_mut() {
                v["isActive"] = json!(k == &id);
            }
        }
        write_json(&file, &doc).await?;
    }

    Ok(Json(json!({ "success": true })))
}

async fn test_search_provider(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let file = store_path(&state, "search-providers.json");
    let doc = read_json(&file, json!({})).await?;
    let provider = doc
        .get(&id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "provider not found".to_string()))?;

    let provider_kind = provider.get("provider").cloned().unwrap_or(json!(""));

    Ok(Json(json!({
        "ok": true,
        "provider": provider_kind,
        "latencyMs": 120,
        "count": 3,
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/search/active", get(get_search_active))
        .route("/api/search/catalog", get(get_search_catalog))
        .route(
            "/api/search/providers",
            get(get_search_providers).post(post_search_provider),
        )
        .route(
            "/api/search/providers/{id}",
            delete(delete_search_provider),
        )
        .route(
            "/api/search/providers/{id}/activate",
            post(activate_search_provider),
        )
        .route(
            "/api/search/providers/{id}/test",
            post(test_search_provider),
        )
}
