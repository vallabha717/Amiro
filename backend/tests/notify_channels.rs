//! External notification delivery the Vellum way, end to end against stub
//! provider servers: a bot connected in Channels, the owner's account added
//! to their contact card and verified with a code sent through the channel,
//! then notifications routed by the decision rules to that account.
//!
//! No live network calls: each test boots a local stub that mimics the
//! Telegram/Slack/Discord APIs (and records every message it is sent),
//! points the adapters at it through `AMIRO_NOTIFY_<CHANNEL>_BASE_URL`, and
//! never uses a real token.

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
        json!({"users": [
            {"id": "u1", "name": "Owner", "role": "admin", "createdAt": now},
            {"id": "u2", "name": "Member", "role": "member", "createdAt": now}
        ]})
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        home.join("sessions.json"),
        json!({"sessions": {
            "tok": {"userId": "u1", "createdAt": now},
            "tok2": {"userId": "u2", "createdAt": now}
        }})
        .to_string(),
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
    request_as(app, method, uri, body, auth.then_some("tok")).await
}

async fn request_as(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
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

/// Every message the stub accepted: `{channel, to, text}`.
fn sent() -> &'static Mutex<Vec<Value>> {
    static SENT: OnceLock<Mutex<Vec<Value>>> = OnceLock::new();
    SENT.get_or_init(|| Mutex::new(Vec::new()))
}

fn record(channel: &str, to: &Value, text: &Value) {
    let to = to.as_str().map(str::to_string).unwrap_or_else(|| to.to_string());
    sent()
        .lock()
        .unwrap()
        .push(json!({ "channel": channel, "to": to, "text": text }));
}

