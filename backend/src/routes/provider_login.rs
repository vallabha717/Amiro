use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::state::{ApiError, AppState, AuthUser};

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    Ok(())
}

fn user_id_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn completion_flag(provider: &str, input: &str) -> &'static str {
    if matches!(provider, "openai" | "antigravity" | "google")
        || (provider == "claude" && (input.contains("://") || input.starts_with('?')))
    {
        "--callback-url"
    } else {
        "--auth-code"
    }
}

fn completion_error(provider: &str, stderr: &str) -> String {
    if provider == "openai" && stderr.contains("error sending request")
        && stderr.contains("auth.openai.com/oauth/token")
    {
        return "This server could not establish a connection to OpenAI's OAuth token endpoint. Check the server's outbound network access and configured proxy. A manual callback cannot fix this network failure. Once connectivity is restored, start a new login flow.".into();
    }
    if stderr.trim().is_empty() { "Failed to complete login".into() }
    else { stderr.trim().into() }
}

/// Static fallback only: used when the live engine catalog cannot be read.
/// The live check in `can_start_oauth_flow` consults `auth status --json` so
/// new engine OAuth providers work without editing this file.
const FALLBACK_OAUTH_PROVIDERS: &[&str] = &[
    "claude",
    "openai",
    "gemini",
    "antigravity",
    "copilot",
    "google",
];

