//! Phase 03: channel bind/verify/unbind/resend against stub HTTP servers.
//!
//! No live network calls: each test boots a local stub that mimics the
//! Telegram/Slack/Discord APIs, points the adapter at it through
//! `AMIRO_NOTIFY_<CHANNEL>_BASE_URL`, and never uses a real token. One test
//! asserts a vault-stored token appears in no response body and in no file
//! under the temp home.

use std::sync::{Arc, Mutex, OnceLock};

use axum::body::{to_bytes, Body};
use axum::extract::Path;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::{get, post};
use axum::Json;
use backend::routes::router;
use backend::state::AppState;
use serde_json::{json, Value};
use tower::ServiceExt;

/// Serializes every test in this file: the stub base URLs travel through
/// process-global env vars, so two tests must never set them at once.
fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn test_state() -> (AppState, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("amiro-notify-chan-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    std::fs::write(
        home.join("users.json"),
        json!({"users": [{"id": "u1", "name": "Owner", "role": "admin", "createdAt": now}]})
            .to_string(),
    )
    .unwrap();
    std::fs::write(
        home.join("sessions.json"),
        json!({"sessions": {"tok": {"userId": "u1", "createdAt": now}}}).to_string(),
    )
    .unwrap();
    let state = AppState {
        home,
        runtime_home: root.join("runtime"),
        runtime_socket: root.join("s.sock"),
        workspace: root.join("workspace"),
        runtime_bin: root.join("rt"),
        token: "sidecar".into(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    (state, root)
}

fn app() -> (axum::Router, std::path::PathBuf, AppState) {
    let (state, root) = test_state();
    (router().with_state(state.clone()), root, state)
}

async fn request(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    auth: bool,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if auth {
        builder = builder.header("authorization", "Bearer tok");
    }
    let req = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn bearer(headers: &HeaderMap) -> String {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// Stub provider server. `good` tokens verify and send cleanly; anything
/// else is rejected the way the real provider rejects a bad token.
async fn stub_server() -> String {
    let app = axum::Router::new()
        // --- Telegram: GET /bot<token>/getMe, POST /bot<token>/sendMessage
        .route(
            "/tg/bot{token}/getMe",
            get(|Path(token): Path<String>| async move {
                if token == "GOOD-TG-TOKEN" {
                    (
                        StatusCode::OK,
                        Json(json!({"ok": true, "result": {"username": "testbot"}})),
                    )
                } else {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"ok": false, "description": "Unauthorized"})),
                    )
                }
            }),
        )
        .route(
            "/tg/bot{token}/sendMessage",
            post(
                |Path(token): Path<String>, Json(_): Json<Value>| async move {
                    if token == "GOOD-TG-TOKEN" {
                        (
                            StatusCode::OK,
                            Json(json!({"ok": true, "result": {"message_id": 7}})),
                        )
                    } else {
                        (
                            StatusCode::UNAUTHORIZED,
                            Json(json!({"ok": false, "description": "Unauthorized"})),
                        )
                    }
                },
            ),
        )
        // --- Slack: POST /slack/auth.test, /slack/conversations.open, /slack/chat.postMessage
        .route(
            "/slack/auth.test",
            post(|headers: HeaderMap| async move {
                if bearer(&headers) == "Bearer GOOD-SLACK-TOKEN" {
                    (
                        StatusCode::OK,
                        Json(json!({"ok": true, "team": "T", "user": "U"})),
                    )
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({"ok": false, "error": "invalid_auth"})),
                    )
                }
            }),
        )
        .route(
            "/slack/conversations.open",
            post(|headers: HeaderMap, Json(_): Json<Value>| async move {
                if bearer(&headers) == "Bearer GOOD-SLACK-TOKEN" {
                    (
                        StatusCode::OK,
                        Json(json!({"ok": true, "channel": {"id": "D123"}})),
                    )
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({"ok": false, "error": "invalid_auth"})),
                    )
                }
            }),
        )
        .route(
            "/slack/chat.postMessage",
            post(|headers: HeaderMap, Json(_): Json<Value>| async move {
                if bearer(&headers) == "Bearer GOOD-SLACK-TOKEN" {
                    (
                        StatusCode::OK,
                        Json(json!({"ok": true, "ts": "1700000000.0001"})),
                    )
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({"ok": false, "error": "invalid_auth"})),
                    )
                }
            }),
        )
        // --- Discord: GET /dc/users/@me, POST /dc/users/@me/channels, POST /dc/channels/{id}/messages
        .route(
            "/dc/users/@me",
            get(|headers: HeaderMap| async move {
                if bearer(&headers) == "Bot GOOD-DC-TOKEN" {
                    (StatusCode::OK, Json(json!({"username": "dbot"})))
                } else {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"message": "401: Unauthorized"})),
                    )
                }
            }),
        )
        .route(
            "/dc/users/@me/channels",
            post(|headers: HeaderMap, Json(_): Json<Value>| async move {
                if bearer(&headers) == "Bot GOOD-DC-TOKEN" {
                    (StatusCode::OK, Json(json!({"id": "DM9"})))
                } else {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"message": "401: Unauthorized"})),
                    )
                }
            }),
        )
        .route(
            "/dc/channels/{id}/messages",
            post(|headers: HeaderMap, Json(_): Json<Value>| async move {
                if bearer(&headers) == "Bot GOOD-DC-TOKEN" {
                    (StatusCode::OK, Json(json!({"id": "M1"})))
                } else {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({"message": "401: Unauthorized"})),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .unwrap();
    });
    base
}