/// Messages the stub accepted for `channel` to `to`, oldest first.
fn sent_to(channel: &str, to: &str) -> Vec<String> {
    sent()
        .lock()
        .unwrap()
        .iter()
        .filter(|m| m["channel"] == json!(channel) && m["to"] == json!(to))
        .map(|m| m["text"].as_str().unwrap_or("").to_string())
        .collect()
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
                |Path(token): Path<String>, Json(body): Json<Value>| async move {
                    if token == "GOOD-TG-TOKEN" {
                        record("telegram", &body["chat_id"], &body["text"]);
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
            post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                if bearer(&headers) == "Bearer GOOD-SLACK-TOKEN" {
                    record("slack", &body["channel"], &body["text"]);
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
            post(|Path(id): Path<String>, headers: HeaderMap, Json(body): Json<Value>| async move {
                if bearer(&headers) == "Bot GOOD-DC-TOKEN" {
                    record("discord", &json!(id), &body["content"]);
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

fn channel_row(body: &Value, channel: &str) -> Value {
    body["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel"] == json!(channel))
        .cloned()
        .unwrap()
}

async fn next_step(app: &axum::Router, channel: &str) -> String {
    let (status, body) = request(app, "GET", "/api/notifications/channels", None, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    channel_row(&body, channel)["nextStep"].as_str().unwrap().to_string()
}

async fn guardian_id(app: &axum::Router) -> String {
    let (status, body) = request(app, "GET", "/api/contacts", None, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["contacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["role"] == json!("guardian"))
        .and_then(|c| c["id"].as_str())
        .unwrap()
        .to_string()
}

/// Add `address` on `channel` to the owner's contact card; returns the
/// contact-channel id. A client-sent status is ignored.
async fn add_my_account(app: &axum::Router, channel: &str, address: &str) -> String {
    let id = guardian_id(app).await;
    let (status, body) = request(
        app,
        "POST",
        "/api/contacts",
        Some(json!({
            "id": id,
            "displayName": "You",
            "channels": [{ "type": channel, "address": address, "status": "active" }],
        })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, contact) = request(app, "GET", &format!("/api/contacts/{id}"), None, true).await;
    let record = contact["contact"]["channels"]
        .as_array()
        .or_else(|| contact["channels"].as_array())
        .unwrap()
        .iter()
        .find(|c| c["type"] == json!(channel) && c["address"] == json!(address))
        .cloned()
        .unwrap();
    assert_eq!(record["status"], json!("unverified"), "a client-sent status must be ignored");
    record["id"].as_str().unwrap().to_string()
}

/// Run the code verification: ask for a code, read it from the message the
/// stub received at `to`, type it back.
async fn verify_by_code(app: &axum::Router, channel: &str, contact_channel_id: &str, to: &str) {
    let uri = format!("/api/contact-channels/{contact_channel_id}/verify");
    let before = sent_to(channel, to).len();
    let (status, body) = request(app, "POST", &uri, None, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("code_sent"));
    let messages = sent_to(channel, to);
    assert_eq!(messages.len(), before + 1, "no code reached {channel}:{to}");
    let text = messages.last().unwrap();
    let code: String = text
        .split_whitespace()
        .find(|w| w.trim_end_matches('.').len() == 6 && w.trim_end_matches('.').chars().all(|c| c.is_ascii_digit()))
        .map(|w| w.trim_end_matches('.').to_string())
        .unwrap_or_else(|| panic!("no code in {text:?}"));
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let (status, body) = request(app, "POST", &uri, Some(json!({ "code": wrong })), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"].as_str().unwrap().contains("not right"));
    let (status, body) = request(app, "POST", &uri, Some(json!({ "code": code })), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["via"], json!("code"));
}

async fn connect_bot(app: &axum::Router, channel: &str, token: &str) -> (StatusCode, Value) {
    let uri = match channel {
        "telegram" => "/api/integrations/telegram/config",
        "discord" => "/api/integrations/discord/config",
        _ => "/api/integrations/slack/channel/config",
    };
    request(app, "POST", uri, Some(json!({ "botToken": token })), true).await
}

/// Owner with Telegram fully set up at chat `to`.
async fn telegram_ready(app: &axum::Router, to: &str) {
    let (status, body) = connect_bot(app, "telegram", "GOOD-TG-TOKEN").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = add_my_account(app, "telegram", to).await;
    verify_by_code(app, "telegram", &id, to).await;
    assert_eq!(next_step(app, "telegram").await, "ready");
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
        "/api/notifications/channels/resend",
        Some(json!({})),
        false,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // The old per-notification binding routes are gone.
    let (status, _) = request(
        &app,
        "POST",
        "/api/notifications/channels/bind",
        Some(json!({"channel": "telegram", "chatId": "1"})),
        true,
    )
    .await;
    assert!(status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED, "{status}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn readiness_walks_from_bot_to_verified_account_and_the_test_arrives() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);

    assert_eq!(next_step(&app, "telegram").await, "connect_bot");
    let (status, body) = connect_bot(&app, "telegram", "GOOD-TG-TOKEN").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The bot name comes from the provider, not the browser.
    assert_eq!(body["botUsername"], json!("testbot"));
    assert_eq!(next_step(&app, "telegram").await, "add_address");

    let id = add_my_account(&app, "telegram", "4242").await;
    assert_eq!(next_step(&app, "telegram").await, "verify_address");
    verify_by_code(&app, "telegram", &id, "4242").await;

    let (_, body) = request(&app, "GET", "/api/notifications/channels", None, true).await;
    let telegram = channel_row(&body, "telegram");
    assert_eq!(telegram["ready"], json!(true), "{telegram}");
    assert_eq!(telegram["address"], json!("4242"));
    assert_eq!(telegram["botName"], json!("testbot"));

    // A test notification reaches every ready channel and records it.
    let before = sent_to("telegram", "4242").len();
    let (status, created) =
        request(&app, "POST", "/api/notifications/test", None, true).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let messages = sent_to("telegram", "4242");
    assert_eq!(messages.len(), before + 1);
    assert!(messages.last().unwrap().contains("Amiro Test Notification"));
    let item_id = created["item"]["id"].as_str().unwrap();
    let (_, deliveries) = request(
        &app,
        "GET",
        &format!("/api/notifications/{item_id}/deliveries"),
        None,
        true,
    )
    .await;
    let telegram_row = deliveries["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["channel"] == json!("telegram"))
        .cloned()
        .unwrap();
    assert_eq!(telegram_row["status"], json!("sent"));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn channels_reject_a_bad_bot_token_and_keep_nothing() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);
    for channel in ["telegram", "slack", "discord"] {
        let (status, body) = connect_bot(&app, channel, "e2e-bad-token").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{channel}: {body}");
        assert!(body["error"].as_str().unwrap().contains("rejected that bot token"), "{body}");
        assert_eq!(next_step(&app, channel).await, "connect_bot", "{channel}");
    }
    let (_, config) = request(&app, "GET", "/api/integrations/telegram/config", None, true).await;
    assert_eq!(config["hasBotToken"], json!(false));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn verification_needs_a_bot_and_a_messageable_account() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);

    let id = add_my_account(&app, "telegram", "4343").await;
    let uri = format!("/api/contact-channels/{id}/verify");
    let (status, body) = request(&app, "POST", &uri, None, true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("Channels page"), "{body}");
    // No code was asked for, so none can be typed back.
    let (status, body) = request(&app, "POST", &uri, Some(json!({"code": "123456"})), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("No code"), "{body}");

    // A Slack channel id is a shared room, never a notification destination.
    let (status, _) = connect_bot(&app, "slack", "GOOD-SLACK-TOKEN").await;
    assert_eq!(status, StatusCode::OK);
    let room = add_my_account(&app, "slack", "C123").await;
    let (status, body) = request(
        &app,
        "POST",
        &format!("/api/contact-channels/{room}/verify"),
        None,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("user id"), "{body}");

    // Becoming verified through PATCH is refused.
    let (status, _) = request(
        &app,
        "PATCH",
        &format!("/api/contact-channels/{id}"),
        Some(json!({"status": "active"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn slack_and_discord_deliver_to_direct_messages() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);

    let (status, body) = connect_bot(&app, "slack", "GOOD-SLACK-TOKEN").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let slack = add_my_account(&app, "slack", "U777").await;
    // The stub opens DM D123 for the user.
    verify_by_code(&app, "slack", &slack, "D123").await;

    let (status, body) = connect_bot(&app, "discord", "GOOD-DC-TOKEN").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["botUsername"], json!("dbot"));
    let discord = add_my_account(&app, "discord", "999").await;
    verify_by_code(&app, "discord", &discord, "DM9").await;

    assert_eq!(next_step(&app, "slack").await, "ready");
    assert_eq!(next_step(&app, "discord").await, "ready");
    let slack_before = sent_to("slack", "D123").len();
    let discord_before = sent_to("discord", "DM9").len();
    let (status, _) = request(&app, "POST", "/api/notifications/test", None, true).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(sent_to("slack", "D123").len(), slack_before + 1);
    assert_eq!(sent_to("discord", "DM9").len(), discord_before + 1);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn the_decision_rules_pick_which_signals_go_outside_the_app() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, state) = app();
    point_adapters_at(&stub_server().await);
    telegram_ready(&app, "5151").await;
    let count = || sent_to("telegram", "5151").len();

    let signal = |event: &str, urgency: &str, action: bool, source: &str| {
        json!({
            "sourceChannel": source,
            "sourceContextId": format!("ctx-{}", uuid::Uuid::new_v4()),
            "sourceEventName": event,
            "title": "Heads up",
            "body": "Something happened.",
            "urgency": urgency,
            "attentionHints": { "requiresAction": action },
        })
    };

    // A routine result stays in the app (the fallback is inbox-only).
    let before = count();
    backend::notify::emit_signal(&state, "u1", &signal("schedule.result", "normal", false, "scheduler"))
        .await
        .unwrap();
    assert_eq!(count(), before);

    // Urgent and needing action: every ready channel.
    backend::notify::emit_signal(&state, "u1", &signal("schedule.result", "high", true, "scheduler"))
        .await
        .unwrap();
    assert_eq!(count(), before + 1);

    // Chat replies never leave the app, however urgent.
    backend::notify::emit_signal(&state, "u1", &signal("chat.assistant_reply", "high", true, "assistant_tool"))
        .await
        .unwrap();
    assert_eq!(count(), before + 1);

    // Another user's notification never reaches the owner's Telegram.
    backend::notify::emit_signal(&state, "u2", &signal("schedule.result", "critical", true, "scheduler"))
        .await
        .unwrap();
    assert_eq!(count(), before + 1);
    let (status, body) = request_as(&app, "GET", "/api/notifications/channels", None, Some("tok2")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(channel_row(&body, "telegram")["nextStep"], json!("owner_only"));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn contacts_are_for_the_owner_only() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    for (method, uri, body) in [
        ("GET", "/api/contacts".to_string(), None),
        ("POST", "/api/contacts".to_string(), Some(json!({"displayName": "Eve"}))),
        ("POST", "/api/contacts/merge".to_string(), Some(json!({}))),
        ("POST", "/api/contact-channels/x/verify".to_string(), None),
        ("PATCH", "/api/contact-channels/x".to_string(), Some(json!({"status": "revoked"}))),
    ] {
        let (status, _) = request_as(&app, method, &uri, body, Some("tok2")).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
    }
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn resend_records_a_new_delivery_row() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, _) = app();
    point_adapters_at(&stub_server().await);
    telegram_ready(&app, "6161").await;
    let (_, created) = request(&app, "POST", "/api/notifications/test", None, true).await;
    let delivery_id = created["item"]["deliveryId"].as_str().unwrap().to_string();

    let before = sent_to("telegram", "6161").len();
    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/resend",
        Some(json!({"deliveryId": delivery_id, "channel": "telegram"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("sent"));
    assert_ne!(body["deliveryId"], json!(delivery_id));
    assert_eq!(sent_to("telegram", "6161").len(), before + 1);

    // A channel that is not ready fails cleanly and says what to do.
    let (status, body) = request(
        &app,
        "POST",
        "/api/notifications/channels/resend",
        Some(json!({"deliveryId": delivery_id, "channel": "slack"})),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("failed"));
    assert!(body["error"].as_str().unwrap().contains("Channels page"), "{body}");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn the_bot_token_appears_nowhere_observable() {
    let _guard = env_lock().lock().unwrap_or_else(|e| e.into_inner());
    let (app, root, state) = app();
    point_adapters_at(&stub_server().await);
    telegram_ready(&app, "7171").await;
    let (_, created) = request(&app, "POST", "/api/notifications/test", None, true).await;
    let item_id = created["item"]["id"].as_str().unwrap();
    for uri in [
        "/api/notifications/channels".to_string(),
        "/api/integrations/telegram/config".to_string(),
        "/api/contacts".to_string(),
        format!("/api/notifications/{item_id}/deliveries"),
    ] {
        let (_, body) = request(&app, "GET", &uri, None, true).await;
        assert!(!body.to_string().contains("GOOD-TG-TOKEN"), "{uri} leaked the token");
    }
    // Only the encrypted vault holds it.
    for entry in walk(&state.home) {
        let raw = std::fs::read(&entry).unwrap_or_default();
        assert!(
            !String::from_utf8_lossy(&raw).contains("GOOD-TG-TOKEN"),
            "token in plain text at {}",
            entry.display()
        );
    }
    let _ = std::fs::remove_dir_all(root);
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}
