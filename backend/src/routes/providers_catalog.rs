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

/// Map the engine's `auth_kind` to the machine `mechanism` the web UI groups
/// by. Mirrors `normalizeMechanism` in adapter/src/providers.mjs: the catalog
/// route must emit `mechanism` (plus the capability flags below) or the
/// frontend cannot parse the catalog and the providers page renders empty.
fn mechanism_of(auth_kind: &str, id: &str) -> &'static str {
    if id.eq_ignore_ascii_case("auto") {
        return "automatic";
    }
    let key = auth_kind.trim().to_lowercase();
    match key.as_str() {
        "oauth" => "oauth",
        "api key" => "api-key",
        "device code" => "device-code",
        "cli" => "cli",
        "api key / cli" => "api-key",
        "local endpoint" => "local-endpoint",
        _ => {
            if key.contains("oauth") {
                "oauth"
            } else if key.contains("device") {
                "device-code"
            } else if key.contains("local") {
                "local-endpoint"
            } else if key.contains("api key") {
                "api-key"
            } else if key == "cli" {
                "cli"
            } else {
                "unknown"
            }
        }
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

    // Full jcode-supported catalog is the UNION of both engine sources:
    // `auth status --json` is the superset carrying connection state,
    // `provider list --json` contributes SKU-only entries (e.g. `auto`,
    // `google`) plus display detail. Iterating only one side drops providers.
    let mut result_providers = Vec::new();
    for a in auth_list {
        let id = a.get("id").and_then(|i| i.as_str()).unwrap_or("");
        if id.is_empty()
            || result_providers.iter().any(|p: &Value| {
                p.get("id").and_then(|i| i.as_str()) == Some(id)
            })
        {
            continue;
        }
        result_providers.push(a.clone());
    }
    for p in providers_list {
        let id = p.get("id").and_then(|i| i.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let auth_entry = auth_list
            .iter()
            .find(|a| a.get("id").and_then(|i| i.as_str()) == Some(id));

        if auth_entry.is_some() {
            // Already pushed from the auth side above; merge display detail.
            if let Some(existing) = result_providers.iter_mut().find(|e| {
                e.get("id").and_then(|i| i.as_str()) == Some(id)
            }) {
                if let (Some(e), Some(src)) =
                    (existing.as_object_mut(), p.as_object())
                {
                    for (k, v) in src {
                        if k == "detail" || k == "aliases" || k == "display_name" {
                            e.entry(k.clone()).or_insert(v.clone());
                        }
                    }
                }
            }
            continue;
        }

        let mut item = p.clone();
        if let Some(obj) = item.as_object_mut() {
            obj.insert("status".to_string(), json!("not_configured"));
        }
        result_providers.push(item);
    }

    // The web UI parses the catalog by `mechanism` and reads the capability
    // flags, so every entry carries them. Without `mechanism` the frontend
    // rejects the whole catalog and the providers page renders empty.
    for item in &mut result_providers {
        if let Some(obj) = item.as_object_mut() {
            let id = obj
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            let auth_kind = obj
                .get("auth_kind")
                .and_then(|k| k.as_str())
                .unwrap_or("")
                .to_string();
            let mechanism = mechanism_of(&auth_kind, &id);
            obj.insert("mechanism".to_string(), json!(mechanism));
            obj.insert(
                "canStartOauth".to_string(),
                json!(mechanism == "oauth" || mechanism == "device-code"),
            );
            obj.insert(
                "canAcceptApiKey".to_string(),
                json!(mechanism == "api-key"),
            );
            let status = obj
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_lowercase();
            obj.insert(
                "connected".to_string(),
                json!(status == "available" || status == "configured"),
            );
        }
    }

    if result_providers.is_empty() {
        // Fallback standard catalog if CLI didn't respond
        let default_providers = json!([
            { "id": "openai", "name": "OpenAI", "mechanism": "api-key", "status": "not_configured" },
            { "id": "anthropic-api", "name": "Anthropic", "mechanism": "api-key", "status": "not_configured" },
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

    // The provider is connected from here on, with whatever catalog the
    // runtime already has for it: drop Amiro's cached copy so its models show
    // up immediately instead of after the catalog's TTL.
    crate::models::invalidate_catalog();

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

    // Removing the key can change the model list (the runtime falls back to
    // its static catalog), so the cached copy must not outlive the change.
    crate::models::invalidate_catalog();

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