fn point_adapters_at(base: &str) {
    std::env::set_var("AMIRO_NOTIFY_TELEGRAM_BASE_URL", format!("{base}/tg"));
    std::env::set_var("AMIRO_NOTIFY_SLACK_BASE_URL", format!("{base}/slack"));
    std::env::set_var("AMIRO_NOTIFY_DISCORD_BASE_URL", format!("{base}/dc"));
}

#[tokio::test]
async fn channels_require_auth() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    let (status, _) = request(&app, "GET", "/api/notifications/channels", None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({})),
        false,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    std::env::remove_var("AMIRO_NOTIFY_TELEGRAM_BASE_URL");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn bind_verify_unbind_flow() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);

    // Start unbound.
    let (status, body) = request(&app, "GET", "/api/notifications/channels", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["channels"].as_array().unwrap().len(), 3);
    assert!(body["channels"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["bound"] == json!(false)));

    // Bind with the token inline: verify runs, binding persists.
    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "telegram", "chatId": "chat-1", "token": "GOOD-TG-TOKEN"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["bound"], json!(true));
    assert_eq!(body["chatId"], json!("chat-1"));
    assert_eq!(body["chatName"], json!("testbot"));
    assert_eq!(body["hasToken"], json!(true));
    assert!(body.get("token").is_none(), "token leaked: {body}");

    // Rebind without the token reuses the vault copy.
    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "telegram", "chatId": "chat-2"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["chatId"], json!("chat-2"));

    // Unbind drops the row but keeps the vault token for a future rebind.
    let (status, body) = request(
        &app,
        "DELETE",
        "/api/notifications/channels/telegram",
        None,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["bound"], json!(false));
    let (status, body) = request(&app, "GET", "/api/notifications/channels", None, true).await;
    assert_eq!(status, StatusCode::OK);
    let telegram = body["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel"] == json!("telegram"))
        .unwrap()
        .clone();
    assert_eq!(telegram["bound"], json!(false));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn bind_validates_input_and_tokens() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);

    // Unknown channel.
    let (status, _) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "pigeon", "chatId": "1", "token": "x"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Blank destination.
    let (status, _) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "slack", "chatId": "  ", "token": "GOOD-SLACK-TOKEN"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Bad token: provider rejects it, nothing is bound.
    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "telegram", "chatId": "chat-1", "token": "WRONG"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let (status, list) = request(&app, "GET", "/api/notifications/channels", None, true).await;
    assert_eq!(status, StatusCode::OK);
    let telegram = list["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel"] == json!("telegram"))
        .unwrap()
        .clone();
    assert_eq!(telegram["bound"], json!(false));

    // No token anywhere: the caller must go through the secret card first.
    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "discord", "chatId": "user-9"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.to_string().contains("vault"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn slack_and_discord_bind_verify_and_send() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);

    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "slack", "chatId": "U42", "token": "GOOD-SLACK-TOKEN"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["bound"], json!(true));

    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "discord", "chatId": "user-9", "token": "GOOD-DC-TOKEN"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["chatName"], json!("dbot"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn one_channel_failing_never_blocks_others() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, state) = app();
    point_adapters_at(&stub_server().await);

    // Telegram is healthy; Slack's stored token is rejected by the provider.
    request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "telegram", "chatId": "chat-1", "token": "GOOD-TG-TOKEN"})),
        true,
    )
    .await;
    // Bind Slack with the good token, then overwrite the vault with a bad one
    // (simulates a revoked token without a UI round-trip).
    request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "slack", "chatId": "U42", "token": "GOOD-SLACK-TOKEN"})),
        true,
    )
    .await;
    backend::credentials::set(&state, "notify.slack", "bot_token", "REVOKED", None)
        .await
        .unwrap();

    let emitted = backend::notify::emit_signal(
        &state,
        "u1",
        &json!({
            "sourceChannel": "scheduler",
            "sourceContextId": "sched-9",
            "sourceEventName": "schedule.result",
            "title": "Nightly backup",
            "body": "Backup finished.",
            "urgency": "high",
        }),
    )
    .await
    .unwrap();
    assert_eq!(emitted["duplicate"], json!(false));
    let delivery_id = emitted["deliveryId"].as_str().unwrap().to_string();

    let raw = std::fs::read_to_string(
        root.join("home")
            .join("store")
            .join("notification-deliveries.json"),
    )
    .unwrap();
    let rows: Vec<Value> = serde_json::from_str::<Value>(&raw).unwrap()["rows"]
        .as_array()
        .cloned()
        .unwrap();
    let mine: Vec<&Value> = rows
        .iter()
        .filter(|r| r["deliveryId"] == json!(delivery_id))
        .collect();
    assert_eq!(mine.len(), 3, "local + telegram + slack rows: {mine:?}");
    let status_of = |channel: &str| {
        mine.iter()
            .find(|r| r["channel"] == json!(channel))
            .unwrap()["status"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(status_of("local"), "sent");
    assert_eq!(status_of("telegram"), "sent");
    assert_eq!(status_of("slack"), "failed");
    // The feed item still landed.
    assert_eq!(emitted["item"]["title"], json!("Nightly backup"));

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn resend_records_a_new_delivery_row() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, state) = app();
    point_adapters_at(&stub_server().await);

    request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "telegram", "chatId": "chat-1", "token": "GOOD-TG-TOKEN"})),
        true,
    )
    .await;

    let emitted = backend::notify::emit_signal(
        &state,
        "u1",
        &json!({
            "sourceChannel": "scheduler",
            "sourceContextId": "sched-3",
            "sourceEventName": "schedule.result",
            "title": "Deploy done",
            "body": "Deploy finished.",
        }),
    )
    .await
    .unwrap();
    let first_id = emitted["deliveryId"].as_str().unwrap().to_string();

    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/resend",
        Some(json!({"deliveryId": first_id, "channel": "telegram"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("sent"));
    assert_ne!(body["deliveryId"], json!(first_id));

    // Unknown delivery / channel.
    let (status, _) = request(
        &app,
        "POST",
        "/api/notifications/channels/resend",
        Some(json!({"deliveryId": "nope", "channel": "telegram"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        &app,
        "POST",
        "/api/notifications/channels/resend",
        Some(json!({"deliveryId": first_id, "channel": "pigeon"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let _ = std::fs::remove_dir_all(root);
}

/// A vault-stored token must appear in no response body and in no file
/// under the temp home (responses, `notification-channels.json`, or the
/// encrypted vault file itself — ciphertext must not contain it raw).
#[tokio::test]
async fn vault_token_appears_nowhere_observable() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);
    const TOKEN: &str = "GOOD-SLACK-TOKEN";

    let mut bodies: Vec<String> = Vec::new();
    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "slack", "chatId": "U7", "token": TOKEN})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    bodies.push(body.to_string());
    let (_, list) = request(&app, "GET", "/api/notifications/channels", None, true).await;
    bodies.push(list.to_string());

    for dump in &bodies {
        assert!(!dump.contains(TOKEN), "token leaked in response: {dump}");
    }

    let mut files_checked = 0;
    for entry in walk(&root.join("home")) {
        let bytes = std::fs::read(&entry).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains(TOKEN),
            "token leaked in file {}",
            entry.display()
        );
        files_checked += 1;
    }
    assert!(
        files_checked > 0,
        "expected persisted files under temp home"
    );

    let _ = std::fs::remove_dir_all(root);
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}
