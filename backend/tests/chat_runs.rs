//! Integration tests for chat turns that outlive their request: reconnecting
//! to a turn (`GET /api/chat/{id}/stream`), its state (`GET /api/chat/{id}/run`)
//! and Stop (`POST /api/chat/stop`).
//!
//! No runtime binary exists in the fixture, so every turn ends in a real error
//! frame -- enough to prove the turn's frames are kept, replayed in full to a
//! later request and never shown to another user.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

const OWNER_TOKEN: &str = "tok-runs-owner";
const OWNER_ID: &str = "owner-runs";
const MEMBER_TOKEN: &str = "tok-runs-member";
const MEMBER_ID: &str = "member-runs";

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
    let root = std::env::temp_dir().join(format!("amiro-runs-it-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let runtime_home = root.join("runtime");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&runtime_home).unwrap();
    std::fs::create_dir_all(root.join("workspace")).unwrap();
    seed(
        &home.join("users.json"),
        &json!({"users": [
            {"id": OWNER_ID, "name": "Owner", "email": "owner@example.test", "role": "admin", "createdAt": now_iso()},
            {"id": MEMBER_ID, "name": "Member", "role": "user", "createdAt": now_iso()},
        ]}),
    );
    seed(
        &home.join("sessions.json"),
        &json!({"sessions": {
            OWNER_TOKEN: {"userId": OWNER_ID, "createdAt": now_iso()},
            MEMBER_TOKEN: {"userId": MEMBER_ID, "createdAt": now_iso()},
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
    backend::chat::router().with_state(fixture.state.clone())
}

async fn call(app: &Router, token: Option<&str>, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, String) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&value).unwrap()))
            .unwrap(),
        None => builder.header("content-length", "0").body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

fn frames(body: &str) -> Vec<String> {
    body.split("\n\n")
        .filter_map(|block| block.lines().find_map(|line| line.strip_prefix("data: ")))
        .map(str::to_string)
        .collect()
}

fn send_body(thread: &str) -> Value {
    json!({
        "id": thread,
        "permissionMode": "auto",
        "message": {"id": "m1", "role": "user", "parts": [{"type": "text", "text": "Plan my week"}]},
    })
}

async fn run_state(app: &Router, token: &str, thread: &str) -> String {
    let (status, body) = call(app, Some(token), Method::GET, &format!("/api/chat/{thread}/run"), None).await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_str::<Value>(&body).unwrap()["state"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_turn_can_be_reconnected_to_and_replays_in_full() {
    let fixture = fixture();
    let app = app(&fixture);
    let thread = uuid::Uuid::new_v4().to_string();

    assert_eq!(run_state(&app, OWNER_TOKEN, &thread).await, "none");
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::GET, &format!("/api/chat/{thread}/stream"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "nothing to reconnect to yet");

    let (status, body) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/chat", Some(send_body(&thread))).await;
    assert_eq!(status, StatusCode::OK);
    let sent = frames(&body);
    assert!(sent.first().is_some_and(|f| f.contains("\"type\":\"start\"")), "{sent:?}");
    assert_eq!(sent.last().map(String::as_str), Some("[DONE]"));

    // The turn stays replayable after it ends, with exactly the same frames.
    assert_eq!(run_state(&app, OWNER_TOKEN, &thread).await, "finished");
    let (status, body) = call(&app, Some(OWNER_TOKEN), Method::GET, &format!("/api/chat/{thread}/stream"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(frames(&body), sent);
}

#[tokio::test]
async fn turns_are_per_user() {
    let fixture = fixture();
    let app = app(&fixture);
    let thread = uuid::Uuid::new_v4().to_string();
    call(&app, Some(OWNER_TOKEN), Method::POST, "/api/chat", Some(send_body(&thread))).await;

    assert_eq!(run_state(&app, MEMBER_TOKEN, &thread).await, "none");
    let (status, _) = call(&app, Some(MEMBER_TOKEN), Method::GET, &format!("/api/chat/{thread}/stream"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = call(&app, None, Method::GET, &format!("/api/chat/{thread}/stream"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn stop_needs_a_thread_and_reports_whether_anything_ran() {
    let fixture = fixture();
    let app = app(&fixture);
    let (status, _) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/chat/stop", Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&app, None, Method::POST, "/api/chat/stop", Some(json!({"id": "x"}))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let thread = uuid::Uuid::new_v4().to_string();
    call(&app, Some(OWNER_TOKEN), Method::POST, "/api/chat", Some(send_body(&thread))).await;
    let (status, body) = call(&app, Some(OWNER_TOKEN), Method::POST, "/api/chat/stop", Some(json!({"id": thread}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["stopped"], false, "the turn already ended");
}
