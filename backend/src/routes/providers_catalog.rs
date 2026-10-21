use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::routes::agents::AgentState;
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

fn runtime_command(state: &AppState) -> Command {
    let mut cmd = Command::new(&state.runtime_bin);
    // The engine resolves AMIRO_HOME before AMIRO_RUNTIME_HOME. The backend's
    // own home is a separate store, not the running engine's credential home.
    cmd.env("AMIRO_HOME", &state.runtime_home);
    cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
    cmd.kill_on_drop(true);
    cmd
}

async fn run_cli_json(state: &AppState, args: &[&str]) -> Option<Value> {
    let mut cmd = runtime_command(state);
    cmd.args(args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());

    let output = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await.ok()?.ok()?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str(text.trim()).ok()
    } else {
        None
    }
}

fn accepts_single_api_key(auth_kind: &str, id: &str) -> bool {
    // These CLI commands need region/endpoint/model setup or a device login,
    // rather than the single secret line supported by this HTTP endpoint.
    mechanism_of(auth_kind, id) == "api-key"
        && !matches!(id, "bedrock" | "azure" | "jcode" | "amiro")
}

async fn can_accept_api_key(state: &AppState, provider_id: &str) -> bool {
    for args in [["auth", "status", "--json"], ["provider", "list", "--json"]] {
        if let Some(catalog) = run_cli_json(state, &args).await {
            if let Some(entry) = catalog.get("providers").and_then(Value::as_array)
                .and_then(|entries| entries.iter().find(|entry| {
                    entry.get("id").and_then(Value::as_str) == Some(provider_id)
                })) {
                return accepts_single_api_key(
                    entry.get("auth_kind").and_then(Value::as_str).unwrap_or(""),
                    provider_id,
                );
            }
        }
    }
    false
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

pub async fn catalog_payload(state: &AppState) -> Value {
    let list_json = run_cli_json(state, &["provider", "list", "--json"]).await;
    let auth_json = run_cli_json(state, &["auth", "status", "--json"]).await;

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
                json!(accepts_single_api_key(&auth_kind, &id)),
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
            { "id": "openai-api", "name": "OpenAI", "mechanism": "api-key", "status": "not_configured" },
            { "id": "anthropic-api", "name": "Anthropic", "mechanism": "api-key", "status": "not_configured" },
            { "id": "openrouter", "name": "OpenRouter", "mechanism": "api-key", "status": "not_configured" },
            { "id": "gemini-api", "name": "Google Gemini", "mechanism": "api-key", "status": "not_configured" },
            { "id": "groq", "name": "Groq", "mechanism": "api-key", "status": "not_configured" },
            { "id": "openai-compatible", "name": "OpenAI Compatible", "mechanism": "api-key", "status": "not_configured" }
        ]);
        return json!({ "providers": default_providers });
    }

    json!({ "providers": result_providers })
}

async fn get_provider_catalog(
    AgentState(state): AgentState,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(catalog_payload(&state).await))
}

/// Store one API key in the runtime's credential home (`runtime login`).
/// Shared by the HTTP route and the amiro.toml / .env import at startup.
pub async fn store_api_key(
    state: &AppState,
    provider_id: &str,
    raw_key: &str,
    api_base: &str,
) -> Result<(), ApiError> {
    if provider_id != "openai-compatible" && !api_base.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "apiBase is only supported for openai-compatible".to_string()));
    }
    if !can_accept_api_key(state, provider_id).await {
        return Err(ApiError(StatusCode::BAD_REQUEST, format!(
            "Provider '{provider_id}' does not support single-key setup. Use its OAuth or terminal setup flow."
        )));
    }

    let mut cmd = runtime_command(state);

    if provider_id == "openai-compatible" {
        if api_base.is_empty() {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "apiBase is required for openai-compatible".to_string(),
            ));
        }
        cmd.args([
            "login",
            provider_id,
            "--api-base",
            api_base,
            "--api-key",
            raw_key,
            "--no-validate",
        ]);
        cmd.stdin(Stdio::null());
    } else {
        cmd.args(["login", provider_id, "--no-validate"]);
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

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30), child.wait_with_output()
    ).await.map_err(|_| ApiError(StatusCode::GATEWAY_TIMEOUT, "API key setup timed out".to_string()))?
    .map_err(|e| {
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

    Ok(())
}

async fn post_provider_api_key(
    AgentState(state): AgentState,
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
    if raw_key.contains(['\r', '\n']) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "apiKey must be a single line".to_string()));
    }

    let api_base = body
        .get("apiBase")
        .or_else(|| body.get("baseUrl"))
        .and_then(|b| b.as_str())
        .map(|s| s.trim())
        .unwrap_or("");

    store_api_key(&state, &provider_id, raw_key, api_base).await?;

    Ok(Json(json!({
        "ok": true,
        "provider": provider_id,
        "available": true,
    })))
}

pub async fn remove_api_key(state: &AppState, provider_id: &str) -> Result<Value, ApiError> {
    let provider_id = provider_id.trim().to_lowercase();
    if provider_id.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "provider id required".to_string()));
    }

    let file = env_file_path(state, &provider_id);
    let _ = tokio::fs::remove_file(&file).await;
    let _ = tokio::fs::remove_file(format!("{}.bak", file.to_string_lossy())).await;

    // Removing the key can change the model list (the runtime falls back to
    // its static catalog), so the cached copy must not outlive the change.
    crate::models::invalidate_catalog();

    Ok(json!({
        "ok": true,
        "provider": provider_id,
    }))
}

