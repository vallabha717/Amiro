//! End-to-end tests for the credential-store routes.
//!
//! A real (tiny) mock Composio server runs in-process so the `validate` route is
//! exercised as served. The real router is driven through
//! `tower::ServiceExt::oneshot`, so auth, the admin gate, and the metadata-only
//! contract are all covered. Every response body is serialized and asserted to be
//! free of the secret, and the on-disk store is asserted to be free of plaintext.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

const SECRET: &str = "sk-credential-secret-7788";
const ADMIN_TOKEN: &str = "tok-cred-admin";
const USER_TOKEN: &str = "tok-cred-user";
const ADMIN_ID: &str = "user-cred-admin";
const USER_ID: &str = "user-cred-user";

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Mock Composio server
// ---------------------------------------------------------------------------

async fn mock_toolkits(headers: HeaderMap) -> (StatusCode, Json<Value>) {
    let valid = headers.get("x-api-key").and_then(|v| v.to_str().ok()) == Some(SECRET);
    if valid {
        (StatusCode::OK, Json(json!({ "items": [] })))
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": { "message": "invalid api key" } })),
        )
    }
}

/// One mock server for the binary; also points the backend base URL at it.
fn mock() -> &'static str {
    static BASE: OnceLock<String> = OnceLock::new();
    BASE.get_or_init(|| {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("mock runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind mock server");
                let addr = listener.local_addr().expect("mock addr");
                ready_tx.send(addr).expect("signal ready");
                let app = Router::new().route("/api/v3/toolkits", get(mock_toolkits));
                axum::serve(listener, app).await.expect("mock server");
            });
        });
        let addr = ready_rx.recv().expect("mock server start");
        let base = format!("http://{addr}");
        std::env::set_var("AMIRO_COMPOSIO_BASE_URL", &base);
        base
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

