//! Composio integration routes.
//!
//! Every route is authenticated. Composio's `user_id` is the Amiro user id, so
//! one Amiro account maps to exactly one Composio entity. The API key is only
//! ever read on the server: clients see a last-four hint, never the secret.
//!
//! `POST /api/composio/sync` writes a `composio` entry into the runtime's MCP
//! config (`$AMIRO_RUNTIME_HOME/mcp.json`) carrying the key as an `x-api-key`
//! header, so the file is written atomically with 0600 permissions and the
//! runtime is asked to reload MCP through the supported
//! `RuntimeCommand::McpReload` path. Mutating routes require the owner (admin)
//! role; read routes stay available to any authenticated user.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::composio_config::{self, ApiKey};
use crate::runtime::McpReloadOutcome;
use crate::state::{ApiError, AppState, AuthUser};

const MCP_ENTRY_NAME: &str = "composio";
/// Header value written to `mcp.json`. The runtime expands it from its process
/// environment, so the plaintext key never reaches the file.
const MCP_API_KEY_PLACEHOLDER: &str = "${COMPOSIO_API_KEY}";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

fn user_id_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Mutating Composio routes are owner-only. Amiro is single-owner, so the owner
/// account carries the `admin` role (the same check as `routes/mcp.rs`).
fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "admin required".to_string()));
    }
    Ok(())
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

// ---------------------------------------------------------------------------
// Composio transport
// ---------------------------------------------------------------------------

/// Header Composio uses for project API keys.
fn api_key_header(key: &str) -> (&'static str, String) {
    ("x-api-key", key.to_string())
}

async fn decode(response: reqwest::Response) -> Result<(StatusCode, Value), ApiError> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "invalid Composio response".to_string()))?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, body))
}

async fn composio_get(
    base: &str,
    path: &str,
    key: &str,
    query: &[(&str, String)],
) -> Result<(StatusCode, Value), ApiError> {
    let (name, value) = api_key_header(key);
    let response = http_client()
        .get(format!("{base}{path}"))
        .query(query)
        .header(name, value)
        .send()
        .await
        .map_err(composio_unreachable)?;
    decode(response).await
}

async fn composio_post(
    base: &str,
    path: &str,
    key: &str,
    body: &Value,
) -> Result<(StatusCode, Value), ApiError> {
    let (name, value) = api_key_header(key);
    let response = http_client()
        .post(format!("{base}{path}"))
        .header(name, value)
        .json(body)
        .send()
        .await
        .map_err(composio_unreachable)?;
    decode(response).await
}

async fn composio_delete(
    base: &str,
    path: &str,
    key: &str,
) -> Result<(StatusCode, Value), ApiError> {
    let (name, value) = api_key_header(key);
    let response = http_client()
        .delete(format!("{base}{path}"))
        .header(name, value)
        .send()
        .await
        .map_err(composio_unreachable)?;
    decode(response).await
}

/// Never surface the full request URL: it can carry the API key or user id.
fn composio_unreachable(_error: reqwest::Error) -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "could not reach the Composio API".to_string(),
    )
}

/// Shape an upstream rejection as a fixed, body-free error. Upstream error
/// bodies may carry secrets (including a reflected API key), so they are never
/// echoed into a response or a log line: only the context and HTTP status.
fn composio_rejected(context: &str, status: StatusCode) -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        format!("Composio rejected {context} (HTTP {})", status.as_u16()),
    )
}

// ---------------------------------------------------------------------------
// Payload normalization (tolerant of Composio response-shape drift)
// ---------------------------------------------------------------------------

fn items_of(value: &Value) -> Vec<Value> {
    if let Some(items) = value.get("items").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = value.get("data").and_then(Value::as_array) {
        return items.clone();
    }
    value.as_array().cloned().unwrap_or_default()
}

fn first_str<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
}

fn nested_str<'a>(value: &'a Value, outer: &str, inner: &str) -> Option<&'a str> {
    value
        .get(outer)
        .and_then(|v| v.get(inner))
        .and_then(Value::as_str)
}