/// True when the provider's live engine entry can start an OAuth/device flow.
/// Unknown ids return false; when the engine CLI is unreadable we fall back to
/// the static set above so a transient failure cannot lock out logins.
async fn can_start_oauth_flow(state: &AppState, provider: &str) -> bool {
    let mut cmd = Command::new(&state.runtime_bin);
    cmd.kill_on_drop(true);
    cmd.args(["auth", "status", "--json"]);
    cmd.env("AMIRO_HOME", &state.runtime_home);
    cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = match cmd.output().await {
        Ok(o) if o.status.success() => o,
        _ => return FALLBACK_OAUTH_PROVIDERS.contains(&provider),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = match serde_json::from_str(text.trim()) {
        Ok(v) => v,
        Err(_) => return FALLBACK_OAUTH_PROVIDERS.contains(&provider),
    };
    let empty = Vec::new();
    let providers = parsed
        .get("providers")
        .and_then(|p| p.as_array())
        .unwrap_or(&empty);
    match providers.iter().find(|p| {
        p.get("id")
            .and_then(|i| i.as_str())
            .map(|s| s.eq_ignore_ascii_case(provider))
            .unwrap_or(false)
    }) {
        Some(entry) => {
            let kind = entry
                .get("auth_kind")
                .and_then(|k| k.as_str())
                .unwrap_or("")
                .to_lowercase();
            kind.contains("oauth") || kind.contains("device")
        }
        None => false,
    }
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
struct FlowRecord {
    flow_id: String,
    provider: String,
    flow: String,
    auth_url: String,
    user_code: Option<String>,
    verification_uri: Option<String>,
    interval: Option<u64>,
    expires_at_ms: u64,
    status: String,
    error: Option<String>,
    poll_task: Option<tokio::task::AbortHandle>,
}

type FlowStore = Arc<Mutex<HashMap<String, FlowRecord>>>;

fn get_flow_store() -> FlowStore {
    use std::sync::OnceLock;
    static STORE: OnceLock<FlowStore> = OnceLock::new();
    STORE
        .get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
        .clone()
}

async fn post_oauth_start(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let provider = id.trim().to_lowercase();
    if !can_start_oauth_flow(&state, &provider).await {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("Interactive OAuth is not supported for provider '{provider}'. Please configure with an API key."),
        ));
    }

    let flow_id = Uuid::new_v4().to_string().replace('-', "");
    let mut cmd = Command::new(&state.runtime_bin);
    cmd.kill_on_drop(true);
    cmd.args([
        "login",
        &provider,
        "--print-auth-url",
        "--json",
        "--flow-id",
        &flow_id,
    ]);
    cmd.env("AMIRO_HOME", &state.runtime_home);
    cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = tokio::time::timeout(std::time::Duration::from_secs(45), cmd.output()).await
        .map_err(|_| ApiError(StatusCode::GATEWAY_TIMEOUT, "Provider login start timed out".into()))?
        .map_err(|e| {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    if !output.status.success() {
        let err_text = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            if err_text.trim().is_empty() {
                "Failed to start login flow".to_string()
            } else {
                err_text.trim().to_string()
            },
        ));
    }

    let out_text = String::from_utf8_lossy(&output.stdout);
    let parsed: Value = serde_json::from_str(out_text.trim()).map_err(|e| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to parse login response: {e}"),
        )
    })?;

    let auth_url = parsed
        .get("auth_url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Invalid login response from CLI: missing auth_url".to_string(),
            )
        })?
        .to_string();

    let user_code = parsed
        .get("user_code")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string());
    let is_device = provider == "copilot" || user_code.is_some();

    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let expires_at_ms = parsed
        .get("expires_at_ms")
        .and_then(|e| e.as_u64())
        .unwrap_or(now_ms + 15 * 60 * 1000);
    let expires_in = if expires_at_ms > now_ms {
        (expires_at_ms - now_ms) / 1000
    } else {
        0
    };

    let flow_record = FlowRecord {
        flow_id: flow_id.clone(),
        provider: provider.clone(),
        flow: if is_device { "device_code".to_string() } else { "authorization_code".to_string() },
        auth_url: auth_url.clone(),
        user_code: user_code.clone(),
        verification_uri: if is_device { Some(auth_url.clone()) } else { None },
        interval: if is_device { Some(5) } else { None },
        expires_at_ms,
        status: "pending".to_string(),
        error: None,
        poll_task: None,
    };

    let uid = user_id_of(&user);
    let store = get_flow_store();
    let mut lock = store.lock().await;
    if let Some(previous) = lock.insert(format!("{uid}:{provider}"), flow_record.clone()) {
        if let Some(task) = previous.poll_task { task.abort(); }
    }
    drop(lock);
    if is_device {
        let state = state.clone();
        let key = format!("{uid}:{provider}");
        let provider = provider.clone();
        let flow_id = flow_id.clone();
        let poll_key = key.clone();
        let poll_store = store.clone();
        let task = tokio::spawn(async move {
            let mut cmd = Command::new(&state.runtime_bin);
            cmd.args(["login", &provider, "--complete", "--json", "--flow-id", &flow_id]);
            cmd.env("AMIRO_HOME", &state.runtime_home);
            cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
            cmd.kill_on_drop(true);
            let remaining = expires_at_ms.saturating_sub(chrono::Utc::now().timestamp_millis() as u64);
            let output = tokio::time::timeout(std::time::Duration::from_millis(remaining), cmd.output()).await;
            let mut lock = store.lock().await;
            if let Some(flow) = lock.get_mut(&key).filter(|f| f.flow_id == flow_id) {
                match output {
                    Ok(Ok(output)) if output.status.success() => {
                        flow.status = "authorized".into();
                        crate::models::invalidate_catalog();
                    }
                    Err(_) => flow.status = "expired".into(),
                    _ => {
                        flow.status = "error".into();
                        flow.error = Some("Device authorization failed. Start login again.".into());
                    }
                }
            }
        });
        let mut poll_lock = poll_store.lock().await;
        if let Some(flow) = poll_lock.get_mut(&poll_key) {
            flow.poll_task = Some(task.abort_handle());
        }
    }

    Ok(Json(json!({
        "flow": flow_record.flow,
        "authorizationUrl": flow_record.auth_url,
        "userCode": flow_record.user_code,
        "verificationUri": flow_record.verification_uri,
        "interval": flow_record.interval,
        "expiresIn": expires_in,
        "flowId": flow_id,
    })))
}

async fn get_oauth_status(
    _state: State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let provider = id.trim().to_lowercase();
    let uid = user_id_of(&user);
    let store = get_flow_store();
    let mut lock = store.lock().await;

    let flow = lock.get_mut(&format!("{uid}:{provider}")).ok_or_else(|| {
        ApiError(StatusCode::NOT_FOUND, "no active login flow".to_string())
    })?;
    if flow.status == "pending" && flow.expires_at_ms <= chrono::Utc::now().timestamp_millis() as u64 {
        flow.status = "expired".into();
    }

    Ok(Json(json!({
        "status": flow.status,
        "error": flow.error,
    })))
}

