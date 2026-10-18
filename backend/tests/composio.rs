//! End-to-end tests for the Composio routes.
//!
//! A real mock Composio server (axum) runs in-process on an ephemeral port and
//! `AMIRO_COMPOSIO_BASE_URL` points the backend at it, exactly as production
//! would point at `https://backend.composio.dev`. The backend's real router is
//! driven through `tower::ServiceExt::oneshot`, so auth, normalization and the
//! MCP-config side effects are exercised as served.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use axum::body::{to_bytes, Body};
use axum::extract::{Path as AxumPath, State as AxumState};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

const VALID_KEY: &str = "sk-valid-000000001234";
const USER_TOKEN: &str = "tok-composio-user";
const USER_ID: &str = "user-composio-1";
const USER2_TOKEN: &str = "tok-composio-user2";
const USER2_ID: &str = "user-composio-2";
/// A secret a misbehaving upstream might reflect. It must never reach a
/// response body (or a log line).
const UPSTREAM_SECRET: &str = "sentinel-upstream-secret-9d3f";

/// The mock server (and its mutable accounts / feature flags) is shared by the
/// whole test binary, so tests that mutate it hold this lock for their duration.
static MOCK_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ---------------------------------------------------------------------------
// Mock Composio server
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct MockState {
    accounts: Arc<RwLock<Vec<Value>>>,
    tool_router_enabled: Arc<RwLock<bool>>,
    /// When set, `/api/v3/toolkits` answers with this status and body instead of
    /// the catalog. Used to prove an upstream error body is never echoed.
    toolkits_error: Arc<RwLock<Option<(StatusCode, Value)>>>,
}

impl Default for MockState {
    fn default() -> Self {
        Self {
            accounts: Arc::new(RwLock::new(Vec::new())),
            tool_router_enabled: Arc::new(RwLock::new(true)),
            toolkits_error: Arc::new(RwLock::new(None)),
        }
    }
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        == Some(VALID_KEY)
}

fn unauthorized() -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": {"message": "invalid api key"}})),
    )
}

async fn mock_toolkits(
    AxumState(state): AxumState<MockState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return unauthorized();
    }
    if let Some((status, body)) = state.toolkits_error.read().unwrap().clone() {
        return (status, Json(body));
    }
    (
        StatusCode::OK,
        Json(json!({
            "items": [
                {
                    "slug": "github",
                    "name": "GitHub",
                    "meta": {
                        "logo": "https://assets.example/github.png",
                        "description": "Repos and issues",
                        "categories": [{"id": "developer-tools", "name": "Developer Tools"}],
                    },
                    "auth_schemes": ["oauth2"],
                },
                {
                    "slug": "slack",
                    "name": "Slack",
                    "meta": {
                        "logo": "https://assets.example/slack.png",
                        "description": "Team chat",
                        "categories": [{"id": "communication", "name": "Communication"}],
                    },
                    "auth_schemes": ["oauth2", "api_key"],
                }
            ],
            "next_cursor": "cursor-2",
        })),
    )
}

async fn mock_list_accounts(
    AxumState(state): AxumState<MockState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return unauthorized();
    }
    let accounts = state.accounts.read().unwrap().clone();
    (StatusCode::OK, Json(json!({ "items": accounts })))
}

async fn mock_get_account(
    AxumState(state): AxumState<MockState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return unauthorized();
    }
    let found = state
        .accounts
        .read()
        .unwrap()
        .iter()
        .find(|account| account.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .cloned();
    match found {
        Some(account) => (StatusCode::OK, Json(account)),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "not found"}))),
    }
}

async fn mock_delete_account(
    AxumState(state): AxumState<MockState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return unauthorized();
    }
    let before = state.accounts.read().unwrap().len();
    state
        .accounts
        .write()
        .unwrap()
        .retain(|account| account.get("id").and_then(Value::as_str) != Some(id.as_str()));
    let removed = before != state.accounts.read().unwrap().len();
    if removed {
        (StatusCode::OK, Json(json!({"success": true})))
    } else {
        (StatusCode::NOT_FOUND, Json(json!({"error": "not found"})))
    }
}

