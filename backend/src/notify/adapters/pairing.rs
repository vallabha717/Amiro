//! Conversation pairing for external notifications (Vellum's
//! `conversation-pairing.ts`): the external thread a source already
//! delivered into, so follow-ups for the same schedule or chat land in the
//! same Slack thread or Discord DM instead of starting a new one.
//!
//! Persisted in `store/notification-threads.json`, metadata only:
//!
//! ```json
//! { "version": 1, "threads": {
//!     "u1|slack|D9|sched-1": { "threadId": "1700000000.0001", "updatedAt": "…" } } }
//! ```
//!
//! The key includes the destination, so a guardian who changes their Slack
//! or Discord address starts a fresh thread rather than writing into the old
//! one. Where to deliver is not stored here: that is resolved each time from
//! Channels and Contacts (`notify/destinations.rs`).

use serde_json::{json, Value};

use crate::state::{now_iso, read_json, write_json, ApiError, AppState};

fn path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("notification-threads.json")
}

fn key(user_id: &str, channel: &str, endpoint: &str, source_context_id: &str) -> String {
    format!("{user_id}|{channel}|{endpoint}|{source_context_id}")
}

/// The paired external thread for this source at this destination.
pub async fn get_thread(
    state: &AppState,
    user_id: &str,
    channel: &str,
    endpoint: &str,
    source_context_id: &str,
) -> Result<Option<String>, ApiError> {
    if source_context_id.trim().is_empty() {
        return Ok(None);
    }
    let doc = read_json(&path(state), json!({ "version": 1, "threads": {} })).await?;
    Ok(doc
        .get("threads")
        .and_then(|t| t.get(key(user_id, channel, endpoint, source_context_id)))
        .and_then(|v| v.get("threadId"))
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// Remember the external thread for this source at this destination.
pub async fn save_thread(
    state: &AppState,
    user_id: &str,
    channel: &str,
    endpoint: &str,
    source_context_id: &str,
    thread_id: &str,
) -> Result<(), ApiError> {
    if source_context_id.trim().is_empty() || thread_id.trim().is_empty() {
        return Ok(());
    }
    let _guard = state.store.lock().await;
    let mut doc = read_json(&path(state), json!({ "version": 1, "threads": {} })).await?;
    if !doc.get("threads").is_some_and(Value::is_object) {
        doc["threads"] = json!({});
    }
    doc["threads"][key(user_id, channel, endpoint, source_context_id)] =
        json!({ "threadId": thread_id, "updatedAt": now_iso() });
    write_json(&path(state), &doc).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn state() -> (AppState, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("amiro-pairing-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let state = AppState {
            home,
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("s.sock"),
            workspace: root.join("workspace"),
            runtime_bin: root.join("rt"),
            token: String::new(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        };
        (state, root)
    }

    #[tokio::test]
    async fn a_source_reuses_its_thread_at_the_same_destination_only() {
        let (state, root) = state();
        assert_eq!(get_thread(&state, "u1", "slack", "D9", "sched-1").await.unwrap(), None);
        save_thread(&state, "u1", "slack", "D9", "sched-1", "171.1").await.unwrap();
        assert_eq!(
            get_thread(&state, "u1", "slack", "D9", "sched-1").await.unwrap().as_deref(),
            Some("171.1")
        );
        // Another source, another destination, or another user starts fresh.
        assert_eq!(get_thread(&state, "u1", "slack", "D9", "sched-2").await.unwrap(), None);
        assert_eq!(get_thread(&state, "u1", "slack", "D8", "sched-1").await.unwrap(), None);
        assert_eq!(get_thread(&state, "u2", "slack", "D9", "sched-1").await.unwrap(), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn blank_sources_are_never_paired() {
        let (state, root) = state();
        save_thread(&state, "u1", "slack", "D9", " ", "171.1").await.unwrap();
        assert_eq!(get_thread(&state, "u1", "slack", "D9", " ").await.unwrap(), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