async fn post_oauth_callback(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let provider = id.trim().to_lowercase();
    let uid = user_id_of(&user);
    let store = get_flow_store();
    let flow_opt = {
        let lock = store.lock().await;
        lock.get(&format!("{uid}:{provider}")).cloned()
    };

    let flow = flow_opt.as_ref().ok_or_else(|| ApiError(
        StatusCode::BAD_REQUEST, "No active login flow. Start login again.".to_string(),
    ))?;
    if flow.expires_at_ms <= chrono::Utc::now().timestamp_millis() as u64 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Login flow expired. Start login again.".to_string()));
    }

    let flow_id = body
        .get("flowId")
        .and_then(|f| f.as_str())
        .or_else(|| flow_opt.as_ref().map(|f| f.flow_id.as_str()))
        .unwrap_or("");
    if flow_id != flow.flow_id {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Login flow does not match this account.".to_string()));
    }
    if flow.flow == "device_code" {
        return Ok(Json(json!({"status": flow.status, "provider": provider})));
    }

    let code = body
        .get("code")
        .or_else(|| body.get("callbackUrl"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim();

    if code.is_empty() && flow.flow != "device_code" {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Authorization code or callback URL is required".to_string(),
        ));
    }

    let mut cmd = Command::new(&state.runtime_bin);
    cmd.kill_on_drop(true);
    cmd.args(["login", &provider, "--json", "--flow-id", flow_id]);
    cmd.args([completion_flag(&provider, code), code]);
    cmd.env("AMIRO_HOME", &state.runtime_home);
    cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = tokio::time::timeout(std::time::Duration::from_secs(90), cmd.output()).await
        .map_err(|_| ApiError(StatusCode::GATEWAY_TIMEOUT, "Provider login completion timed out. Try again.".into()))?
        .map_err(|e| {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    if !output.status.success() {
        let err_text = String::from_utf8_lossy(&output.stderr);
        let msg = completion_error(&provider, &err_text);
        return Err(ApiError(StatusCode::BAD_REQUEST, msg));
    }

    let mut lock = store.lock().await;
    if let Some(f) = lock.get_mut(&format!("{uid}:{provider}")) {
        f.status = "authorized".to_string();
        f.error = None;
    }

    // A provider that just finished logging in is connected with a fresh
    // catalog; drop the cached one so its models appear on the next read
    // instead of after the catalog's TTL.
    crate::models::invalidate_catalog();

    Ok(Json(json!({ "ok": true, "provider": provider })))
}

async fn cancel_oauth(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;

    let provider = id.trim().to_lowercase();
    let uid = user_id_of(&user);
    let store = get_flow_store();
    let mut lock = store.lock().await;

    if let Some(flow) = lock.remove(&format!("{uid}:{provider}")) {
        if let Some(task) = flow.poll_task { task.abort(); }
        let mut cmd = Command::new(&state.runtime_bin);
        cmd.args(["login", &provider, "--cancel", "--flow-id", &flow.flow_id]);
        cmd.env("AMIRO_HOME", &state.runtime_home);
        cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
        let _ = cmd.output().await;
    }

    Ok(Json(json!({ "success": true })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers/{id}/oauth/start", post(post_oauth_start))
        .route("/api/providers/{id}/oauth/status", get(get_oauth_status))
        .route(
            "/api/providers/{id}/oauth/callback",
            post(post_oauth_callback),
        )
        .route(
            "/api/providers/{id}/oauth",
            delete(cancel_oauth),
        )
        .route(
            "/api/providers/{id}/oauth/cancel",
            post(cancel_oauth),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_uses_supported_runtime_flags() {
        assert_eq!(completion_flag("claude", "authorization-code"), "--auth-code");
        assert_eq!(completion_flag("claude", "https://example.com/?code=x"), "--callback-url");
        assert_eq!(completion_flag("gemini", "authorization-code"), "--auth-code");
        for provider in ["openai", "antigravity", "google"] {
            assert_eq!(completion_flag(provider, "?code=x&state=y"), "--callback-url");
        }
    }

    #[test]
    fn openai_transport_error_explains_server_network_boundary() {
        let message = completion_error("openai", "error sending request for url (https://auth.openai.com/oauth/token)");
        assert!(message.contains("outbound network"));
        assert!(message.contains("manual callback cannot fix"));
        assert_eq!(completion_error("openai", "OAuth state mismatch"), "OAuth state mismatch");
    }
}
