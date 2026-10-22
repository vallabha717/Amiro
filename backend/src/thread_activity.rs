//! What each chat is doing, for the status marks in the chat list: working
//! (a turn is running), an unseen reply (it finished while the user was
//! elsewhere), or an unseen failure. Vellum's `isProcessing` /
//! `hasUnseenLatestAssistantMessage` pair.
//!
//! Running turns live in memory: a restart ends every turn anyway. Unseen
//! replies are stored in `store/thread-attention.json` so a dot survives a
//! reload until the user opens the chat. Every change is published on the
//! notifications stream as a `thread_activity` event, so the list updates
//! without polling.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::notify::{broadcaster, presence};
use crate::state::{now_iso, read_json, write_json, ApiError, AppState, AuthUser};

/// (user id, thread id) pairs with a turn in flight.
static RUNNING: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();

fn running() -> &'static Mutex<HashSet<(String, String)>> {
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

fn attention_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("thread-attention.json")
}

fn user_id_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn publish(user_id: &str, thread_id: &str, status: &str) {
    broadcaster::publish(json!({
        "type": "thread_activity",
        "userId": user_id,
        "threadId": thread_id,
        "state": status,
    }));
}

/// Whether a turn is running in this thread right now.
pub fn is_running(user_id: &str, thread_id: &str) -> bool {
    running()
        .lock()
        .map(|set| set.contains(&(user_id.to_string(), thread_id.to_string())))
        .unwrap_or(false)
}

/// Marks a thread as working until [`RunningGuard::finish`] or the guard is
/// dropped (the request went away mid-turn), so a chat never stays "working"
/// after its turn is gone.
pub struct RunningGuard {
    user_id: String,
    thread_id: String,
    armed: bool,
}

impl RunningGuard {
    /// Start tracking a turn in `thread_id`.
    pub fn start(user_id: &str, thread_id: &str) -> Self {
        if let Ok(mut set) = running().lock() {
            set.insert((user_id.to_string(), thread_id.to_string()));
        }
        publish(user_id, thread_id, "running");
        Self {
            user_id: user_id.to_string(),
            thread_id: thread_id.to_string(),
            armed: true,
        }
    }

    /// The turn ended. A reply the user was watching is already seen; one
    /// they missed (or a failure) leaves a mark until they open the chat.
    pub async fn finish(mut self, state: &AppState, failed: bool) {
        self.armed = false;
        clear_running(&self.user_id, &self.thread_id);
        let watching = presence::is_thread_focused(&self.user_id, &self.thread_id);
        let status = if watching {
            "idle"
        } else if failed {
            "failed"
        } else {
            "unseen"
        };
        if !watching {
            let _ = record(state, &self.user_id, &self.thread_id, Some(failed)).await;
        }
        publish(&self.user_id, &self.thread_id, status);
    }
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        if self.armed {
            clear_running(&self.user_id, &self.thread_id);
            publish(&self.user_id, &self.thread_id, "idle");
        }
    }
}

fn clear_running(user_id: &str, thread_id: &str) {
    if let Ok(mut set) = running().lock() {
        set.remove(&(user_id.to_string(), thread_id.to_string()));
    }
}

/// `Some(failed)` records an unseen ending; `None` clears the thread's mark.
/// Returns whether anything changed.
async fn record(
    state: &AppState,
    user_id: &str,
    thread_id: &str,
    unseen: Option<bool>,
) -> Result<bool, ApiError> {
    let _guard = state.store.lock().await;
    let path = attention_path(state);
    let mut doc = read_json(&path, json!({ "version": 1, "users": {} })).await?;
    if !doc["users"].is_object() {
        doc["users"] = json!({});
    }
    let users = doc["users"].as_object_mut().expect("users is an object");
    let threads = users
        .entry(user_id.to_string())
        .or_insert_with(|| json!({}));
    if !threads.is_object() {
        *threads = json!({});
    }
    let threads = threads.as_object_mut().expect("threads is an object");
    let changed = match unseen {
        Some(failed) => {
            threads.insert(
                thread_id.to_string(),
                json!({ "endedAt": now_iso(), "failed": failed }),
            );
            true
        }
        None => threads.remove(thread_id).is_some(),
    };
    if changed {
        write_json(&path, &doc).await?;
    }
    Ok(changed)
}