fn string_list(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(s) => Some(s.clone()),
                Value::Object(_) => item
                    .get("name")
                    .or_else(|| item.get("id"))
                    .or_else(|| item.get("slug"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn account_toolkit(account: &Value) -> Option<String> {
    if let Some(slug) = nested_str(account, "toolkit", "slug") {
        return Some(slug.to_string());
    }
    if let Some(slug) = account.get("toolkit").and_then(Value::as_str) {
        return Some(slug.to_string());
    }
    first_str(account, &["toolkit_slug", "toolkitSlug"]).map(str::to_string)
}

fn account_status(account: &Value) -> String {
    first_str(account, &["status", "state"])
        .unwrap_or("UNKNOWN")
        .to_uppercase()
}

fn is_active(status: &str) -> bool {
    status.eq_ignore_ascii_case("ACTIVE") || status.eq_ignore_ascii_case("CONNECTED")
}

/// toolkit slug -> (connection id, status), from the user's connected accounts.
fn connection_index(accounts: &[Value]) -> HashMap<String, (String, String)> {
    let mut index: HashMap<String, (String, String)> = HashMap::new();
    for account in accounts {
        let Some(slug) = account_toolkit(account) else {
            continue;
        };
        let id = first_str(account, &["id", "connected_account_id", "nanoid"])
            .unwrap_or("")
            .to_string();
        let status = account_status(account);
        // Prefer an ACTIVE account when several exist for one toolkit; keep the
        // first non-active one otherwise.
        let replace = match index.get(&slug) {
            None => true,
            Some((_, existing)) => !is_active(existing) && is_active(&status),
        };
        if replace {
            index.insert(slug, (id, status));
        }
    }
    index
}

async fn fetch_connections(base: &str, key: &str, uid: &str) -> Result<Vec<Value>, ApiError> {
    let (status, body) = composio_get(
        base,
        "/api/v3/connected_accounts",
        key,
        &[("user_ids", uid.to_string()), ("limit", "100".to_string())],
    )
    .await?;
    if !status.is_success() {
        return Err(composio_rejected("connected accounts request", status));
    }
    Ok(items_of(&body))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn get_config(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let key = composio_config::resolve(&state).await?;
    Ok(Json(composio_config::public_config(key.as_ref())))
}

async fn put_config(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let api_key = body
        .get("apiKey")
        .or_else(|| body.get("api_key"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if api_key.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "apiKey is required".to_string(),
        ));
    }

    // Validate before persisting: a key Composio rejects is not stored.
    let base = composio_config::base_url();
    let (status, response_body) = composio_get(
        &base,
        "/api/v3/toolkits",
        &api_key,
        &[("limit", "1".to_string())],
    )
    .await?;
    if !status.is_success() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("Composio rejected the API key (HTTP {})", status.as_u16()),
        ));
    }
    let _ = response_body;

    composio_config::save_ui_key(&state, &api_key).await?;
    let key = composio_config::resolve(&state).await?;
    Ok(Json(composio_config::public_config(key.as_ref())))
}

async fn delete_config(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    composio_config::remove_ui_key(&state).await?;
    let key = composio_config::resolve(&state).await?;
    Ok(Json(composio_config::public_config(key.as_ref())))
}

async fn require_key(state: &AppState) -> Result<ApiKey, ApiError> {
    composio_config::resolve(state).await?.ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "Composio API key is not configured".to_string(),
        )
    })
}

