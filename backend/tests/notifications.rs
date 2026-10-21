//! End-to-end tests for the Vellum-style notification backend: persistence,
//! delivery policy, the SSE stream, and every registered route.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use backend::routes::router;
use backend::state::AppState;
use futures::StreamExt;
use serde_json::{json, Value};
use tower::ServiceExt;

fn app() -> (axum::Router, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("amiro-notify-{}", uuid::Uuid::new_v4()));
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
    (router().with_state(state), root)
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

#[tokio::test]
async fn notifications_require_auth() {
    let (app, root) = app();
    let (status, _) = request(&app, "GET", "/api/notifications", None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = request(&app, "POST", "/api/notifications", Some(json!({})), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn empty_feed_reports_version_two_and_default_settings() {
    let (app, root) = app();
    let (status, body) = request(&app, "GET", "/api/notifications", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["version"], json!(2));
    assert_eq!(body["items"], json!([]));
    assert_eq!(body["unreadCount"], json!(0));
    assert!(body["updatedAt"].is_string());
    assert_eq!(body["settings"]["enabled"], json!(true));
    assert_eq!(body["settings"]["allAlertsEnabled"], json!(true));
    assert_eq!(body["settings"]["quietStart"], json!("22:00"));
    assert_eq!(body["settings"]["quietEnd"], json!("08:00"));

    // Settings endpoint returns the same defaults.
    let (status, settings) = request(&app, "GET", "/api/notifications/settings", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(settings["webPushEnabled"], json!(true));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn create_persists_and_upserts_in_place() {
    let (app, root) = app();
    let (status, created) = request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({
            "id": "fixed-id",
            "title": "Reply ready",
            "body": "Your assistant answered.",
            "category": "chat_reply",
            "urgency": "high",
            "threadId": "thread-1",
            "sourceEventName": "chat.assistant_reply",
        })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["unreadCount"], json!(1));
    let item = &created["item"];
    assert_eq!(item["id"], json!("fixed-id"));
    assert_eq!(item["userId"], json!("u1"));
    assert_eq!(item["status"], json!("new"));
    assert_eq!(item["silent"], json!(false));
    assert_eq!(item["category"], json!("chat_reply"));
    assert_eq!(item["threadId"], json!("thread-1"));
    assert_eq!(item["actions"][0]["id"], json!("view"));
    assert!(item["createdAt"].is_string());
    assert!(item["ackedAt"].is_null());

    // Newest-first: a second, different notification goes to the front.
    let (_, second) = request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "id": "second", "title": "Second", "category": "system" })),
        true,
    )
    .await;
    assert_eq!(second["unreadCount"], json!(2));

    // Same id replaces in place (no duplicate, position preserved).
    let (status, replaced) = request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "id": "fixed-id", "title": "Reply edited", "category": "chat_reply" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(replaced["item"]["title"], json!("Reply edited"));

    let (_, feed) = request(&app, "GET", "/api/notifications", None, true).await;
    let items = feed["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    // The feed lists newest-first by updatedAt: the just-replaced item leads.
    assert_eq!(items[0]["id"], json!("fixed-id"));
    assert_eq!(items[0]["title"], json!("Reply edited"));
    assert_eq!(items[1]["id"], json!("second"));
    assert_eq!(feed["unreadCount"], json!(2));

    // Rejects unknown enums.
    let (status, _) = request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "title": "bad", "category": "nope" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn patch_mark_all_read_and_clear_all() {
    let (app, root) = app();
    for id in ["a", "b"] {
        request(
            &app,
            "POST",
            "/api/notifications",
            Some(json!({ "id": id, "title": id, "category": "system" })),
            true,
        )
        .await;
    }

    // PATCH to seen drops the unread count.
    let (status, patched) = request(
        &app,
        "PATCH",
        "/api/notifications/a",
        Some(json!({ "status": "seen" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patched["item"]["status"], json!("seen"));
    assert_eq!(patched["unreadCount"], json!(1));

    // PUT is an alias and can edit title/body.
    let (status, edited) = request(
        &app,
        "PUT",
        "/api/notifications/b",
        Some(json!({ "title": "Edited", "body": "New body" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["item"]["title"], json!("Edited"));
    assert_eq!(edited["item"]["body"], json!("New body"));

    // Unknown id -> 404, invalid status -> 400.
    let (status, _) = request(
        &app,
        "PATCH",
        "/api/notifications/missing",
        Some(json!({ "status": "seen" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        &app,
        "PATCH",
        "/api/notifications/a",
        Some(json!({ "status": "bogus" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // mark-all-read marks everything seen.
    let (status, marked) =
        request(&app, "POST", "/api/notifications/mark-all-read", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(marked["unreadCount"], json!(0));

    // unreadOnly filter now returns nothing.
    let (_, unread) = request(
        &app,
        "GET",
        "/api/notifications?unreadOnly=true",
        None,
        true,
    )
    .await;
    assert_eq!(unread["items"], json!([]));

    // clear-all dismisses and the default list hides dismissed items.
    let (status, cleared) = request(&app, "POST", "/api/notifications/clear-all", None, true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cleared["unreadCount"], json!(0));
    assert_eq!(cleared["cleared"], json!(2));

    let (_, visible) = request(&app, "GET", "/api/notifications", None, true).await;
    assert_eq!(visible["items"], json!([]));
    let (_, all) = request(
        &app,
        "GET",
        "/api/notifications?includeDismissed=true",
        None,
        true,
    )
    .await;
    assert_eq!(all["items"].as_array().unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn ack_records_delivery_receipt() {
    let (app, root) = app();
    request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "id": "n1", "title": "Hello", "category": "system" })),
        true,
    )
    .await;
    let (status, acked) = request(
        &app,
        "POST",
        "/api/notifications/n1/ack",
        Some(json!({ "delivered": true, "receiptClass": "desktop_native" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(acked["delivered"], json!(true));
    assert_eq!(acked["receiptClass"], json!("desktop_native"));
    assert_eq!(acked["item"]["deliveryReceipt"], json!("desktop_native"));
    assert!(acked["item"]["ackedAt"].is_string());
    // Phase 02: the ack appends to `receipts[]`, one row per surface.
    assert_eq!(acked["item"]["receipts"].as_array().unwrap().len(), 1);
    assert_eq!(
        acked["item"]["receipts"][0]["receiptClass"],
        json!("desktop_native")
    );
    assert!(acked["item"]["receipts"][0]["deliveredAt"].is_string());

    let (_, acked_again) = request(
        &app,
        "POST",
        "/api/notifications/n1/ack",
        Some(json!({ "delivered": true, "receiptClass": "in_app_toast" })),
        true,
    )
    .await;
    assert_eq!(acked_again["item"]["receipts"].as_array().unwrap().len(), 2);
    assert_eq!(
        acked_again["item"]["receipts"][1]["receiptClass"],
        json!("in_app_toast")
    );

    let (status, _) = request(
        &app,
        "POST",
        "/api/notifications/n1/ack",
        Some(json!({ "delivered": true, "receiptClass": "carrier_pigeon" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn settings_disable_forces_silent() {
    let (app, root) = app();
    let (status, updated) = request(
        &app,
        "PUT",
        "/api/notifications/settings",
        Some(json!({ "enabled": false, "quietStart": "23:30" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["enabled"], json!(false));
    assert_eq!(updated["quietStart"], json!("23:30"));
    assert_eq!(updated["quietEnd"], json!("08:00"));

    let (_, created) = request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "title": "Quiet", "category": "chat_reply", "urgency": "critical" })),
        true,
    )
    .await;
    assert_eq!(created["item"]["silent"], json!(true));

    // Re-enable with all alerts off and a non-audible category -> silent.
    request(
        &app,
        "PUT",
        "/api/notifications/settings",
        Some(json!({ "enabled": true, "allAlertsEnabled": false })),
        true,
    )
    .await;
    let (_, quiet) = request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "title": "System", "category": "system", "urgency": "low" })),
        true,
    )
    .await;
    assert_eq!(quiet["item"]["silent"], json!(true));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn test_endpoint_emits_real_notification() {
    let (app, root) = app();
    let (status, res) = request(&app, "POST", "/api/notifications/test", None, true).await;
    assert_eq!(status, StatusCode::CREATED);
    let item = &res["item"];
    assert_eq!(item["title"], json!("Amiro Test Notification"));
    assert_eq!(
        item["body"],
        json!("Notifications are working across Web UI and Desktop.")
    );
    assert_eq!(item["category"], json!("system"));
    assert_eq!(item["urgency"], json!("high"));
    assert_eq!(item["sourceEventName"], json!("system.test"));

    let (_, feed) = request(&app, "GET", "/api/notifications", None, true).await;
    assert_eq!(feed["unreadCount"], json!(1));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn emit_notification_helper_persists_without_http() {
    let (app, root) = app();
    let (_, _) = request(&app, "GET", "/api/notifications", None, true).await;
    // Reach into the same home the router was built with by constructing state
    // from the env the harness wrote. Instead, drive it through a fresh state
    // pointing at that home.
    let home = root.join("home");
    let state = AppState {
        home: home.clone(),
        runtime_home: root.join("runtime"),
        runtime_socket: root.join("s.sock"),
        workspace: root.join("workspace"),
        runtime_bin: root.join("rt"),
        token: "sidecar".into(),
        store: Arc::new(tokio::sync::Mutex::new(())),
    };
    let item = backend::routes::notifications::emit_notification(
        &state,
        "u1",
        "Schedule finished",
        "Your morning briefing completed.",
        "schedule_result",
        "normal",
        None,
        Some("sched-9".to_string()),
        "schedule.result",
    )
    .await
    .unwrap();
    assert_eq!(item["category"], json!("schedule_result"));
    assert_eq!(item["scheduleId"], json!("sched-9"));

    let (_, feed) = request(&app, "GET", "/api/notifications", None, true).await;
    assert_eq!(feed["unreadCount"], json!(1));
    assert_eq!(
        feed["items"][0]["sourceEventName"],
        json!("schedule.result")
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn stream_sends_snapshot_then_live_events() {
    let (app, root) = app();
    // Seed one unread item so the snapshot is non-zero.
    request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "id": "seed", "title": "Seed", "category": "system" })),
        true,
    )
    .await;

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/notifications/stream")
                .header("authorization", "Bearer tok")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        content_type.contains("text/event-stream"),
        "unexpected content-type: {content_type}"
    );

    let mut stream = res.into_body().into_data_stream();
    let first = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("snapshot timed out")
        .unwrap()
        .unwrap();
    let first_text = String::from_utf8_lossy(&first);
    assert!(
        first_text.contains("\"type\":\"snapshot\""),
        "got: {first_text}"
    );
    assert!(
        first_text.contains("\"unreadCount\":1"),
        "got: {first_text}"
    );

    // A new notification must be pushed live onto the open stream. Other tests
    // share the process-wide broadcast channel, so skip any unrelated frames
    // until we see our own `live` notification (bounded by an overall timeout).
    request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "id": "live", "title": "Live", "category": "system" })),
        true,
    )
    .await;

    let mut saw_live = false;
    for _ in 0..20 {
        let frame = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("live event timed out")
            .unwrap()
            .unwrap();
        let text = String::from_utf8_lossy(&frame).to_string();
        if text.contains("notification_intent") && text.contains("\"live\"") {
            saw_live = true;
            break;
        }
    }
    assert!(saw_live, "live notification_intent was not streamed");

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn deliveries_endpoint_returns_per_channel_rows() {
    let (app, root) = app();
    // Unknown id is a clean 404, never an exception; auth runs first.
    let (status, _) = request(
        &app,
        "GET",
        "/api/notifications/nope/deliveries",
        None,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        &app,
        "GET",
        "/api/notifications/nope/deliveries",
        None,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, created) = request(
        &app,
        "POST",
        "/api/notifications",
        Some(json!({ "id": "n-del", "title": "T", "body": "B", "category": "system" })),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let delivery_id = created["item"]["deliveryId"].as_str().unwrap().to_string();

    // Seed rows the way the broadcaster + resend path write them: same
    // delivery id per broadcast, a new delivery id under the same signal
    // for resends, plus rows that must not leak in (other item, other user).
    let row = |delivery_id: &str, signal_id: &str, user_id: &str, channel: &str, status: &str| {
        json!({
            "deliveryId": delivery_id,
            "signalId": signal_id,
            "userId": user_id,
            "channel": channel,
            "status": status,
            "error": null,
            "recordedAt": "2026-10-21T00:00:00Z",
        })
    };
    std::fs::create_dir_all(root.join("home").join("store")).unwrap();
    std::fs::write(
        root.join("home").join("store").join("notification-deliveries.json"),
        json!({ "version": 1, "rows": [
            row(&delivery_id, "sig-1", "u1", "local", "sent"),
            row(&delivery_id, "sig-1", "u1", "telegram", "failed"),
            row("d-resend", "sig-1", "u1", "telegram", "sent"),
            row("d-other", "sig-9", "u1", "local", "sent"),
            row(&delivery_id, "sig-1", "u2", "local", "sent"),
        ]})
        .to_string(),
    )
    .unwrap();

    let (status, body) = request(
        &app,
        "GET",
        "/api/notifications/n-del/deliveries",
        None,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let deliveries = body["deliveries"].as_array().unwrap();
    // local + failed telegram + the resend row (same signal). Nothing else.
    assert_eq!(deliveries.len(), 3, "unexpected rows: {deliveries:?}");
    assert!(deliveries.iter().all(|d| d["signalId"] == json!("sig-1")));

    let _ = std::fs::remove_dir_all(root);
}
