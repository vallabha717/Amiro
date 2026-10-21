//! Phase 00: signal → decision → delivery row → SSE intent, with dedupe,
//! urgency aliasing, and input validation.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use backend::notify::{emit_signal, subscribe};
use backend::state::AppState;

fn state() -> (AppState, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("amiro-notify-pipe-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
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

fn rows(home: &std::path::Path, file: &str) -> Vec<Value> {
    // Rejected signals write nothing, so a missing file means zero rows.
    let raw = match std::fs::read_to_string(home.join("store").join(file)) {
        Ok(raw) => raw,
        Err(_) => return vec![],
    };
    serde_json::from_str::<Value>(&raw).unwrap()["rows"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn signal() -> Value {
    json!({
        "sourceChannel": "scheduler",
        "sourceContextId": "sched-1",
        "sourceEventName": "schedule.result",
        "title": "Nightly backup",
        "body": "Backup finished in 42s.",
        "urgency": "high",
        "scheduleId": "sched-1",
    })
}

#[tokio::test]
async fn emit_flows_from_signal_to_sse_intent() {
    let (state, root) = state();
    let mut receiver = subscribe();
    let out = emit_signal(&state, "u1", &signal()).await.unwrap();

    assert_eq!(out["duplicate"], json!(false));
    let delivery_id = out["deliveryId"].as_str().unwrap().to_string();
    assert!(!delivery_id.is_empty());
    assert_eq!(out["decision"]["shouldNotify"], json!(true));
    assert_eq!(out["decision"]["channels"], json!(["local"]));
    assert_eq!(out["decision"]["fallbackUsed"], json!(true));
    assert_eq!(out["item"]["title"], json!("Nightly backup"));
    assert_eq!(out["item"]["category"], json!("schedule_result"));
    assert_eq!(out["unreadCount"], json!(1));

    // One audit row per file.
    assert_eq!(rows(&state.home, "notification-events.json").len(), 1);
    assert_eq!(rows(&state.home, "notification-decisions.json").len(), 1);
    let deliveries = rows(&state.home, "notification-deliveries.json");
    assert_eq!(deliveries.len(), 1);
    assert_eq!(deliveries[0]["channel"], json!("local"));
    assert_eq!(deliveries[0]["status"], json!("sent"));
    assert_eq!(deliveries[0]["deliveryId"], json!(delivery_id));

    // The SSE fan-out carried the intent with the same delivery id. The
    // broadcast channel is process-wide, so parallel tests may deliver
    // other intents first — skip until ours arrives.
    let event = wait_for_intent(&mut receiver, &delivery_id).await;
    assert_eq!(event["type"], json!("notification_intent"));
    assert_eq!(event["userId"], json!("u1"));
    assert_eq!(event["deliveryId"], json!(delivery_id));
    // Phase 02: the intent carries the deep-link target, and the feed item
    // carries the same delivery id.
    assert_eq!(
        event["deepLinkTarget"],
        json!({ "threadId": Value::Null, "scheduleId": "sched-1" })
    );
    assert_eq!(event["notification"]["deliveryId"], json!(delivery_id));

    let _ = std::fs::remove_dir_all(root);
}

/// Wait for the intent with `delivery_id` on a process-wide broadcast
/// channel shared with parallel tests.
async fn wait_for_intent(
    receiver: &mut tokio::sync::broadcast::Receiver<Value>,
    delivery_id: &str,
) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let event = tokio::time::timeout(remaining, receiver.recv())
            .await
            .expect("intent arrives")
            .unwrap();
        if event.get("deliveryId") == Some(&json!(delivery_id)) {
            return event;
        }
    }
}

/// The exact signal shape `chat.rs` builds for an assistant reply.
fn chat_signal(thread_id: &str) -> Value {
    json!({
        "sourceChannel": "assistant_tool",
        "sourceContextId": thread_id,
        "sourceEventName": "chat.assistant_reply",
        "title": "Thread title",
        "body": "Here is the reply preview.",
        "urgency": "normal",
        "threadId": thread_id,
        "attentionHints": {
            "requiresAction": false,
            "isAsyncBackground": false,
            "visibleInSourceNow": true,
        },
        "routingIntent": "single_channel",
    })
}

/// The exact signal shape `schedules.rs` builds in `finalize`.
fn schedule_signal(status: &str, run_id: &str) -> Value {
    let urgency = if status == "failed" { "high" } else { "normal" };
    let requires_action = status == "failed";
    json!({
        "sourceChannel": "scheduler",
        "sourceContextId": "sched-9",
        "sourceEventName": "schedule.result",
        "title": "Morning briefing",
        "body": "Your morning briefing completed.",
        "urgency": urgency,
        "threadId": "thread-9",
        "scheduleId": "sched-9",
        "dedupeKey": format!("schedule-run-{run_id}"),
        "attentionHints": {
            "requiresAction": requires_action,
            "isAsyncBackground": true,
            "visibleInSourceNow": false,
        },
        "routingIntent": "single_channel",
    })
}

/// The exact signal shape `heartbeat.rs` builds for a heartbeat message.
fn heartbeat_signal(thread_id: &str) -> Value {
    json!({
        "sourceChannel": "watcher",
        "sourceContextId": thread_id,
        "sourceEventName": "heartbeat.message",
        "title": "Amiro heartbeat",
        "body": "Something needs your attention.",
        "urgency": "normal",
        "threadId": thread_id,
        "attentionHints": {
            "requiresAction": false,
            "isAsyncBackground": true,
            "visibleInSourceNow": false,
        },
        "routingIntent": "single_channel",
    })
}

#[tokio::test]
async fn chat_reply_signal_reaches_the_thread_feed() {
    let (state, root) = state();
    let mut receiver = subscribe();
    let out = emit_signal(&state, "u1", &chat_signal("thread-7"))
        .await
        .unwrap();
    let delivery_id = out["deliveryId"].as_str().unwrap().to_string();

    assert_eq!(out["item"]["category"], json!("chat_reply"));
    assert_eq!(out["item"]["threadId"], json!("thread-7"));
    assert_eq!(out["item"]["deliveryId"], json!(delivery_id));

    let event = wait_for_intent(&mut receiver, &delivery_id).await;
    assert_eq!(
        event["deepLinkTarget"],
        json!({ "threadId": "thread-7", "scheduleId": Value::Null })
    );

    // Exactly one delivery row per signal (migration risk: double delivery).
    assert_eq!(rows(&state.home, "notification-deliveries.json").len(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn schedule_result_signal_flags_failures_for_action() {
    let (state, root) = state();
    let mut receiver = subscribe();
    let out = emit_signal(&state, "u1", &schedule_signal("failed", "run-1"))
        .await
        .unwrap();
    let delivery_id = out["deliveryId"].as_str().unwrap().to_string();

    assert_eq!(out["item"]["category"], json!("schedule_result"));
    assert_eq!(out["item"]["scheduleId"], json!("sched-9"));
    assert_eq!(out["item"]["urgency"], json!("high"));

    let event = wait_for_intent(&mut receiver, &delivery_id).await;
    assert_eq!(
        event["deepLinkTarget"],
        json!({ "threadId": "thread-9", "scheduleId": "sched-9" })
    );

    // A retried finalize carries the same run id: one delivery row, no dup.
    let retry = emit_signal(&state, "u1", &schedule_signal("failed", "run-1"))
        .await
        .unwrap();
    assert_eq!(retry["duplicate"], json!(true));
    assert_eq!(retry["deliveryId"], json!(delivery_id));
    assert_eq!(rows(&state.home, "notification-deliveries.json").len(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn heartbeat_signal_reaches_the_thread_feed() {
    let (state, root) = state();
    let mut receiver = subscribe();
    let out = emit_signal(&state, "u1", &heartbeat_signal("thread-hb"))
        .await
        .unwrap();
    let delivery_id = out["deliveryId"].as_str().unwrap().to_string();

    assert_eq!(out["item"]["category"], json!("heartbeat"));
    assert_eq!(out["item"]["threadId"], json!("thread-hb"));

    let event = wait_for_intent(&mut receiver, &delivery_id).await;
    assert_eq!(
        event["deepLinkTarget"],
        json!({ "threadId": "thread-hb", "scheduleId": Value::Null })
    );
    assert_eq!(rows(&state.home, "notification-deliveries.json").len(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn no_emitter_calls_the_old_direct_persist_path() {
    // Phase 02 exit criterion: the three emitters call exactly one path
    // (`notify::emit_signal`); the compat helper stays but has no in-tree
    // callers. Paths resolve from the backend package root; fall back to a
    // workspace-root-relative lookup.
    let candidates = ["src/chat.rs", "src/schedules.rs", "src/heartbeat.rs"];
    for file in candidates {
        let source = ["src", "backend/src"]
            .iter()
            .map(|base| std::path::PathBuf::from(base).join(file.strip_prefix("src/").unwrap()))
            .find_map(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_else(|| panic!("cannot read emitter source for {file}"));
        assert!(
            !source.contains("routes::notifications::emit_notification"),
            "{file} still calls the old direct-persist path"
        );
    }
    let chat = ["src/chat.rs", "backend/src/chat.rs"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .unwrap();
    let schedules = ["src/schedules.rs", "backend/src/schedules.rs"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .unwrap();
    let heartbeat = ["src/heartbeat.rs", "backend/src/heartbeat.rs"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .unwrap();
    for (file, source) in [
        ("src/chat.rs", chat.as_str()),
        ("src/schedules.rs", schedules.as_str()),
        ("src/heartbeat.rs", heartbeat.as_str()),
    ] {
        assert!(
            source.contains("notify::emit_signal"),
            "{file} does not emit through the signal pipeline"
        );
    }
}

#[tokio::test]
async fn dedupe_key_claims_the_signal_once() {
    let (state, root) = state();
    let mut body = signal();
    body["dedupeKey"] = json!("backup-2026-10-21");

    let first = emit_signal(&state, "u1", &body).await.unwrap();
    assert_eq!(first["duplicate"], json!(false));
    let second = emit_signal(&state, "u1", &body).await.unwrap();
    assert_eq!(second["duplicate"], json!(true));
    assert_eq!(second["deliveryId"], first["deliveryId"]);
    assert_eq!(
        second["decision"]["shouldNotify"],
        first["storedDecision"]["shouldNotify"]
    );

    // The second emit wrote no new rows anywhere.
    assert_eq!(rows(&state.home, "notification-events.json").len(), 1);
    assert_eq!(rows(&state.home, "notification-decisions.json").len(), 1);
    assert_eq!(rows(&state.home, "notification-deliveries.json").len(), 1);

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn medium_urgency_persists_as_normal() {
    let (state, root) = state();
    let mut body = signal();
    body["urgency"] = json!("medium");
    let out = emit_signal(&state, "u1", &body).await.unwrap();
    assert_eq!(out["item"]["urgency"], json!("normal"));
    assert_eq!(
        rows(&state.home, "notification-events.json")[0]["urgency"],
        json!("normal")
    );

    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn bad_signals_are_rejected() {
    let (state, root) = state();

    let mut unknown_channel = signal();
    unknown_channel["sourceChannel"] = json!("pigeon");
    let err = emit_signal(&state, "u1", &unknown_channel)
        .await
        .unwrap_err();
    assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);

    let mut unknown_urgency = signal();
    unknown_urgency["urgency"] = json!("extreme");
    let err = emit_signal(&state, "u1", &unknown_urgency)
        .await
        .unwrap_err();
    assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);

    let mut missing_title_channel = signal();
    missing_title_channel["sourceChannel"] = Value::Null;
    let err = emit_signal(&state, "u1", &missing_title_channel)
        .await
        .unwrap_err();
    assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);

    let err = emit_signal(&state, "  ", &signal()).await.unwrap_err();
    assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);

    // Rejected signals leave no audit rows.
    assert!(rows(&state.home, "notification-events.json").is_empty());

    let _ = std::fs::remove_dir_all(root);
}