async fn mock_create_session(
    AxumState(state): AxumState<MockState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return unauthorized();
    }
    // The real v3.1 API rejects `enabled` (plural) with a 400. Mirror that so a
    // regression to the wrong key fails here instead of silently in production.
    let toolkits_ok = body
        .get("toolkits")
        .and_then(|t| t.get("enable"))
        .and_then(Value::as_array)
        .is_some_and(|list| !list.is_empty());
    let manage_ok = body
        .get("manage_connections")
        .map_or(true, |m| m.get("enable").is_some() && m.get("enabled").is_none());
    if !toolkits_ok || !manage_ok {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": {"message": "Validation error", "status": 400}})),
        );
    }
    if !*state.tool_router_enabled.read().unwrap() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "tool router unavailable"})),
        );
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "session_id": "trs_mock_1",
            "mcp": {"type": "http", "url": "https://mock.composio.dev/mcp/trs_mock_1"},
        })),
    )
}

async fn mock_link_session(headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return unauthorized();
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "link_token": "lt_mock",
            "redirect_url": "https://mock.composio.dev/link/lt_mock",
            "connected_account_id": "ca_mock_1",
        })),
    )
}

async fn mock_auth_configs(headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return unauthorized();
    }
    (
        StatusCode::OK,
        Json(json!({ "items": [{"id": "ac_mock_1"}] })),
    )
}

async fn mock_legacy_link(headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !authorized(&headers) {
        return unauthorized();
    }
    (
        StatusCode::CREATED,
        Json(json!({
            "redirect_url": "https://mock.composio.dev/link/lt_legacy",
            "connected_account_id": "ca_legacy_1",
        })),
    )
}

fn mock_router(state: MockState) -> Router {
    Router::new()
        .route("/api/v3/toolkits", get(mock_toolkits))
        .route("/api/v3/connected_accounts", get(mock_list_accounts))
        .route("/api/v3/connected_accounts/link", post(mock_legacy_link))
        .route(
            "/api/v3/connected_accounts/{id}",
            get(mock_get_account).delete(mock_delete_account),
        )
        .route("/api/v3/auth_configs", get(mock_auth_configs))
        .route("/api/v3.1/tool_router/session", post(mock_create_session))
        .route(
            "/api/v3.1/tool_router/session/{id}/link",
            post(mock_link_session),
        )
        .with_state(state)
}

/// One mock server per test binary. Its own OS thread keeps the server runtime
/// alive across every `#[tokio::test]` runtime.
fn mock() -> &'static MockState {
    static MOCK: OnceLock<MockState> = OnceLock::new();
    MOCK.get_or_init(|| {
        let state = MockState::default();
        let server_state = state.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("mock runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind mock server");
                let addr = listener.local_addr().expect("mock addr");
                ready_tx.send(addr).expect("signal mock ready");
                axum::serve(listener, mock_router(server_state))
                    .await
                    .expect("mock server");
            });
        });
        let addr = ready_rx.recv().expect("mock server start");
        std::env::set_var("AMIRO_COMPOSIO_BASE_URL", format!("http://{addr}"));
        // Ensure the env source cannot shadow the UI key under test.
        std::env::remove_var("COMPOSIO_API_KEY");
        state
    })
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