async fn list_toolkits(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = require_key(&state).await?;
    let base = composio_config::base_url();

    let mut params: Vec<(&str, String)> = Vec::new();
    if let Some(search) = query.get("search").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        params.push(("search", search.to_string()));
    }
    if let Some(cursor) = query.get("cursor").filter(|c| !c.is_empty()) {
        params.push(("cursor", cursor.clone()));
    }
    if let Some(limit) = query.get("limit").filter(|l| !l.is_empty()) {
        params.push(("limit", limit.clone()));
    }
    params.push(("user_id", uid.clone()));

    let (status, body) = composio_get(&base, "/api/v3/toolkits", &key.value, &params).await?;
    if !status.is_success() {
        return Err(composio_rejected("toolkits request", status));
    }

    let connections = fetch_connections(&base, &key.value, &uid).await?;
    let index = connection_index(&connections);

    let items: Vec<Value> = items_of(&body)
        .iter()
        .map(|toolkit| {
            let slug = first_str(toolkit, &["slug", "key", "toolkit_slug"])
                .unwrap_or("")
                .to_string();
            let name = first_str(toolkit, &["name"])
                .map(str::to_string)
                .unwrap_or_else(|| slug.clone());
            let logo = nested_str(toolkit, "meta", "logo")
                .or_else(|| first_str(toolkit, &["logo"]))
                .unwrap_or("")
                .to_string();
            let description = nested_str(toolkit, "meta", "description")
                .or_else(|| first_str(toolkit, &["description"]))
                .unwrap_or("")
                .to_string();
            let categories = toolkit
                .get("meta")
                .and_then(|meta| meta.get("categories"))
                .map(string_list)
                .or_else(|| toolkit.get("categories").map(string_list))
                .unwrap_or_default();
            let auth_modes = ["auth_schemes", "auth_modes", "composio_managed_auth_schemes"]
                .iter()
                .find_map(|field| {
                    let list = string_list(toolkit.get(*field).unwrap_or(&Value::Null));
                    (!list.is_empty()).then_some(list)
                })
                .unwrap_or_default();

            let (connection_id, connection_status) = match index.get(&slug) {
                Some((id, status)) => (json!(id), json!(status)),
                None => (Value::Null, Value::Null),
            };
            let connected = connection_status
                .as_str()
                .is_some_and(is_active);

            json!({
                "slug": slug,
                "name": name,
                "logo": logo,
                "description": description,
                "categories": categories,
                "authModes": auth_modes,
                "connected": connected,
                "connectionId": connection_id,
                "connectionStatus": connection_status,
            })
        })
        .collect();

    let next_cursor = body
        .get("next_cursor")
        .or_else(|| body.get("nextCursor"))
        .and_then(Value::as_str)
        .map(|c| json!(c))
        .unwrap_or(Value::Null);

    Ok(Json(json!({ "items": items, "nextCursor": next_cursor })))
}

async fn list_connections(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = require_key(&state).await?;
    let base = composio_config::base_url();
    let connections = fetch_connections(&base, &key.value, &uid).await?;

    let items: Vec<Value> = connections
        .iter()
        .map(|account| {
            json!({
                "id": first_str(account, &["id", "connected_account_id", "nanoid"]).unwrap_or(""),
                "toolkit": account_toolkit(account).unwrap_or_default(),
                "status": account_status(account),
                "createdAt": first_str(account, &["created_at", "createdAt"]).unwrap_or(""),
            })
        })
        .collect();

    Ok(Json(json!({ "items": items })))
}

/// Create a Tool Router session scoped to exactly `toolkits`.
async fn create_session(
    base: &str,
    key: &str,
    uid: &str,
    toolkits: &[String],
) -> Result<Value, ApiError> {
    let body = json!({
        "user_id": uid,
        // Composio's v3.1 session API spells these keys `enable` (singular).
        // `enabled` is rejected with a 400 validation error.
        "toolkits": { "enable": toolkits },
        "manage_connections": { "enable": false },
    });
    let (status, response) =
        composio_post(base, "/api/v3.1/tool_router/session", key, &body).await?;
    if !status.is_success() {
        return Err(composio_rejected("session creation", status));
    }
    Ok(response)
}

fn session_id_of(session: &Value) -> Option<&str> {
    first_str(session, &["session_id", "id"])
}

async fn connect(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let uid = user_id_of(&user);
    let key = require_key(&state).await?;
    let base = composio_config::base_url();

    let toolkit = body
        .get("toolkit")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if toolkit.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "toolkit is required".to_string(),
        ));
    }
    let callback_url = body
        .get("callbackUrl")
        .or_else(|| body.get("callback_url"))
        .and_then(Value::as_str)
        .map(str::to_string);

    // Primary path: a Tool Router session scoped to this one toolkit, then a
    // link session for it.
    match tool_router_connect(&base, &key.value, &uid, &toolkit, callback_url.as_deref()).await {
        Ok(result) => Ok(Json(result)),
        Err(primary_error) => {
            match legacy_connect(&base, &key.value, &uid, &toolkit, callback_url.as_deref()).await {
                Ok(result) => Ok(Json(result)),
                Err(_) => Err(primary_error),
            }
        }
    }
}

async fn tool_router_connect(
    base: &str,
    key: &str,
    uid: &str,
    toolkit: &str,
    callback_url: Option<&str>,
) -> Result<Value, ApiError> {
    let session = create_session(base, key, uid, &[toolkit.to_string()]).await?;
    let session_id = session_id_of(&session)
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "Composio session response had no session_id".to_string(),
            )
        })?
        .to_string();

    let mut link_body = json!({ "toolkit": toolkit });
    if let Some(callback) = callback_url {
        link_body["callback_url"] = json!(callback);
    }
    let path = format!("/api/v3.1/tool_router/session/{session_id}/link");
    let (status, response) = composio_post(base, &path, key, &link_body).await?;
    if !status.is_success() {
        return Err(composio_rejected("link session request", status));
    }
    Ok(json!({
        "redirectUrl": first_str(&response, &["redirect_url", "redirectUrl"]).unwrap_or(""),
        "connectionId": first_str(&response, &["connected_account_id", "connection_id", "id"]).unwrap_or(""),
    }))
}

