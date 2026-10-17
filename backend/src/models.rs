use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::time::{Duration, Instant};

use crate::state::{ApiError, AppState};

#[derive(Clone)]
struct Catalog {
    at: Instant,
    data: Value,
}

static CATALOG: OnceLock<Arc<Mutex<Option<Catalog>>>> = OnceLock::new();

fn catalog_lock() -> Arc<Mutex<Option<Catalog>>> {
    CATALOG.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

async fn build_catalog(state: &AppState) -> Value {
    let cached = {
        let lock = catalog_lock();
        let guard = lock.lock().unwrap();
        if let Some(c) = guard.as_ref() {
            if c.at.elapsed() < Duration::from_secs(60) {
                return c.data.clone();
            }
        }
        None
    };
    if let Some(v) = cached {
        return v;
    }
    // fetch fresh
    let mut providers: Vec<Value> = vec![];
    let auth = match crate::runtime::auth_status(state).await {
        Ok(v) => v,
        Err(_) => json!({"providers":[]}),
    };
    let available: Vec<Value> = auth.get("providers")
        .and_then(|p| p.as_array())
        .map(|arr| arr.iter().filter(|p| p.get("status").and_then(|s| s.as_str()) == Some("available")).cloned().collect())
        .unwrap_or_default();
    for p in available {
        let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if id.is_empty() { continue; }
        match crate::runtime::model_list(state, &id).await {
            Ok(res) => {
                let models = res.get("models").and_then(|m| m.as_array()).cloned().unwrap_or_default();
                let selected = res.get("selected_model").and_then(|v| v.as_str()).unwrap_or("").to_string();
                providers.push(json!({"id": id, "name": p.get("display_name").and_then(|v| v.as_str()).unwrap_or(&id).to_string(), "models": models, "selectedModel": selected}));
            }
            Err(_) => continue,
        }
    }
    let data = json!({"providers": providers, "rawStatus": auth});
    // store
    {
        let lock = catalog_lock();
        let mut guard = lock.lock().unwrap();
        *guard = Some(Catalog { at: Instant::now(), data: data.clone() });
    }
    data
}

fn allowed_refs(_state: &AppState) -> Option<std::collections::HashSet<String>> {
    if let Ok(raw) = std::env::var("AMIRO_PINNED_MODELS") {
        let trimmed = raw.trim().to_string();
        if !trimmed.is_empty() {
            let set: std::collections::HashSet<String> = trimmed.split(',')
                .map(|s| s.trim().replace("openai-compatible:", ""))
                .filter(|s| !s.is_empty())
                .collect();
            return Some(set);
        }
    }
    None
}

async fn get_chat_models(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let catalog = build_catalog(&state).await;
    let pinned = allowed_refs(&state);
    let is_pinned = pinned.is_some();
    let pinned_set = pinned.unwrap_or_default();
    let mut result: Vec<Value> = vec![];
    if let Some(arr) = catalog.get("providers").and_then(|v| v.as_array()) {
        for p in arr {
            let id = p.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or(id);
            let models: Vec<String> = p.get("models").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            let mut filtered = models.clone();
            if is_pinned {
                filtered = filtered.into_iter().filter(|m| {
                    let r = format!("{}:{}", id, m);
                    pinned_set.contains(&r) || pinned_set.contains(&r.replace("openai-compatible:", "")) || pinned_set.contains(m)
                }).collect();
                if filtered.is_empty() { continue; }
            }
            result.push(json!({"provider": id, "providerName": name, "providerType": id, "hasAPIKey": true, "models": filtered.into_iter().map(|name| json!({"name": name})).collect::<Vec<_>>() }));
        }
    }
    // preferred ordering
    let preferred = std::env::var("AMIRO_DEFAULT_MODEL").unwrap_or_default().trim().replace("openai-compatible:", "");
    if !preferred.is_empty() {
        let pref_provider = preferred.split(':').next().unwrap_or("").to_string();
        if let Some(pos) = result.iter().position(|r| r.get("provider").and_then(|v| v.as_str()) == Some(&pref_provider)) {
            let item = result.remove(pos);
            result.insert(0, item);
        }
    }
    Ok(Json(json!(result)))
}

async fn get_ai_providers(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let catalog = build_catalog(&state).await;
    let providers: Vec<Value> = catalog.get("providers").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    Ok(Json(json!(providers.iter().map(|p| json!({
        "id": p.get("id").cloned().unwrap_or(json!("")),
        "name": p.get("name").cloned().unwrap_or(json!("")),
        "models": p.get("models").cloned().unwrap_or(json!([])),
        "selectedModel": p.get("selectedModel").cloned().unwrap_or(json!("")),
    })).collect::<Vec<_>>())))
}

async fn provider_status(State(_state): State<AppState>) -> Json<Value> {
    Json(json!({"status": "ok"}))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/chat/models", get(get_chat_models))
        .route("/api/ai/providers", get(get_ai_providers))
        .route("/api/ai/providers/status", get(provider_status))
}
