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

/// Reads SSE `data:` frames from a streaming response body as JSON.
struct Frames {
    body: axum::body::BodyDataStream,
    buffer: String,
}

impl Frames {
    async fn next(&mut self) -> Value {
        use futures::StreamExt;
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let frame: String = self.buffer.drain(..end + 2).collect();
                let data: String = frame
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(str::trim)
                    .collect();
                if data.is_empty() {
                    continue; // keepalive comment
                }
                return serde_json::from_str(&data).unwrap();
            }
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(10), self.body.next())
                .await
                .expect("stream went quiet")
                .expect("stream ended")
                .unwrap();
            self.buffer.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }

    /// The next event of `kind`, skipping the others.
    async fn next_of(&mut self, kind: &str) -> Value {
        self.next_where(kind, |_| true).await
    }

    /// The next event of `kind` that `matches`, skipping the others.
    async fn next_where(&mut self, kind: &str, matches: impl Fn(&Value) -> bool) -> Value {
        loop {
            let event = self.next().await;
            if event["type"] == kind && matches(&event) {
                return event;
            }
        }
    }
}

async fn open_stream(app: &Router, token: Option<&str>) -> (StatusCode, Option<Frames>) {
    let mut builder = Request::builder().method(Method::GET).uri("/api/team/room/stream");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app.clone().oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    if status != StatusCode::OK {
        return (status, None);
    }
    let body = response.into_body().into_data_stream();
    (status, Some(Frames { body, buffer: String::new() }))
}

#[tokio::test]
async fn team_room_stream_needs_sign_in() {
    let fx = fixture();
    let app = app(&fx);
    let (status, _) = open_stream(&app, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn team_room_stream_sends_a_snapshot_then_live_changes() {
    let fx = fixture();
    let app = app(&fx);
    let (_, posted) = post(&app, OWNER_TOKEN, "before the stream").await;
    let (status, frames) = open_stream(&app, Some(OWNER_TOKEN)).await;
    assert_eq!(status, StatusCode::OK);
    let mut frames = frames.unwrap();

    let snapshot = frames.next().await;
    assert_eq!(snapshot["type"], "snapshot");
    assert!(snapshot["messages"].as_array().unwrap().iter().any(|m| m["id"] == posted["message"]["id"]));
    assert!(snapshot["drafts"].is_array());
    assert!(snapshot["working"].is_array());

    // A new message arrives live, then the main agent's turn: working, a draft
    // for its reply, and (no runtime here) a notice that replaces the draft.
    // (The earlier message's turn may still be finishing; its events are skipped.)
    let (_, posted) = post(&app, OWNER_TOKEN, "Morning, team").await;
    let id = posted["message"]["id"].clone();
    frames.next_where("message", |e| e["message"]["id"] == id).await;

    let draft = frames.next_where("draft", |e| e["draft"]["replyTo"] == id).await;
    assert_eq!(draft["draft"]["agentId"], "main");
    assert_eq!(draft["draft"]["text"], "");
    let draft_id = draft["draft"]["id"].clone();

    let notice = frames.next_where("message", |e| e["message"]["replyTo"] == id).await["message"].clone();
    assert_eq!(notice["kind"], "error");
    assert_eq!(notice["draftId"], draft_id, "the notice names the draft it replaces");
    frames.next_where("draft.end", |e| e["id"] == draft_id).await;
    frames.next_where("working", |e| e["working"] == json!([])).await;
}

#[tokio::test]
async fn team_room_stream_is_per_user() {
    let fx = fixture();
    let app = app(&fx);
    let (_, frames) = open_stream(&app, Some(MEMBER_TOKEN)).await;
    let mut frames = frames.unwrap();
    assert_eq!(frames.next().await["type"], "snapshot");
    post(&app, OWNER_TOKEN, "owner only").await;
    let (_, mine) = post(&app, MEMBER_TOKEN, "member here").await;
    // The member's first live message is their own; the owner's never arrives.
    let first = frames.next_of("message").await;
    assert_eq!(first["message"]["id"], mine["message"]["id"]);
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