/// Fallback: the v3 connected-accounts link endpoint, which needs an auth
/// config id. The id is discovered from the toolkit's auth configs.
async fn legacy_connect(
    base: &str,
    key: &str,
    uid: &str,
    toolkit: &str,
    callback_url: Option<&str>,
) -> Result<Value, ApiError> {
    let (status, response) = composio_get(
        base,
        "/api/v3/auth_configs",
        key,
        &[
            ("toolkit_slug", toolkit.to_string()),
            ("limit", "1".to_string()),
        ],
    )
    .await?;
    if !status.is_success() {
        return Err(composio_rejected("auth config request", status));
    }
    let auth_config_id = items_of(&response)
        .first()
        .and_then(|config| first_str(config, &["id", "auth_config_id"]))
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "no Composio auth config found for this toolkit".to_string(),
            )
        })?;

    let mut body = json!({ "auth_config_id": auth_config_id, "user_id": uid });
    if let Some(callback) = callback_url {
        body["callback_url"] = json!(callback);
    }
    let (status, response) =
        composio_post(base, "/api/v3/connected_accounts/link", key, &body).await?;
    if !status.is_success() {
        return Err(composio_rejected("link request", status));
    }
    Ok(json!({
        "redirectUrl": first_str(&response, &["redirect_url", "redirectUrl"]).unwrap_or(""),
        "connectionId": first_str(&response, &["connected_account_id", "connection_id", "id"]).unwrap_or(""),
    }))
}

async fn delete_connection(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let uid = user_id_of(&user);
    let key = require_key(&state).await?;
    let base = composio_config::base_url();

    let (status, _body) =
        composio_delete(&base, &format!("/api/v3/connected_accounts/{id}"), &key.value).await?;
    if !status.is_success() && status != StatusCode::NOT_FOUND {
        return Err(composio_rejected("connection delete", status));
    }

    let (synced, reload) = sync_state(&state, &base, &key.value, &uid)
        .await
        .unwrap_or((false, McpReloadOutcome::default()));
    Ok(Json(json!({
        "success": true,
        "synced": synced,
        "reloaded": reload.reloaded(),
        "reloadedSessions": reload.reloaded_sessions,
        "skippedBusy": reload.skipped_busy,
    })))
}

async fn connection_status(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let key = require_key(&state).await?;
    let base = composio_config::base_url();

    let (status, body) = composio_get(
        &base,
        &format!("/api/v3/connected_accounts/{id}"),
        &key.value,
        &[],
    )
    .await?;
    if !status.is_success() {
        return Err(composio_rejected("connection status request", status));
    }

    let account = body.get("item").unwrap_or(&body);
    let connection_status = account_status(account);

    let mut synced = false;
    let mut reload = McpReloadOutcome::default();
    if is_active(&connection_status) {
        if let Ok((did_sync, outcome)) = sync_state(&state, &base, &key.value, &uid).await {
            synced = did_sync;
            reload = outcome;
        }
    }

    Ok(Json(json!({
        "id": id,
        "status": connection_status,
        "synced": synced,
        "reloaded": reload.reloaded(),
        "reloadedSessions": reload.reloaded_sessions,
        "skippedBusy": reload.skipped_busy,
    })))
}

async fn sync(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let uid = user_id_of(&user);
    let key = require_key(&state).await?;
    let base = composio_config::base_url();
    let (toolkits, reload) = sync_state_detailed(&state, &base, &key.value, &uid).await?;
    Ok(Json(json!({
        "synced": true,
        "toolkits": toolkits,
        "reloaded": reload.reloaded(),
        "reloadedSessions": reload.reloaded_sessions,
        "skippedBusy": reload.skipped_busy,
    })))
}

// ---------------------------------------------------------------------------
// MCP config sync
// ---------------------------------------------------------------------------

/// Best-effort sync used by connect/status/delete: never fails the caller.
async fn sync_state(
    state: &AppState,
    base: &str,
    key: &str,
    uid: &str,
) -> Result<(bool, McpReloadOutcome), ApiError> {
    let (toolkits, reload) = sync_state_detailed(state, base, key, uid).await?;
    Ok((!toolkits.is_empty(), reload))
}