fn seed(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("amiro-credentials-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let runtime_home = root.join("runtime");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&runtime_home).unwrap();

    seed(
        &home.join("users.json"),
        &json!({"users": [
            {"id": ADMIN_ID, "name": "Admin", "role": "admin", "createdAt": now_iso()},
            {"id": USER_ID, "name": "User", "role": "user", "createdAt": now_iso()},
        ]}),
    );
    seed(
        &home.join("sessions.json"),
        &json!({"sessions": {
            ADMIN_TOKEN: {"userId": ADMIN_ID, "createdAt": now_iso()},
            USER_TOKEN: {"userId": USER_ID, "createdAt": now_iso()},
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

fn app(fixture: &Fixture) -> Router {
    router().with_state(fixture.state.clone())
}

async fn call_with(
    app: &Router,
    token: Option<&str>,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
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
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

async fn call(app: &Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    call_with(app, Some(ADMIN_TOKEN), method, uri, body).await
}

fn assert_no_secret(body: &Value) {
    assert!(
        !body.to_string().contains(SECRET),
        "response leaked the secret: {body}"
    );
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
async fn every_route_requires_authentication() {
    let fixture = fixture();
    let app = app(&fixture);
    for (method, uri) in [
        (Method::GET, "/api/credentials"),
        (Method::POST, "/api/credentials/validate"),
    ] {
        let (status, _) = call_with(&app, None, method, uri, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    let (status, _) = call_with(
        &app,
        None,
        Method::PUT,
        "/api/credentials",
        Some(json!({"service":"composio","field":"api_key","value":SECRET})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn writes_are_admin_only_reads_are_open_to_authenticated_users() {
    let fixture = fixture();
    let app = app(&fixture);
    let body = json!({"service":"composio","field":"api_key","value":SECRET,"label":"Composio"});

    // A normal user may list metadata but may not write.
    let (status, listed) = call_with(
        &app,
        Some(USER_TOKEN),
        Method::GET,
        "/api/credentials",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed, json!({"items": []}));

    let (status, _) = call_with(
        &app,
        Some(USER_TOKEN),
        Method::PUT,
        "/api/credentials",
        Some(body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call_with(
        &app,
        Some(USER_TOKEN),
        Method::DELETE,
        "/api/credentials/composio/api_key",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // An admin may write.
    let (status, created) = call(&app, Method::PUT, "/api/credentials", Some(body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_no_secret(&created);
    assert_eq!(created["id"], json!("composio/api_key"));
    assert_eq!(created["service"], json!("composio"));
    assert_eq!(created["field"], json!("api_key"));
    assert_eq!(created["label"], json!("Composio"));
    assert_eq!(created["hint"], json!("••••7788"));
}

#[tokio::test]
async fn responses_and_disk_never_contain_the_secret() {
    let fixture = fixture();
    let app = app(&fixture);

    let (status, created) = call(
        &app,
        Method::PUT,
        "/api/credentials",
        Some(json!({"service":"composio","field":"api_key","value":SECRET})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_no_secret(&created);

    let (status, listed) = call(&app, Method::GET, "/api/credentials", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_no_secret(&listed);
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert!(listed["items"][0].get("value").is_none());

    // The encrypted store on disk holds no plaintext.
    let store = backend::credentials::store_file(&fixture.state);
    let raw = std::fs::read(&store).unwrap();
    assert!(
        !String::from_utf8_lossy(&raw).contains(SECRET),
        "credentials.enc leaked the secret"
    );
    #[cfg(unix)]
    {
        assert_eq!(
            mode_of(&backend::credentials::protected_dir(&fixture.state)),
            0o700
        );
        assert_eq!(mode_of(&store), 0o600);
        assert_eq!(
            mode_of(&backend::credentials::key_file(&fixture.state)),
            0o600
        );
    }

    // Delete removes it and is idempotent.
    let (status, deleted) = call(
        &app,
        Method::DELETE,
        "/api/credentials/composio/api_key",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted, json!({"success": true}));
    assert_no_secret(&deleted);
    let (status, _) = call(
        &app,
        Method::DELETE,
        "/api/credentials/composio/api_key",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, listed) = call(&app, Method::GET, "/api/credentials", None).await;
    assert_eq!(listed, json!({"items": []}));
}

#[tokio::test]
async fn validation_input_is_checked_and_never_echoes_the_key() {
    let _ = mock();
    let fixture = fixture();
    let app = app(&fixture);

    // Unknown service is rejected.
    let (status, _) = call(
        &app,
        Method::POST,
        "/api/credentials/validate",
        Some(json!({"service":"other","field":"api_key"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Absent credential is a 404, not a crash.
    let (status, _) = call(
        &app,
        Method::POST,
        "/api/credentials/validate",
        Some(json!({"service":"composio","field":"api_key"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The stored (valid) key validates true and the response carries no secret.
    call(
        &app,
        Method::PUT,
        "/api/credentials",
        Some(json!({"service":"composio","field":"api_key","value":SECRET})),
    )
    .await;
    let (status, body) = call(
        &app,
        Method::POST,
        "/api/credentials/validate",
        Some(json!({"service":"composio","field":"api_key"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"valid": true}));
    assert_no_secret(&body);

    // An invalid key validates false.
    call(
        &app,
        Method::PUT,
        "/api/credentials",
        Some(json!({"service":"composio","field":"api_key","value":"sk-not-the-key"})),
    )
    .await;
    let (status, body) = call(
        &app,
        Method::POST,
        "/api/credentials/validate",
        Some(json!({"service":"composio","field":"api_key"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"valid": false}));
}

#[tokio::test]
async fn invalid_names_and_values_are_rejected() {
    let fixture = fixture();
    let app = app(&fixture);
    for body in [
        json!({"service":"Bad Name","field":"api_key","value":"x"}),
        json!({"service":"composio","field":"Bad Name","value":"x"}),
        json!({"service":"composio","field":"api_key","value":""}),
        json!({"service":"composio","field":"api_key","value":"x".repeat(9000)}),
    ] {
        let (status, _) = call(&app, Method::PUT, "/api/credentials", Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
}

// ---------------------------------------------------------------------------
// Broker + policy
// ---------------------------------------------------------------------------

/// Echo upstream: reflects the injected credential header and the secret, so
/// tests can prove the broker both injects and scrubs.
async fn echo_upstream(headers: HeaderMap) -> Json<Value> {
    let header = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let custom = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    Json(json!({
        "authorization": header,
        "xApiKey": custom,
        // A misbehaving upstream that reflects a stored secret.
        "leak": SECRET,
    }))
}

async fn github_user(headers: HeaderMap) -> (StatusCode, Json<Value>) {
    let valid = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(format!("token {SECRET}").as_str());
    if valid {
        (StatusCode::OK, Json(json!({ "login": "octocat" })))
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "message": "Bad credentials" })),
        )
    }
}

/// A mock upstream for the broker and GitHub validation. Returns the origin and
/// points `AMIRO_GITHUB_BASE_URL` at it (so the GitHub validate route reaches it).
fn upstream_base() -> &'static str {
    static BASE: OnceLock<String> = OnceLock::new();
    BASE.get_or_init(|| {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("mock runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind upstream");
                let addr = listener.local_addr().expect("upstream addr");
                ready_tx.send(addr).expect("signal ready");
                let app = Router::new()
                    .route("/echo", get(echo_upstream).post(echo_upstream))
                    .route("/user", get(github_user));
                axum::serve(listener, app).await.expect("upstream server");
            });
        });
        let addr = ready_rx.recv().expect("upstream start");
        let base = format!("http://{addr}");
        std::env::set_var("AMIRO_GITHUB_BASE_URL", &base);
        base
    })
}

#[tokio::test]
async fn policy_metadata_is_stored_and_returned() {
    let fixture = fixture();
    let app = app(&fixture);

    let (status, created) = call(
        &app,
        Method::PUT,
        "/api/credentials",
        Some(json!({
            "service": "github",
            "field": "token",
            "value": SECRET,
            "label": "GitHub PAT",
            "usageDescription": "Call the GitHub API",
            "allowedTools": ["bash", "http"],
            "allowedDomains": ["api.github.com"],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_no_secret(&created);
    assert_eq!(created["envVar"], json!("AMIRO_CRED_GITHUB_TOKEN"));
    assert_eq!(created["usageDescription"], json!("Call the GitHub API"));
    assert_eq!(created["allowedTools"], json!(["bash", "http"]));
    assert_eq!(created["allowedDomains"], json!(["api.github.com"]));

    let (status, listed) = call(&app, Method::GET, "/api/credentials", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_no_secret(&listed);
    assert_eq!(listed["items"][0]["envVar"], json!("AMIRO_CRED_GITHUB_TOKEN"));
    assert_eq!(listed["items"][0]["allowedDomains"], json!(["api.github.com"]));
}

#[tokio::test]
async fn broker_injects_the_header_and_scrubs_the_secret() {
    let base = upstream_base();
    let fixture = fixture();
    let app = app(&fixture);

    call(
        &app,
        Method::PUT,
        "/api/credentials",
        Some(json!({
            "service": "github",
            "field": "token",
            "value": SECRET,
            "allowedDomains": ["127.0.0.1"],
        })),
    )
    .await;

    let (status, body) = call(
        &app,
        Method::POST,
        "/api/credentials/broker",
        Some(json!({
            "service": "github",
            "field": "token",
            "url": format!("{base}/echo"),
            "method": "GET",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["status"], json!(200));
    // The upstream response body is a scrubbed JSON *string*.
    let echoed: Value = serde_json::from_str(body["body"].as_str().unwrap()).unwrap();
    // The header arrived with the default "Bearer " prefix, and the reflected
    // secret was replaced.
    assert_eq!(echoed["authorization"], json!("Bearer [REDACTED]"));
    assert_eq!(echoed["leak"], json!("[REDACTED]"));
    // ... and no reflection of the secret survives in the response.
    assert!(!body.to_string().contains(SECRET), "broker leaked the secret: {body}");
    assert!(body.to_string().contains("[REDACTED]"));

    // A custom header name and prefix are honored.
    let (status, body) = call(
        &app,
        Method::POST,
        "/api/credentials/broker",
        Some(json!({
            "service": "github",
            "field": "token",
            "url": format!("{base}/echo"),
            "method": "GET",
            "headerName": "x-api-key",
            "valuePrefix": "Token ",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.to_string().contains(SECRET));
    let echoed: Value = serde_json::from_str(body["body"].as_str().unwrap()).unwrap();
    assert_eq!(echoed["xApiKey"], json!("Token [REDACTED]"));
}

#[tokio::test]
async fn broker_enforces_allowed_domains() {
    let base = upstream_base();
    let fixture = fixture();
    let app = app(&fixture);

    call(
        &app,
        Method::PUT,
        "/api/credentials",
        Some(json!({
            "service": "github",
            "field": "token",
            "value": SECRET,
            "allowedDomains": ["api.github.com", "*.github.com"],
        })),
    )
    .await;

    let (status, body) = call(
        &app,
        Method::POST,
        "/api/credentials/broker",
        Some(json!({
            "service": "github",
            "field": "token",
            "url": format!("{base}/echo"),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(!body.to_string().contains(SECRET));

    // An unknown credential is a 404, not a crash.
    let (status, _) = call(
        &app,
        Method::POST,
        "/api/credentials/broker",
        Some(json!({
            "service": "github",
            "field": "missing",
            "url": format!("{base}/echo"),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A malformed URL is rejected before any request is made.
    let (status, _) = call(
        &app,
        Method::POST,
        "/api/credentials/broker",
        Some(json!({"service": "github", "field": "token", "url": "not-a-url"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn broker_is_admin_only() {
    let fixture = fixture();
    let app = app(&fixture);
    let (status, _) = call_with(
        &app,
        Some(USER_TOKEN),
        Method::POST,
        "/api/credentials/broker",
        Some(json!({"service":"github","field":"token","url":"https://example.com"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn github_validate_uses_the_configured_base_url() {
    let _base = upstream_base();
    let fixture = fixture();
    let app = app(&fixture);

    // Absent credential is a 404.
    let (status, _) = call(
        &app,
        Method::POST,
        "/api/credentials/validate",
        Some(json!({"service":"github","field":"token"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    call(
        &app,
        Method::PUT,
        "/api/credentials",
        Some(json!({"service":"github","field":"token","value":SECRET})),
    )
    .await;
    let (status, body) = call(
        &app,
        Method::POST,
        "/api/credentials/validate",
        Some(json!({"service":"github","field":"token"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"valid": true}));
    assert_no_secret(&body);
}

#[tokio::test]
async fn github_routes_migrate_the_legacy_plaintext_token() {
    let fixture = fixture();
    let app = app(&fixture);
    let legacy = fixture.state.home.join("store").join("github.json");
    seed(
        &legacy,
        &json!({"connected": true, "token": SECRET, "updatedAt": now_iso()}),
    );

    let (status, body) = call(&app, Method::GET, "/api/github/status", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["connected"], json!(true));
    assert_eq!(body["tokenHint"], json!("••••7788"));
    assert_no_secret(&body);

    // The plaintext file no longer carries the token.
    let rewritten = std::fs::read_to_string(&legacy).unwrap();
    assert!(!rewritten.contains(SECRET), "legacy file kept the token");
    let parsed: Value = serde_json::from_str(&rewritten).unwrap();
    assert_eq!(parsed["connected"], json!(true));
    assert!(parsed["token"].is_null());

    // The value now lives (encrypted) in the credential store.
    let secret = backend::credentials::get_plaintext(&fixture.state, "github", "token")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(secret.expose(), SECRET);
    let on_disk =
        String::from_utf8_lossy(&std::fs::read(backend::credentials::store_file(&fixture.state)).unwrap())
            .to_string();
    assert!(!on_disk.contains(SECRET));

    // Disconnect removes it and reports disconnected.
    let (status, body) = call(&app, Method::POST, "/api/github/disconnect", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"success": true}));
    let (status, body) = call(&app, Method::GET, "/api/github/status", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["connected"], json!(false));
}


#[tokio::test]
async fn reveal_is_admin_only_uncacheable_and_returns_the_value() {
    let fixture = fixture();
    let app = app(&fixture);
    call(
        &app,
        Method::PUT,
        "/api/credentials",
        Some(json!({"service":"github","field":"token","value":SECRET})),
    )
    .await;
    let uri = "/api/credentials/github/token/reveal";

    let (status, _) = call_with(&app, None, Method::GET, uri, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = call_with(&app, Some(USER_TOKEN), Method::GET, uri, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!body.to_string().contains(SECRET));

    let (status, body) = call(&app, Method::GET, uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "value": SECRET }));

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("authorization", format!("Bearer {ADMIN_TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");

    let (status, _) = call(&app, Method::GET, "/api/credentials/github/missing/reveal", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
