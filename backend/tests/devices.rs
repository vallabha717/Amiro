//! Integration tests for connecting devices (`backend::devices`): the device
//! code flow (a device asks, the owner approves or denies, the device collects
//! its own session), removing a device, and the phone-access setting. Driven
//! through the real routers with `oneshot`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

const OWNER_TOKEN: &str = "tok-devices-owner";
const OWNER_ID: &str = "owner-devices";
const MEMBER_TOKEN: &str = "tok-devices-member";

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

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
    let root = std::env::temp_dir().join(format!("amiro-devices-it-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    seed(
        &home.join("users.json"),
        &json!({"users": [
            {"id": OWNER_ID, "name": "Owner", "email": "owner@example.com", "role": "admin", "createdAt": now_iso()},
            {"id": "member", "name": "Member", "role": "user", "createdAt": now_iso()},
        ]}),
    );
    seed(
        &home.join("sessions.json"),
        &json!({"sessions": {
            OWNER_TOKEN: {"userId": OWNER_ID, "createdAt": now_iso()},
            MEMBER_TOKEN: {"userId": "member", "createdAt": now_iso()},
        }}),
    );
    let state = AppState {
        runtime_home: root.join("runtime"),
        runtime_socket: root.join("amiro-api.sock"),
        workspace: root.join("workspace"),
        runtime_bin: root.join("amiro-runtime"),
        token: String::new(),
        store: Arc::new(tokio::sync::Mutex::new(())),
        home,
    };
    Fixture { state, root }
}

fn app(fixture: &Fixture) -> Router {
    backend::devices::router()
        .merge(backend::auth::router())
        .with_state(fixture.state.clone())
}

async fn call(
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
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

/// Step 1: a device asks to connect. Returns (device code, user code).
async fn ask(app: &Router, name: &str) -> (String, String) {
    let (status, body) = call(
        app,
        None,
        Method::POST,
        "/api/devices/authorize",
        Some(json!({"name": name, "platform": "android"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["interval"], 5);
    assert_eq!(body["verificationPath"], "/device");
    let user_code = body["userCode"].as_str().unwrap().to_string();
    assert!(body["verificationPathComplete"].as_str().unwrap().ends_with(&user_code));
    (body["deviceCode"].as_str().unwrap().to_string(), user_code)
}

async fn poll(app: &Router, device_code: &str) -> (StatusCode, Value) {
    call(app, None, Method::POST, "/api/devices/token", Some(json!({"deviceCode": device_code}))).await
}

#[tokio::test]
async fn devices_code_flow_approve_gives_the_device_its_own_session_that_removing_ends() {
    let fx = fixture();
    let app = app(&fx);
    let (device_code, user_code) = ask(&app, "Pixel 9").await;

    let (status, body) = poll(&app, &device_code).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "authorization_pending");
    let (_, body) = poll(&app, &device_code).await;
    assert_eq!(body["error"], "slow_down", "polling faster than the interval");

    // The owner sees it waiting in Settings → Devices, without its secret.
    let (_, list) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/devices", None).await;
    assert_eq!(list["requests"][0]["userCode"], user_code.as_str());
    assert_eq!(list["requests"][0]["name"], "Pixel 9");
    assert!(list["requests"][0].get("deviceCodeHash").is_none());
    assert!(!list.to_string().contains(&device_code));

    // …and finds it at /device by the code, typed loosely.
    let typed = user_code.replace('-', "").to_lowercase();
    let (status, found) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::GET,
        &format!("/api/devices/requests/lookup?code={typed}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{found}");
    assert_eq!(found["platform"], "android");
    let id = found["id"].as_str().unwrap().to_string();

    let (status, _) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::POST,
        &format!("/api/devices/requests/{id}/approve"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, claimed) = poll(&app, &device_code).await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    let device_token = claimed["token"].as_str().unwrap().to_string();
    assert_eq!(claimed["user"]["id"], OWNER_ID);
    assert!(claimed["user"].get("passwordHash").is_none());
    let device_id = claimed["device"]["id"].as_str().unwrap().to_string();

    // Collected once: the request is gone.
    let (_, body) = poll(&app, &device_code).await;
    assert_eq!(body["error"], "expired_token");

    let (status, me) = call(&app, Some(&device_token), Method::GET, "/api/auth/session", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["id"], OWNER_ID);
    let (_, list) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/devices", None).await;
    assert_eq!(list["devices"][0]["name"], "Pixel 9");
    assert_eq!(list["requests"], json!([]));

    let (status, after) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::DELETE,
        &format!("/api/devices/{device_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["devices"], json!([]));
    let (status, _) = call(&app, Some(&device_token), Method::GET, "/api/auth/session", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn devices_code_flow_deny_and_owner_only_answers() {
    let fx = fixture();
    let app = app(&fx);
    let (device_code, user_code) = ask(&app, "Unknown phone").await;

    let (status, _) = call(&app, None, Method::GET, "/api/devices", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &app,
        Some(MEMBER_TOKEN),
        Method::GET,
        &format!("/api/devices/requests/lookup?code={user_code}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::GET,
        "/api/devices/requests/lookup?code=ZZZZ-ZZZZ",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].as_str().unwrap().contains("no device is waiting"));

    let (_, list) = call(&app, Some(OWNER_TOKEN), Method::GET, "/api/devices", None).await;
    let id = list["requests"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = call(
        &app,
        Some(MEMBER_TOKEN),
        Method::POST,
        &format!("/api/devices/requests/{id}/approve"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::POST,
        &format!("/api/devices/requests/{id}/deny"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Answered once: approving it now is refused.
    let (status, _) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::POST,
        &format!("/api/devices/requests/{id}/approve"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (_, body) = poll(&app, &device_code).await;
    assert_eq!(body["error"], "access_denied");
    let (_, body) = poll(&app, "not-a-real-device-code").await;
    assert_eq!(body["error"], "expired_token");
    let (status, body) = call(&app, None, Method::POST, "/api/devices/token", Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_request");
}

#[tokio::test]
async fn devices_settings_offer_this_servers_address_as_a_qr_code() {
    let fx = fixture();
    let app = app(&fx);
    let (status, list) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::GET,
        "/api/devices?origin=https%3A%2F%2Famiro.example.com",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["links"][0]["url"], "https://amiro.example.com");
    assert_eq!(list["links"][0]["link"], "https://amiro.example.com/pair");
    assert!(list["links"][0]["qrSvg"].as_str().unwrap().starts_with("<svg"));
}

#[tokio::test]
async fn devices_remote_access_validates_and_reports() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::PUT,
        "/api/devices/remote-access",
        Some(json!({"enabled": true, "port": 80})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::PUT,
        "/api/devices/remote-access",
        Some(json!({"port": 9000})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = call(
        &app,
        Some(OWNER_TOKEN),
        Method::PUT,
        "/api/devices/remote-access",
        Some(json!({"enabled": false, "port": 9001})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["remoteAccess"]["enabled"], false);
    assert_eq!(body["remoteAccess"]["port"], 9001);
    assert_eq!(body["remoteAccess"]["listening"], false);
}