/// Rebuild the `composio` MCP entry from the user's ACTIVE connections.
/// Returns the toolkits wired into the session and the reload outcome across
/// the runtime's idle sessions.
async fn sync_state_detailed(
    state: &AppState,
    base: &str,
    key: &str,
    uid: &str,
) -> Result<(Vec<String>, McpReloadOutcome), ApiError> {
    let connections = fetch_connections(base, key, uid).await?;
    let mut toolkits: Vec<String> = Vec::new();
    for connection in &connections {
        if !is_active(&account_status(connection)) {
            continue;
        }
        if let Some(slug) = account_toolkit(connection) {
            if !toolkits.iter().any(|existing| existing == &slug) {
                toolkits.push(slug);
            }
        }
    }

    if toolkits.is_empty() {
        write_mcp_entry(state, None).await?;
        return Ok((Vec::new(), crate::runtime::reload_mcp_idle_sessions(state).await));
    }

    let session = create_session(base, key, uid, &toolkits).await?;
    let mcp_url = session
        .get("mcp")
        .and_then(|mcp| first_str(mcp, &["url", "endpoint"]))
        .or_else(|| first_str(&session, &["mcp_url"]))
        .map(str::to_string)
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "Composio session response had no MCP url".to_string(),
            )
        })?;

    let entry = json!({
        "type": "streamable-http",
        "url": mcp_url,
        // Never persist the plaintext key here: the runtime expands this from
        // its own environment (COMPOSIO_API_KEY), which the backend supplies to
        // every runtime it starts. See `runtime_env`.
        "headers": { "x-api-key": MCP_API_KEY_PLACEHOLDER },
        "shared": true,
    });
    write_mcp_entry(state, Some(&entry)).await?;
    Ok((toolkits, crate::runtime::reload_mcp_idle_sessions(state).await))
}

/// Insert (`Some`) or remove (`None`) the `composio` server, preserving every
/// other entry and top-level key. Shared with the Connectors API.
async fn write_mcp_entry(state: &AppState, entry: Option<&Value>) -> Result<bool, ApiError> {
    super::connectors::write_mcp_entry_named(state, MCP_ENTRY_NAME, entry).await
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/composio/config",
            get(get_config).put(put_config).delete(delete_config),
        )
        .route("/api/composio/toolkits", get(list_toolkits))
        .route("/api/composio/connections", get(list_connections))
        .route(
            "/api/composio/connections/{id}",
            axum::routing::delete(delete_connection),
        )
        .route(
            "/api/composio/connections/{id}/status",
            get(connection_status),
        )
        .route("/api/composio/connect", post(connect))
        .route("/api/composio/sync", post(sync))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_index_prefers_active_accounts() {
        let accounts = vec![
            json!({"id": "a", "toolkit": {"slug": "github"}, "status": "INITIALIZING"}),
            json!({"id": "b", "toolkit": {"slug": "github"}, "status": "ACTIVE"}),
            json!({"id": "c", "toolkit": "slack", "status": "ACTIVE"}),
        ];
        let index = connection_index(&accounts);
        assert_eq!(index.get("github").map(|(id, _)| id.as_str()), Some("b"));
        assert_eq!(index.get("slack").map(|(_, s)| s.as_str()), Some("ACTIVE"));
    }

    #[test]
    fn items_of_accepts_common_shapes() {
        assert_eq!(items_of(&json!({"items": [1, 2]})).len(), 2);
        assert_eq!(items_of(&json!({"data": [1]})).len(), 1);
        assert_eq!(items_of(&json!([1, 2, 3])).len(), 3);
        assert_eq!(items_of(&json!({"nope": 1})).len(), 0);
    }

    #[test]
    fn rejections_name_only_the_context_and_status() {
        let error = composio_rejected("toolkits request", StatusCode::BAD_REQUEST);
        assert_eq!(error.0, StatusCode::BAD_GATEWAY);
        assert_eq!(error.1, "Composio rejected toolkits request (HTTP 400)");
        // No upstream body is ever accepted, so nothing can be echoed.
        assert!(!error.1.contains("sk-"));
    }

    #[test]
    fn status_normalization_is_case_insensitive() {
        assert!(is_active("active"));
        assert!(is_active("ACTIVE"));
        assert!(!is_active("FAILED"));
    }
}
