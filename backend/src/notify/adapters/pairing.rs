//! Channel bindings + conversation pairing (Phase 03).
//!
//! Persisted in `store/notification-channels.json` (metadata only — tokens
//! live in the vault and never appear here):
//!
//! ```json
//! { "version": 1, "bindings": {
//!     "u1:telegram": { "channel": "telegram", "chatId": "123",
//!                      "chatName": "@bot", "updatedAt": "…" },
//!     "u1:slack|thread|sched-1": { "threadId": "1700000000.0001" } }
//! }
//! ```
//!
//! A binding `(user, channel)` records where to deliver. Pairing entries
//! `(user, channel, sourceContextId)` record the external thread id so
//! follow-ups for the same source reuse the thread; a missing thread is
//! recreated by the adapter and re-stored by the caller.

use serde_json::{json, Value};

use crate::state::{read_json, write_json, ApiError, AppState};

/// Channels with external adapters. `local` is the feed, not a binding.
pub const EXTERNAL_CHANNELS: [&str; 3] = ["telegram", "slack", "discord"];

/// Vault slot for a channel's bot token: service `notify.<channel>`.
pub fn vault_service(channel: &str) -> String {
    format!("notify.{channel}")
}

/// Vault field for a channel's bot token.
pub fn vault_field() -> &'static str {
    "bot_token"
}

pub fn is_external_channel(channel: &str) -> bool {
    EXTERNAL_CHANNELS.contains(&channel)
}

fn path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("notification-channels.json")
}

fn empty_doc() -> Value {
    json!({ "version": 1, "bindings": {} })
}