async fn delete_provider_credentials(
    AgentState(state): AgentState,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    Ok(Json(remove_api_key(&state, &id).await?))
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture(AppState);

    impl Fixture {
        fn new(script: &str) -> Self {
            let root = std::env::temp_dir().join(format!("amiro-provider-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let state = AppState {
                home: root.join("backend"),
                runtime_home: root.join("runtime"),
                runtime_socket: root.join("runtime/api.sock"),
                workspace: root.join("workspace"),
                runtime_bin: root.join("stub-runtime"),
                token: "test-token".to_string(),
                store: Arc::new(tokio::sync::Mutex::new(())),
            };
            std::fs::write(&state.runtime_bin, format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
            std::fs::set_permissions(&state.runtime_bin, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(state)
        }
    }

    use std::sync::Arc;

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.runtime_bin.parent().unwrap());
        }
    }

    fn admin() -> AuthUser {
        AuthUser(json!({ "role": "admin", "id": "admin" }))
    }

    #[tokio::test]
    async fn runtime_commands_use_engine_home_not_backend_home() {
        let fixture = Fixture::new("printf '{\"home\":\"%s\",\"runtimeHome\":\"%s\"}' \"$AMIRO_HOME\" \"$AMIRO_RUNTIME_HOME\"");
        let response = run_cli_json(&fixture.0, &["auth", "status", "--json"]).await.unwrap();
        assert_eq!(response["home"], fixture.0.runtime_home.to_str().unwrap());
        assert_eq!(response["runtimeHome"], fixture.0.runtime_home.to_str().unwrap());
        assert_ne!(fixture.0.home, fixture.0.runtime_home);
    }

    #[test]
    fn single_key_capabilities_exclude_oauth_and_multi_prompt_setup() {
        for id in ["openai-api", "anthropic-api", "gemini-api", "groq", "openai-compatible"] {
            assert!(accepts_single_api_key("API key", id), "{id}");
        }
        for id in ["bedrock", "azure", "amiro", "jcode"] {
            assert!(!accepts_single_api_key("API key", id), "{id}");
        }
        assert!(!accepts_single_api_key("OAuth", "openai"));
        assert!(!accepts_single_api_key("Device code", "copilot"));
    }

    #[tokio::test]
    async fn oauth_key_request_never_invokes_login() {
        let fixture = Fixture::new("test \"$1\" = auth\nprintf '%s' '{\"providers\":[{\"id\":\"openai\",\"auth_kind\":\"OAuth\"}]}'");
        let error = post_provider_api_key(AgentState(fixture.0.clone()), admin(), Path("openai".to_string()), Json(json!({"apiKey":"test-key"}))).await.unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(error.1.contains("single-key setup"));
    }

    #[tokio::test]
    async fn named_compatible_key_is_piped_into_engine_home() {
        let fixture = Fixture::new(r#"if [ "$1" = auth ]; then
printf '%s' '{"providers":[{"id":"groq","auth_kind":"API key"}]}'
else
test "$1" = login
test "$2" = groq
test "$3" = --no-validate
test "$#" = 3
IFS= read -r key
mkdir -p "$AMIRO_HOME/config/jcode"
printf '%s' "$key" > "$AMIRO_HOME/config/jcode/groq.env"
fi"#);
        let response = post_provider_api_key(AgentState(fixture.0.clone()), admin(), Path("groq".to_string()), Json(json!({"apiKey":"test-key"}))).await.unwrap();
        assert_eq!(response.0["ok"], true);
        assert_eq!(std::fs::read_to_string(env_file_path(&fixture.0, "groq")).unwrap(), "test-key");
        assert!(!fixture.0.home.exists());
    }

    #[tokio::test]
    async fn custom_compatible_uses_explicit_key_and_base_flags() {
        let fixture = Fixture::new(r#"if [ "$1" = auth ]; then
printf '%s' '{"providers":[{"id":"openai-compatible","auth_kind":"API key"}]}'
else
test "$1" = login
test "$2" = openai-compatible
test "$3" = --api-base
test "$4" = https://example.test/v1
test "$5" = --api-key
test "$6" = test-key
test "$7" = --no-validate
test "$#" = 7
fi"#);
        let response = post_provider_api_key(AgentState(fixture.0.clone()), admin(), Path("openai-compatible".to_string()), Json(json!({"apiKey":"test-key", "apiBase":"https://example.test/v1"}))).await.unwrap();
        assert_eq!(response.0["ok"], true);
    }

    #[tokio::test]
    async fn fallback_uses_api_key_provider_ids_not_oauth_ids() {
        let fixture = Fixture::new("exit 1");
        let response = get_provider_catalog(AgentState(fixture.0.clone()), admin()).await.unwrap();
        let ids: Vec<&str> = response.0["providers"].as_array().unwrap().iter()
            .filter_map(|entry| entry["id"].as_str()).collect();
        assert!(ids.contains(&"openai-api"));
        assert!(ids.contains(&"gemini-api"));
        assert!(!ids.contains(&"openai"));
        assert!(!ids.contains(&"gemini"));
    }

    #[tokio::test]
    async fn invalid_key_or_ignored_base_is_rejected_before_cli() {
        let fixture = Fixture::new("exit 1");
        for body in [json!({"apiKey":"first\nsecond"}), json!({"apiKey":"first\rsecond"}), json!({"apiKey":"test-key", "apiBase":"https://example.test/v1"})] {
            let error = post_provider_api_key(AgentState(fixture.0.clone()), admin(), Path("groq".to_string()), Json(body)).await.unwrap_err();
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
            assert!(error.1.contains("single line") || error.1.contains("apiBase is only"));
        }
    }
}