struct Fixture {
    state: AppState,
    root: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn seed(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("amiro-composio-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let runtime_home = root.join("runtime");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&runtime_home).unwrap();

    seed(
        &home.join("users.json"),
        &json!({"users": [
            {"id": USER_ID, "name": "Owner", "role": "admin", "createdAt": now_iso()},
            {"id": USER2_ID, "name": "Member", "role": "user", "createdAt": now_iso()},
        ]}),
    );
    seed(
        &home.join("sessions.json"),
        &json!({"sessions": {
            USER_TOKEN: {"userId": USER_ID, "createdAt": now_iso()},
            USER2_TOKEN: {"userId": USER2_ID, "createdAt": now_iso()},
        }}),
    );

    let state = AppState {
        home,
        runtime_home,
        runtime_socket: root.join("amiro-api.sock"),
        workspace: root.join("workspace"),
        runtime_bin: root.join("amiro-runtime"),
        token: "fixture-sidecar-secret".to_string(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    Fixture { state, root }
}

async fn write_ui_key(fixture: &Fixture, key: &str) {
    backend::composio_config::save_ui_key(&fixture.state, key)
        .await
        .unwrap();
}

async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    call_as(app, USER_TOKEN, method, uri, body).await
}

async fn call_as(
    app: &Router,
    token: &str,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    let request = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap(),
        None => {
            builder = builder.header("content-length", "0");
            builder.body(Body::empty()).unwrap()
        }
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024).await.unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

fn app(fixture: &Fixture) -> Router {
    router().with_state(fixture.state.clone())
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn config_lifecycle_never_leaks_the_key() {
    let _guard = MOCK_LOCK.lock().await;
    let _ = mock();
    let fixture = fixture();
    let app = app(&fixture);

    let (status, body) = call(&app, Method::GET, "/api/composio/config", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"configured": false, "source": null, "apiKeyHint": null}));

    // A key Composio rejects must not be stored.
    let (status, _) = call(
        &app,
        Method::PUT,
        "/api/composio/config",
        Some(json!({"apiKey": "sk-definitely-invalid"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, body) = call(
        &app,
        Method::PUT,
        "/api/composio/config",
        Some(json!({"apiKey": VALID_KEY})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configured"], json!(true));
    assert_eq!(body["source"], json!("ui"));
    assert_eq!(body["apiKeyHint"], json!("••••1234"));
    assert!(!body.to_string().contains(VALID_KEY), "response leaked the key");

    // The key is stored encrypted, owner-only, and never in the legacy file.
    let store_file = backend::composio_config::ui_key_file(&fixture.state);
    #[cfg(unix)]
    assert_eq!(mode_of(&store_file), 0o600);
    let on_disk = String::from_utf8_lossy(&std::fs::read(&store_file).unwrap()).to_string();
    assert!(!on_disk.contains(VALID_KEY), "store file leaked the key");
    assert!(!fixture.state.home.join("store/composio.json").exists());

    let (status, body) = call(&app, Method::GET, "/api/composio/config", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["source"], json!("ui"));
    assert!(!body.to_string().contains(VALID_KEY));

    let (status, body) = call(&app, Method::DELETE, "/api/composio/config", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"configured": false, "source": null, "apiKeyHint": null}));
    // The credential is gone from the encrypted store (the file itself remains).
    assert!(
        backend::credentials::get_plaintext(&fixture.state, "composio", "api_key")
            .await
            .unwrap()
            .is_none()
    );

    // Deleting again is idempotent.
    let (status, _) = call(&app, Method::DELETE, "/api/composio/config", None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn credentials_are_required_on_every_route() {
    let _ = mock();
    let fixture = fixture();
    let app = app(&fixture);
    for (method, uri) in [
        (Method::GET, "/api/composio/config"),
        (Method::GET, "/api/composio/toolkits"),
        (Method::GET, "/api/composio/connections"),
        (Method::POST, "/api/composio/connect"),
        (Method::POST, "/api/composio/sync"),
    ] {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
}

#[tokio::test]
async fn toolkits_join_the_users_connections() {
    let _guard = MOCK_LOCK.lock().await;
    let mock = mock();
    let fixture = fixture();
    write_ui_key(&fixture, VALID_KEY).await;
    let app = app(&fixture);

    *mock.accounts.write().unwrap() = vec![
        json!({"id": "ca_gh", "toolkit": {"slug": "github"}, "status": "ACTIVE", "created_at": "2026-01-01"}),
        json!({"id": "ca_sl", "toolkit": {"slug": "slack"}, "status": "INITIALIZING", "created_at": "2026-01-02"}),
    ];

    let (status, body) = call(&app, Method::GET, "/api/composio/toolkits?search=git", None).await;
    assert_eq!(status, StatusCode::OK);
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(body["nextCursor"], json!("cursor-2"));

    let github = items
        .iter()
        .find(|item| item["slug"] == json!("github"))
        .unwrap();
    assert_eq!(github["name"], json!("GitHub"));
    assert_eq!(github["logo"], json!("https://assets.example/github.png"));
    assert_eq!(github["description"], json!("Repos and issues"));
    assert_eq!(github["categories"], json!(["Developer Tools"]));
    assert_eq!(github["authModes"], json!(["oauth2"]));
    assert_eq!(github["connected"], json!(true));
    assert_eq!(github["connectionId"], json!("ca_gh"));
    assert_eq!(github["connectionStatus"], json!("ACTIVE"));

    let slack = items
        .iter()
        .find(|item| item["slug"] == json!("slack"))
        .unwrap();
    assert_eq!(slack["connected"], json!(false));
    assert_eq!(slack["connectionId"], json!("ca_sl"));
    assert_eq!(slack["connectionStatus"], json!("INITIALIZING"));

    let (status, body) = call(&app, Method::GET, "/api/composio/connections", None).await;
    assert_eq!(status, StatusCode::OK);
    let connections = body["items"].as_array().unwrap();
    assert_eq!(connections.len(), 2);
    assert_eq!(
        connections[0],
        json!({"id": "ca_gh", "toolkit": "github", "status": "ACTIVE", "createdAt": "2026-01-01"})
    );
}

#[tokio::test]
async fn connect_syncs_mcp_config_and_delete_removes_it() {
    let _guard = MOCK_LOCK.lock().await;
    let mock = mock();
    let fixture = fixture();
    write_ui_key(&fixture, VALID_KEY).await;
    let app = app(&fixture);

    // Pre-existing unrelated MCP entry must survive sync.
    let mcp_path = fixture.state.runtime_home.join("mcp.json");
    seed(
        &mcp_path,
        &json!({"servers": {"todoist": {"command": "npx", "args": ["todoist-mcp"]}}}),
    );

    let (status, body) = call(
        &app,
        Method::POST,
        "/api/composio/connect",
        Some(json!({"toolkit": "github", "callbackUrl": "http://localhost/cb"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["redirectUrl"], json!("https://mock.composio.dev/link/lt_mock"));
    assert_eq!(body["connectionId"], json!("ca_mock_1"));

    // Connection becomes ACTIVE; the status poll must trigger a sync.
    mock.accounts.write().unwrap().push(json!({
        "id": "ca_mock_1",
        "toolkit": {"slug": "github"},
        "status": "ACTIVE",
        "created_at": "2026-02-01",
    }));

    let (status, body) = call(
        &app,
        Method::GET,
        "/api/composio/connections/ca_mock_1/status",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], json!("ACTIVE"));
    assert_eq!(body["synced"], json!(true));
    // No runtime socket exists in the fixture, so nothing reloads.
    assert_eq!(body["reloaded"], json!(false));
    assert_eq!(body["reloadedSessions"], json!(0));
    assert_eq!(body["skippedBusy"], json!(0));

    let written: Value =
        serde_json::from_slice(&std::fs::read(&mcp_path).unwrap()).unwrap();
    let entry = &written["servers"]["composio"];
    assert_eq!(entry["type"], json!("streamable-http"));
    assert_eq!(entry["url"], json!("https://mock.composio.dev/mcp/trs_mock_1"));
    assert_eq!(entry["headers"]["x-api-key"], json!("${COMPOSIO_API_KEY}"));
    // The plaintext key is never written into the runtime MCP config.
    let raw = String::from_utf8_lossy(&std::fs::read(&mcp_path).unwrap()).to_string();
    assert!(!raw.contains(VALID_KEY), "mcp.json leaked the key");
    // The unrelated server is preserved and the file stays owner-only.
    assert_eq!(written["servers"]["todoist"]["command"], json!("npx"));
    #[cfg(unix)]
    assert_eq!(mode_of(&mcp_path), 0o600);

    // Explicit sync reports the scoped toolkits.
    let (status, body) = call(&app, Method::POST, "/api/composio/sync", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["synced"], json!(true));
    assert_eq!(body["toolkits"], json!(["github"]));
    assert_eq!(body["reloaded"], json!(false));
    assert_eq!(body["reloadedSessions"], json!(0));
    assert_eq!(body["skippedBusy"], json!(0));

    let (status, body) = call(
        &app,
        Method::DELETE,
        "/api/composio/connections/ca_mock_1",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["success"], json!(true));
    assert_eq!(body["reloaded"], json!(false));
    assert_eq!(body["reloadedSessions"], json!(0));
    assert_eq!(body["skippedBusy"], json!(0));

    let written: Value = serde_json::from_slice(&std::fs::read(&mcp_path).unwrap()).unwrap();
    assert!(written["servers"].get("composio").is_none());
    assert_eq!(written["servers"]["todoist"]["command"], json!("npx"));
}

#[tokio::test]
async fn sync_without_active_connections_removes_the_entry() {
    let _guard = MOCK_LOCK.lock().await;
    let mock = mock();
    let fixture = fixture();
    write_ui_key(&fixture, VALID_KEY).await;
    let app = app(&fixture);
    *mock.accounts.write().unwrap() = Vec::new();

    let mcp_path = fixture.state.runtime_home.join("mcp.json");
    seed(
        &mcp_path,
        &json!({
            "mcpServers": {
                "composio": {"type": "streamable-http", "url": "https://stale"},
                "keep": {"command": "npx", "args": ["keep"]}
            }
        }),
    );

    let (status, body) = call(&app, Method::POST, "/api/composio/sync", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["synced"], json!(true));
    assert_eq!(body["toolkits"], json!([]));

    let written: Value = serde_json::from_slice(&std::fs::read(&mcp_path).unwrap()).unwrap();
    assert!(written["mcpServers"].get("composio").is_none());
    assert_eq!(written["mcpServers"]["keep"]["command"], json!("npx"));
}

#[tokio::test]
async fn connect_falls_back_to_the_legacy_link_endpoint() {
    let _guard = MOCK_LOCK.lock().await;
    let mock = mock();
    *mock.tool_router_enabled.write().unwrap() = false;
    let fixture = fixture();
    write_ui_key(&fixture, VALID_KEY).await;
    let app = app(&fixture);

    let (status, body) = call(
        &app,
        Method::POST,
        "/api/composio/connect",
        Some(json!({"toolkit": "slack"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["redirectUrl"],
        json!("https://mock.composio.dev/link/lt_legacy")
    );
    assert_eq!(body["connectionId"], json!("ca_legacy_1"));

    *mock.tool_router_enabled.write().unwrap() = true;
}

#[tokio::test]
async fn missing_key_is_a_bad_request_not_a_server_error() {
    let _ = mock();
    let fixture = fixture();
    let app = app(&fixture);
    // No UI key, no env key, no TOML key.
    for (method, uri) in [
        (Method::GET, "/api/composio/toolkits"),
        (Method::GET, "/api/composio/connections"),
        (Method::POST, "/api/composio/sync"),
    ] {
        let (status, body) = call(&app, method, uri, Some(json!({}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
        assert!(body["error"].as_str().unwrap().contains("not configured"));
    }
}

#[test]
fn base_url_is_overridable_and_defaults_correctly() {
    assert_eq!(
        backend::composio_config::base_url_from(Some("http://example.test/".into())),
        "http://example.test"
    );
    assert_eq!(
        backend::composio_config::base_url_from(None),
        "https://backend.composio.dev"
    );
    let _ = mock();
    assert!(backend::composio_config::base_url().starts_with("http://127.0.0.1:"));
}

#[tokio::test]
async fn mutating_routes_are_owner_only_but_reads_are_open() {
    let _guard = MOCK_LOCK.lock().await;
    let mock = mock();
    let fixture = fixture();
    write_ui_key(&fixture, VALID_KEY).await;
    let app = app(&fixture);
    *mock.accounts.write().unwrap() = Vec::new();

    // The owner (admin) can read and mutate.
    let (status, body) = call(&app, Method::GET, "/api/composio/config", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configured"], json!(true));

    // A non-admin member is rejected on every mutating route.
    for (method, uri, body) in [
        (
            Method::PUT,
            "/api/composio/config",
            Some(json!({"apiKey": VALID_KEY})),
        ),
        (Method::DELETE, "/api/composio/config", None),
        (
            Method::POST,
            "/api/composio/connect",
            Some(json!({"toolkit": "github"})),
        ),
        (Method::POST, "/api/composio/sync", None),
        (Method::DELETE, "/api/composio/connections/ca_mock_1", None),
    ] {
        let (status, body) = call_as(&app, USER2_TOKEN, method, uri, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
        assert_eq!(body["error"], json!("admin required"), "{uri}");
    }

    // Reads stay available to any authenticated user.
    for uri in [
        "/api/composio/config",
        "/api/composio/toolkits",
        "/api/composio/connections",
    ] {
        let (status, _) = call_as(&app, USER2_TOKEN, Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
    }
}

#[tokio::test]
async fn upstream_error_bodies_never_reach_responses() {
    let _guard = MOCK_LOCK.lock().await;
    let mock = mock();
    let fixture = fixture();
    write_ui_key(&fixture, VALID_KEY).await;
    let app = app(&fixture);

    // An upstream 400 whose body embeds both a sentinel and the real API key.
    let leaked = json!({
        "error": {"message": format!("{UPSTREAM_SECRET} key={VALID_KEY}")},
    });
    *mock.toolkits_error.write().unwrap() = Some((StatusCode::BAD_REQUEST, leaked));

    let (status, body) = call(&app, Method::GET, "/api/composio/toolkits", None).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(
        body["error"],
        json!("Composio rejected toolkits request (HTTP 400)")
    );
    let rendered = body.to_string();
    assert!(!rendered.contains(UPSTREAM_SECRET), "upstream body leaked: {rendered}");
    assert!(!rendered.contains(VALID_KEY), "api key leaked: {rendered}");

    // The config-validation path shares the same guarantee.
    let (status, body) = call(
        &app,
        Method::PUT,
        "/api/composio/config",
        Some(json!({"apiKey": VALID_KEY})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let rendered = body.to_string();
    assert!(!rendered.contains(UPSTREAM_SECRET), "upstream body leaked: {rendered}");
    assert!(!rendered.contains(VALID_KEY), "api key leaked: {rendered}");

    *mock.toolkits_error.write().unwrap() = None;
}
