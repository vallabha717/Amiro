//! Integration tests for the Team room (`/api/team/room`): posting, @mention
//! routing, per-user rooms and what the room shows when an agent cannot answer.
//!
//! The real router is driven through `tower::ServiceExt::oneshot`. No runtime
//! binary exists in the fixture, so every delivery ends in an error notice --
//! which is exactly the path that proves a message reached its agent.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

const OWNER_TOKEN: &str = "tok-room-owner";
const OWNER_ID: &str = "owner-room";
const MEMBER_TOKEN: &str = "tok-room-member";
const MEMBER_ID: &str = "member-room";

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
    let root = std::env::temp_dir().join(format!("amiro-room-it-{}", uuid::Uuid::new_v4()));
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
    backend::routes::router()
        .merge(backend::agent::router())
        .with_state(fixture.state.clone())
}

async fn call(app: &Router, token: Option<&str>, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
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
    let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    (status, value)
}

async fn post(app: &Router, token: &str, text: &str) -> (StatusCode, Value) {
    call(app, Some(token), Method::POST, "/api/team/room", Some(json!({ "text": text }))).await
}

async fn create_scout(app: &Router) -> String {
    let (status, agent) = call(
        app,
        Some(OWNER_TOKEN),
        Method::POST,
        "/api/agents",
        Some(json!({
            "name": "Scout",
            "role": "Research assistant",
            "instructions": "Find sources.",
            "traits": {"bodyShape": "sprout", "eyeStyle": "curious", "color": "teal"}
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{agent}");
    agent["id"].as_str().unwrap().to_string()
}

async fn room(app: &Router, token: &str) -> Value {
    let (status, room) = call(app, Some(token), Method::GET, "/api/team/room", None).await;
    assert_eq!(status, StatusCode::OK, "{room}");
    room
}

/// Polls until the room holds an error notice for `agent`, or panics.
async fn wait_for_notice(app: &Router, token: &str, agent: &str) -> Value {
    for _ in 0..100 {
        let room = room(app, token).await;
        if let Some(notice) = room["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["kind"] == "error" && m["agentId"] == agent)
        {
            return notice.clone();
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("no notice for {agent}");
}

#[tokio::test]
async fn team_room_needs_sign_in_and_text() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = call(&app, None, Method::GET, "/api/team/room", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, None, Method::POST, "/api/team/room", Some(json!({"text": "hi"}))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = post(&app, OWNER_TOKEN, "   ").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = post(&app, OWNER_TOKEN, &"x".repeat(4001)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn team_room_routes_by_mention_and_defaults_to_main() {
    let fx = fixture();
    let app = app(&fx);
    let scout = create_scout(&app).await;

    let empty = room(&app, OWNER_TOKEN).await;
    assert_eq!(empty["messages"], json!([]));
    assert_eq!(empty["maxHops"], 4);

    let (status, posted) = post(&app, OWNER_TOKEN, "Morning, team").await;
    assert_eq!(status, StatusCode::OK, "{posted}");
    let message = &posted["message"];
    assert_eq!(message["to"], json!(["main"]));
    assert_eq!(message["from"]["type"], "user");
    assert_eq!(message["from"]["name"], "Owner");
    assert_eq!(message["hop"], 0);

    let (_, posted) = post(&app, OWNER_TOKEN, "@scout find three sources").await;
    assert_eq!(posted["message"]["to"], json!([scout]));

    let (_, posted) = post(&app, OWNER_TOKEN, "@all standup").await;
    assert_eq!(posted["message"]["to"].as_array().unwrap().len(), 2);

    // Each delivery reaches its agent: with no runtime here, each one ends in
    // a notice naming the agent and pointing at the message it answers.
    let notice = wait_for_notice(&app, OWNER_TOKEN, &scout).await;
    assert_eq!(notice["from"]["type"], "system");
    assert!(notice["replyTo"].is_string());
    wait_for_notice(&app, OWNER_TOKEN, "main").await;
}

#[tokio::test]
async fn team_room_is_per_user() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = post(&app, OWNER_TOKEN, "owner only").await;
    assert_eq!(status, StatusCode::OK);
    let member = room(&app, MEMBER_TOKEN).await;
    assert!(member["messages"].as_array().unwrap().iter().all(|m| m["text"] != "owner only"));
    let owner = room(&app, OWNER_TOKEN).await;
    assert!(owner["messages"].as_array().unwrap().iter().any(|m| m["text"] == "owner only"));
}
