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

const SUPPORTED_OAUTH_PROVIDERS: &[&str] = &[
    "claude",
    "openai",
    "gemini",
    "antigravity",
    "copilot",
    "google",
];

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
    if !SUPPORTED_OAUTH_PROVIDERS.contains(&provider.as_str()) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("Interactive OAuth is not supported for provider '{provider}'. Please configure with an API key."),
        ));
    }

    let flow_id = Uuid::new_v4().to_string().replace('-', "");
    let mut cmd = Command::new(&state.runtime_bin);
    cmd.args([
        "login",
        &provider,
        "--print-auth-url",
        "--json",
        "--flow-id",
        &flow_id,
    ]);
    cmd.env("AMIRO_HOME", &state.home);
    cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd.output().await.map_err(|e| {
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
    };

    let uid = user_id_of(&user);
    let store = get_flow_store();
    let mut lock = store.lock().await;
    lock.insert(format!("{uid}:{provider}"), flow_record.clone());

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
    let lock = store.lock().await;

    let flow = lock.get(&format!("{uid}:{provider}")).ok_or_else(|| {
        ApiError(StatusCode::NOT_FOUND, "no active login flow".to_string())
    })?;

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

    let flow_id = body
        .get("flowId")
        .and_then(|f| f.as_str())
        .or_else(|| flow_opt.as_ref().map(|f| f.flow_id.as_str()))
        .unwrap_or("");

    let code = body
        .get("code")
        .or_else(|| body.get("callbackUrl"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim();

    if code.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Authorization code or callback URL is required".to_string(),
        ));
    }

    let mut cmd = Command::new(&state.runtime_bin);
    cmd.args(["login", &provider, "--code", code, "--flow-id", flow_id]);
    cmd.env("AMIRO_HOME", &state.home);
    cmd.env("AMIRO_RUNTIME_HOME", &state.runtime_home);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd.output().await.map_err(|e| {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    })?;

    if !output.status.success() {
        let err_text = String::from_utf8_lossy(&output.stderr);
        let msg = if err_text.trim().is_empty() {
            "Failed to complete login".to_string()
        } else {
            err_text.trim().to_string()
        };
        return Err(ApiError(StatusCode::BAD_REQUEST, msg));
    }

    let mut lock = store.lock().await;
    if let Some(f) = lock.get_mut(&format!("{uid}:{provider}")) {
        f.status = "authorized".to_string();
        f.error = None;
    }

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
        let mut cmd = Command::new(&state.runtime_bin);
        cmd.args(["login", &provider, "--cancel", "--flow-id", &flow.flow_id]);
        cmd.env("AMIRO_HOME", &state.home);
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