/// The user has the thread on screen: clear its unseen mark.
pub async fn mark_seen(state: &AppState, user_id: &str, thread_id: &str) -> Result<(), ApiError> {
    if record(state, user_id, thread_id, None).await? {
        publish(user_id, thread_id, "idle");
    }
    Ok(())
}

/// Every thread with something to show, for one user.
pub async fn snapshot(state: &AppState, user_id: &str) -> Result<Value, ApiError> {
    let doc = read_json(&attention_path(state), json!({ "users": {} })).await?;
    let running_ids: Vec<String> = running()
        .lock()
        .map(|set| {
            set.iter()
                .filter(|(uid, _)| uid == user_id)
                .map(|(_, tid)| tid.clone())
                .collect()
        })
        .unwrap_or_default();
    let mut unseen = Vec::new();
    let mut failed = Vec::new();
    if let Some(threads) = doc["users"][user_id].as_object() {
        let stored: HashMap<&String, &Value> = threads.iter().collect();
        for (thread_id, entry) in stored {
            if running_ids.contains(thread_id) {
                continue;
            }
            if entry["failed"].as_bool().unwrap_or(false) {
                failed.push(thread_id.clone());
            } else {
                unseen.push(thread_id.clone());
            }
        }
    }
    unseen.sort();
    failed.sort();
    let mut running_sorted = running_ids;
    running_sorted.sort();
    Ok(json!({ "running": running_sorted, "unseen": unseen, "failed": failed }))
}

/// GET /api/thread-activity
async fn get_activity(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(snapshot(&state, &user_id_of(&user)).await?))
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/thread-activity", get(get_activity))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn state() -> AppState {
        let root =
            std::env::temp_dir().join(format!("amiro-thread-activity-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        AppState {
            home,
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("s.sock"),
            workspace: root.join("workspace"),
            runtime_bin: root.join("rt"),
            token: String::new(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn user() -> String {
        format!("user-{}", uuid::Uuid::new_v4())
    }

    #[tokio::test]
    async fn a_running_turn_shows_as_working_then_unseen() {
        let state = state();
        let uid = user();
        let guard = RunningGuard::start(&uid, "t1");
        assert!(is_running(&uid, "t1"));
        assert_eq!(snapshot(&state, &uid).await.unwrap()["running"], json!(["t1"]));

        guard.finish(&state, false).await;
        assert!(!is_running(&uid, "t1"));
        let after = snapshot(&state, &uid).await.unwrap();
        assert_eq!(after["running"], json!([]));
        assert_eq!(after["unseen"], json!(["t1"]));
        assert_eq!(after["failed"], json!([]));
    }

    #[tokio::test]
    async fn a_failed_turn_is_flagged_and_opening_the_chat_clears_it() {
        let state = state();
        let uid = user();
        RunningGuard::start(&uid, "t2").finish(&state, true).await;
        assert_eq!(snapshot(&state, &uid).await.unwrap()["failed"], json!(["t2"]));

        mark_seen(&state, &uid, "t2").await.unwrap();
        let after = snapshot(&state, &uid).await.unwrap();
        assert_eq!(after["failed"], json!([]));
        assert_eq!(after["unseen"], json!([]));
    }

    #[tokio::test]
    async fn a_reply_the_user_watched_leaves_no_mark() {
        let state = state();
        let uid = user();
        presence::report(&uid, "tab", true, Some("t3"));
        RunningGuard::start(&uid, "t3").finish(&state, false).await;
        assert_eq!(snapshot(&state, &uid).await.unwrap()["unseen"], json!([]));
    }

    #[tokio::test]
    async fn a_dropped_turn_stops_working_without_a_mark() {
        let state = state();
        let uid = user();
        drop(RunningGuard::start(&uid, "t4"));
        assert!(!is_running(&uid, "t4"));
        let after = snapshot(&state, &uid).await.unwrap();
        assert_eq!(after["running"], json!([]));
        assert_eq!(after["unseen"], json!([]));
    }
}