fn bindings_of(doc: &Value) -> serde_json::Map<String, Value> {
    doc.get("bindings")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

fn binding_key(user_id: &str, channel: &str) -> String {
    format!("{user_id}:{channel}")
}

fn thread_key(user_id: &str, channel: &str, source_context_id: &str) -> String {
    format!("{user_id}:{channel}|thread|{source_context_id}")
}

/// Metadata for one bound channel. Never carries a secret.
#[derive(Debug, Clone)]
pub struct Binding {
    pub channel: String,
    pub chat_id: String,
    pub chat_name: Option<String>,
    pub updated_at: String,
}

fn binding_from(channel: &str, value: &Value) -> Option<Binding> {
    Some(Binding {
        channel: channel.to_string(),
        chat_id: value.get("chatId")?.as_str()?.to_string(),
        chat_name: value
            .get("chatName")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        updated_at: value
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Save (or replace) a channel binding. Metadata only.
pub async fn save_binding(
    state: &AppState,
    user_id: &str,
    channel: &str,
    chat_id: &str,
    chat_name: Option<&str>,
) -> Result<Binding, ApiError> {
    if !is_external_channel(channel) {
        return Err(ApiError(
            axum::http::StatusCode::BAD_REQUEST,
            format!(
                "unknown notification channel: {channel} (expected telegram, slack or discord)"
            ),
        ));
    }
    if chat_id.trim().is_empty() {
        return Err(ApiError(
            axum::http::StatusCode::BAD_REQUEST,
            format!("{channel} destination id is required"),
        ));
    }
    let _guard = state.store.lock().await;
    let mut doc = read_json(&path(state), empty_doc()).await?;
    if !doc.is_object() {
        doc = empty_doc();
    }
    let map = doc.as_object_mut().expect("channels doc is an object");
    let entry = map
        .entry("bindings".to_string())
        .or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    let updated_at = crate::state::now_iso();
    entry
        .as_object_mut()
        .expect("bindings is an object")
        .insert(
            binding_key(user_id, channel),
            json!({
                "channel": channel,
                "chatId": chat_id.trim(),
                "chatName": chat_name,
                "updatedAt": updated_at,
            }),
        );
    write_json(&path(state), &doc).await?;
    Ok(Binding {
        channel: channel.to_string(),
        chat_id: chat_id.trim().to_string(),
        chat_name: chat_name.map(str::to_string),
        updated_at,
    })
}

/// The binding for `(user, channel)`, if one was saved.
pub async fn get_binding(
    state: &AppState,
    user_id: &str,
    channel: &str,
) -> Result<Option<Binding>, ApiError> {
    let doc = read_json(&path(state), empty_doc()).await?;
    Ok(bindings_of(&doc)
        .get(&binding_key(user_id, channel))
        .and_then(|v| binding_from(channel, v)))
}

/// Every binding for one user (the channel list response).
pub async fn list_bindings(state: &AppState, user_id: &str) -> Result<Vec<Binding>, ApiError> {
    let doc = read_json(&path(state), empty_doc()).await?;
    let bindings = bindings_of(&doc);
    let mut out = Vec::new();
    for channel in EXTERNAL_CHANNELS {
        if let Some(value) = bindings.get(&binding_key(user_id, channel)) {
            if let Some(binding) = binding_from(channel, value) {
                out.push(binding);
            }
        }
    }
    Ok(out)
}

/// Remove a binding. Returns `true` when something was removed. Thread
/// pairings for the channel are dropped with it.
pub async fn delete_binding(
    state: &AppState,
    user_id: &str,
    channel: &str,
) -> Result<bool, ApiError> {
    let _guard = state.store.lock().await;
    let mut doc = read_json(&path(state), empty_doc()).await?;
    if !doc.is_object() {
        return Ok(false);
    }
    let Some(map) = doc.as_object_mut() else {
        return Ok(false);
    };
    let Some(entries) = map.get_mut("bindings").and_then(|v| v.as_object_mut()) else {
        return Ok(false);
    };
    let removed = entries.remove(&binding_key(user_id, channel)).is_some();
    let prefix = format!("{user_id}:{channel}|thread|");
    let stale: Vec<String> = entries
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for key in stale {
        entries.remove(&key);
    }
    if removed {
        write_json(&path(state), &doc).await?;
    }
    Ok(removed)
}

/// The paired external thread for `(user, channel, sourceContextId)`.
pub async fn get_thread(
    state: &AppState,
    user_id: &str,
    channel: &str,
    source_context_id: &str,
) -> Result<Option<String>, ApiError> {
    if source_context_id.trim().is_empty() {
        return Ok(None);
    }
    let doc = read_json(&path(state), empty_doc()).await?;
    Ok(bindings_of(&doc)
        .get(&thread_key(user_id, channel, source_context_id))
        .and_then(|v| v.get("threadId"))
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

/// Remember the external thread for `(user, channel, sourceContextId)`.
pub async fn save_thread(
    state: &AppState,
    user_id: &str,
    channel: &str,
    source_context_id: &str,
    thread_id: &str,
) -> Result<(), ApiError> {
    if source_context_id.trim().is_empty() || thread_id.trim().is_empty() {
        return Ok(());
    }
    let _guard = state.store.lock().await;
    let mut doc = read_json(&path(state), empty_doc()).await?;
    if !doc.is_object() {
        doc = empty_doc();
    }
    let map = doc.as_object_mut().expect("channels doc is an object");
    let entry = map
        .entry("bindings".to_string())
        .or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    entry
        .as_object_mut()
        .expect("bindings is an object")
        .insert(
            thread_key(user_id, channel, source_context_id),
            json!({ "threadId": thread_id, "updatedAt": crate::state::now_iso() }),
        );
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
            token: "sidecar".into(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        };
        (state, root)
    }

    #[tokio::test]
    async fn save_and_list_bindings() {
        let (state, root) = state();
        assert!(list_bindings(&state, "u1").await.unwrap().is_empty());

        let saved = save_binding(&state, "u1", "telegram", "123", Some("@bot"))
            .await
            .unwrap();
        assert_eq!(saved.chat_id, "123");
        assert_eq!(saved.chat_name.as_deref(), Some("@bot"));

        let listed = list_bindings(&state, "u1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].channel, "telegram");

        // Other users are isolated.
        assert!(list_bindings(&state, "u2").await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn save_rejects_unknown_channels_and_blank_chat() {
        let (state, root) = state();
        assert!(save_binding(&state, "u1", "pigeon", "1", None)
            .await
            .is_err());
        assert!(save_binding(&state, "u1", "local", "1", None)
            .await
            .is_err());
        assert!(save_binding(&state, "u1", "slack", "  ", None)
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn thread_reuse_and_missing_thread_recreation() {
        let (state, root) = state();
        // No thread yet: caller must create one.
        assert_eq!(
            get_thread(&state, "u1", "slack", "sched-1").await.unwrap(),
            None
        );
        // After creation the same source reuses it.
        save_thread(&state, "u1", "slack", "sched-1", "1700.0001")
            .await
            .unwrap();
        assert_eq!(
            get_thread(&state, "u1", "slack", "sched-1")
                .await
                .unwrap()
                .as_deref(),
            Some("1700.0001")
        );
        // A different source gets its own thread.
        assert_eq!(
            get_thread(&state, "u1", "slack", "sched-2").await.unwrap(),
            None
        );
        // Blank ids never persist.
        save_thread(&state, "u1", "slack", "", "1700.0002")
            .await
            .unwrap();
        assert_eq!(get_thread(&state, "u1", "slack", "").await.unwrap(), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn delete_binding_drops_pairings() {
        let (state, root) = state();
        save_binding(&state, "u1", "discord", "u9", None)
            .await
            .unwrap();
        save_thread(&state, "u1", "discord", "src-1", "chan-7")
            .await
            .unwrap();
        assert!(delete_binding(&state, "u1", "discord").await.unwrap());
        assert!(!delete_binding(&state, "u1", "discord").await.unwrap());
        assert!(get_binding(&state, "u1", "discord")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            get_thread(&state, "u1", "discord", "src-1").await.unwrap(),
            None
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn vault_slots_are_stable() {
        assert_eq!(vault_service("telegram"), "notify.telegram");
        assert_eq!(vault_service("slack"), "notify.slack");
        assert_eq!(vault_service("discord"), "notify.discord");
        assert_eq!(vault_field(), "bot_token");
    }
}
