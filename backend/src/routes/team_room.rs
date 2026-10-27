//! The Huddle (the "team room" in code): one shared conversation between a
//! user and every agent on the team, where the agents also talk to each other.
//!
//! Each agent already has a private 1:1 channel thread (`agents.rs`). The room
//! is separate: a log of messages per user plus one runtime session per agent
//! that answers in the room. Routing is by @mention, like a team chat:
//!
//! - A user's message goes to every agent it @mentions (`@all` for everyone),
//!   or to the main agent when it mentions none.
//! - An agent's reply is posted to the room, and any teammate it @mentions gets
//!   it as their next message. That is how agents hand work to each other, and
//!   every hand-off is visible in the room.
//! - An answer to a hand-off also goes back to the agent that asked, so it can
//!   finish the job with it ([`reply_targets`]).
//! - A chain of agent-to-agent hand-offs stops after [`MAX_HOPS`] replies, so
//!   two agents can never keep answering each other forever.
//!
//! An agent answers one room message at a time; later ones wait their turn.
//! The browser polls `GET /api/team/room` while anyone is working.
//!
//! - `GET  /api/team/room`  the caller's room: recent messages, who is working
//! - `POST /api/team/room`  `{text}` post a message as the caller

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::routes::agents::{roster, MAIN_AGENT_ID};
use crate::state::{now_iso, read_json, write_json, ApiError, AppState, AuthUser};

/// Agent replies in one chain before mentions stop being delivered.
pub const MAX_HOPS: u64 = 4;
const MAX_TEXT_CHARS: usize = 4000;
const MAX_REPLY_CHARS: usize = 8000;
const MAX_STORED: usize = 500;
const MAX_LISTED: usize = 200;
const CONTEXT_MESSAGES: usize = 12;
const CONTEXT_CHARS: usize = 600;

type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

fn room_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("team-room.json")
}

fn user_id(user: &AuthUser) -> String {
    user.0.get("id").and_then(Value::as_str).unwrap_or("").to_string()
}

fn user_name(user: &AuthUser) -> String {
    user.0
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("You")
        .to_string()
}

fn agent_key(uid: &str, agent_id: &str) -> String {
    format!("{uid}/{agent_id}")
}

/// Agents answering a room message right now, as `uid/agent` keys.
fn working() -> &'static StdMutex<HashSet<String>> {
    static WORKING: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    WORKING.get_or_init(Default::default)
}

/// One lock per `uid/agent`, so an agent answers one room message at a time.
fn agent_lock(uid: &str, agent_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap();
    locks.entry(agent_key(uid, agent_id)).or_default().clone()
}

/// Marks an agent as working for as long as it lives.
struct WorkingGuard(String);
impl WorkingGuard {
    fn new(uid: &str, agent_id: &str) -> Self {
        let key = agent_key(uid, agent_id);
        working().lock().unwrap().insert(key.clone());
        Self(key)
    }
}
impl Drop for WorkingGuard {
    fn drop(&mut self) {
        working().lock().unwrap().remove(&self.0);
    }
}

fn working_for(uid: &str) -> Vec<String> {
    let prefix = format!("{uid}/");
    let mut ids: Vec<String> = working()
        .lock()
        .unwrap()
        .iter()
        .filter_map(|key| key.strip_prefix(&prefix).map(str::to_string))
        .collect();
    ids.sort();
    ids
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/// Ids of every agent `text` @mentions (`agents` is `(id, name)` pairs), in roster order. A mention is
/// `@` + the agent's name or id, case-insensitive, not followed by a letter or
/// digit. `@all`, `@everyone` and `@team` name every agent when `allow_all`.
pub fn find_mentions(text: &str, agents: &[(String, String)], allow_all: bool) -> Vec<String> {
    let lower = text.to_lowercase();
    let mentioned = |handle: &str| -> bool {
        let needle = format!("@{}", handle.to_lowercase());
        if handle.trim().is_empty() {
            return false;
        }
        lower.match_indices(&needle).any(|(at, _)| {
            lower[at + needle.len()..]
                .chars()
                .next()
                .map(|c| !(c.is_alphanumeric() || c == '_'))
                .unwrap_or(true)
        })
    };
    if allow_all && ["all", "everyone", "team"].iter().any(|h| mentioned(h)) {
        return agents.iter().map(|(id, _)| id.clone()).collect();
    }
    agents
        .iter()
        .filter(|(id, name)| mentioned(name) || mentioned(id))
        .map(|(id, _)| id.clone())
        .collect()
}

/// Who an agent's reply goes to: the teammates it @mentions, plus the agent
/// that asked, when `message` was a teammate's hand-off. Without the second,
/// the asking agent would never see the answer it asked for.
pub fn reply_targets(mut mentions: Vec<String>, message: &Value, agent_id: &str) -> Vec<String> {
    if message["from"]["type"] == "agent" {
        if let Some(asker) = message["from"]["id"].as_str() {
            if asker != agent_id && !mentions.iter().any(|m| m == asker) {
                mentions.push(asker.to_string());
            }
        }
    }
    mentions
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async fn read_room(state: &AppState, uid: &str) -> Result<Value, ApiError> {
    let doc = read_json(&room_path(state), json!({"rooms": {}})).await?;
    Ok(doc["rooms"].get(uid).cloned().unwrap_or_else(|| json!({"messages": [], "sessions": {}})))
}

/// Read-modify-write the caller's room under the store lock.
async fn update_room<T>(
    state: &AppState,
    uid: &str,
    change: impl FnOnce(&mut Value) -> T,
) -> Result<T, ApiError> {
    let _guard = state.store.lock().await;
    let path = room_path(state);
    let mut doc = read_json(&path, json!({"rooms": {}})).await?;
    if !doc["rooms"].is_object() {
        doc["rooms"] = json!({});
    }
    let room = &mut doc["rooms"][uid];
    if !room.is_object() {
        *room = json!({"messages": [], "sessions": {}});
    }
    let out = change(room);
    if let Some(list) = room["messages"].as_array_mut() {
        if list.len() > MAX_STORED {
            let drop = list.len() - MAX_STORED;
            list.drain(..drop);
        }
    }
    write_json(&path, &doc).await?;
    Ok(out)
}

async fn append(state: &AppState, uid: &str, message: Value) -> Result<Value, ApiError> {
    update_room(state, uid, |room| {
        match room["messages"].as_array_mut() {
            Some(list) => list.push(message.clone()),
            None => room["messages"] = json!([message.clone()]),
        }
        message
    })
    .await
}

fn new_message(from: Value, to: &[String], text: &str, hop: u64) -> Value {
    json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "from": from,
        "to": to,
        "text": text,
        "hop": hop,
        "createdAt": now_iso(),
    })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async fn get_room(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let room = read_room(&state, &uid).await?;
    let messages = room["messages"].as_array().cloned().unwrap_or_default();
    let start = messages.len().saturating_sub(MAX_LISTED);
    Ok(Json(json!({
        "messages": messages[start..],
        "working": working_for(&uid),
        "maxHops": MAX_HOPS,
    })))
}

async fn post_room(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let text = body.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Write a message first.".into()));
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("Keep a room message under {MAX_TEXT_CHARS} characters."),
        ));
    }
    let agents = roster(&state, &uid).await?;
    let handles: Vec<(String, String)> = agents
        .iter()
        .map(|a| (a["id"].as_str().unwrap_or("").to_string(), a["name"].as_str().unwrap_or("").to_string()))
        .collect();
    let mut targets = find_mentions(&text, &handles, true);
    if targets.is_empty() {
        targets.push(MAIN_AGENT_ID.to_string());
    }
    let sender = user_name(&user);
    let message = append(
        &state,
        &uid,
        new_message(json!({"type": "user", "id": uid, "name": sender}), &targets, &text, 0),
    )
    .await?;
    for target in targets {
        tokio::spawn(deliver(state.clone(), uid.clone(), target, message.clone()));
    }
    Ok(Json(json!({ "message": message })))
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/team/room", get(get_room).post(post_room))
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

fn sender_name(message: &Value) -> String {
    message["from"]["name"].as_str().unwrap_or("Someone").to_string()
}

fn transcript_line(message: &Value, names: &HashMap<String, String>) -> String {
    let to: Vec<String> = message["to"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(|id| names.get(id).cloned().unwrap_or_else(|| id.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let arrow = if to.is_empty() { String::new() } else { format!(" → {}", to.join(", ")) };
    let text = clip(message["text"].as_str().unwrap_or(""), CONTEXT_CHARS);
    format!("- {}{arrow}: {text}", sender_name(message))
}

/// What the agent is told besides the message itself: who is in the room,
/// how to hand work to a teammate, and the latest room messages.
fn room_reminder(me: &Value, agents: &[Value], person: &str, recent: &[Value], hops_left: u64) -> String {
    let me_id = me["id"].as_str().unwrap_or("");
    let names: HashMap<String, String> = agents
        .iter()
        .map(|a| (a["id"].as_str().unwrap_or("").to_string(), a["name"].as_str().unwrap_or("").to_string()))
        .collect();
    let teammates: Vec<String> = agents
        .iter()
        .filter(|a| a["id"].as_str() != Some(me_id))
        .map(|a| {
            let role = a["role"].as_str().filter(|r| !r.trim().is_empty()).unwrap_or("teammate");
            format!("- @{} — {role}", a["name"].as_str().unwrap_or(""))
        })
        .collect();
    let mut out = format!(
        "You are {} in the Huddle, a group chat with {person} and your teammates. \
         Everything you reply is posted to the Huddle for everyone to read.\n",
        me["name"].as_str().unwrap_or("an agent"),
    );
    if teammates.is_empty() {
        out.push_str("You have no teammates yet.\n");
    } else {
        out.push_str(&format!("Teammates:\n{}\n", teammates.join("\n")));
        if hops_left > 0 {
            out.push_str(
                "To ask a teammate for something, @mention them by name in your reply and say exactly \
                 what you need; their answer comes back to you, so you can finish the job with it. \
                 When a teammate asks you something, just answer; your reply goes back to them. \
                 Mention a teammate only when you need their help, never just to thank or \
                 acknowledge them.\n",
            );
        } else {
            out.push_str(
                "This conversation has passed between agents several times; answer yourself and do not \
                 @mention teammates now — they would not be asked.\n",
            );
        }
    }
    if !recent.is_empty() {
        let lines: Vec<String> = recent.iter().map(|m| transcript_line(m, &names)).collect();
        out.push_str(&format!("\nLatest Huddle messages (oldest first):\n{}\n", lines.join("\n")));
    }
    out
}

/// Answer `message` as `agent_id`, post the reply and hand it to whoever it
/// @mentions. Boxed because a reply can lead to further deliveries.
fn deliver(state: AppState, uid: String, agent_id: String, message: Value) -> BoxFuture {
    Box::pin(async move {
        let lock = agent_lock(&uid, &agent_id);
        let _turn = lock.lock().await;
        let _working = WorkingGuard::new(&uid, &agent_id);
        let hop = message["hop"].as_u64().unwrap_or(0) + 1;
        let notice = |kind: &str, detail: Option<String>| {
            let mut notice = new_message(json!({"type": "system"}), &[], "", hop);
            notice["kind"] = json!(kind);
            notice["agentId"] = json!(agent_id);
            if let Some(detail) = detail {
                notice["detail"] = json!(detail);
            }
            notice["replyTo"] = message["id"].clone();
            notice
        };
        match answer(&state, &uid, &agent_id, &message, hop).await {
            // A finished turn with no text must not look like the agent never
            // got the message.
            Ok(Some((_, reply, _))) if reply.is_empty() => {
                let _ = append(&state, &uid, notice("empty", None)).await;
            }
            Ok(Some((me, reply, mentions))) => {
                let deliverable = hop < MAX_HOPS;
                let mut posted = new_message(
                    json!({"type": "agent", "id": agent_id, "name": me["name"]}),
                    &mentions,
                    &reply,
                    hop,
                );
                posted["replyTo"] = message["id"].clone();
                if !mentions.is_empty() && !deliverable {
                    posted["limitReached"] = json!(true);
                }
                let Ok(posted) = append(&state, &uid, posted).await else {
                    return;
                };
                if deliverable {
                    for target in mentions {
                        tokio::spawn(deliver(state.clone(), uid.clone(), target, posted.clone()));
                    }
                }
            }
            Ok(None) => {}
            Err(err) => {
                let _ = append(&state, &uid, notice("error", Some(clip(&err.1, 400)))).await;
            }
        }
    })
}

/// Runs one room turn. `Ok(None)` when the agent is gone; an empty reply
/// means it finished without saying anything.
async fn answer(
    state: &AppState,
    uid: &str,
    agent_id: &str,
    message: &Value,
    hop: u64,
) -> Result<Option<(Value, String, Vec<String>)>, ApiError> {
    let agents = roster(state, uid).await?;
    let Some(me) = agents.iter().find(|a| a["id"].as_str() == Some(agent_id)).cloned() else {
        return Ok(None);
    };
    let room = read_room(state, uid).await?;
    let history = room["messages"].as_array().cloned().unwrap_or_default();
    // The message being answered is the prompt; context is what came before it.
    let before: Vec<Value> = history
        .iter()
        .take_while(|m| m["id"] != message["id"])
        .cloned()
        .collect();
    let recent = &before[before.len().saturating_sub(CONTEXT_MESSAGES)..];
    let person = history
        .iter()
        .rev()
        .find(|m| m["from"]["type"] == "user")
        .map(sender_name)
        .unwrap_or_else(|| "the owner".to_string());
    let hops_left = MAX_HOPS.saturating_sub(hop);

    let scoped = crate::routes::agents::scoped_state(state, agent_id).await?;
    let working_dir = crate::routes::agents::working_dir_for(state, agent_id)
        .await?
        .unwrap_or_else(|| state.workspace.clone())
        .to_string_lossy()
        .to_string();
    let agent_tools = if agent_id == MAIN_AGENT_ID {
        None
    } else {
        crate::sandbox::AgentToolset::for_agent(&scoped, agent_id).await?
    };
    let reminder = [
        crate::agent::build_capability_guidance_block(&scoped.home),
        room_reminder(&me, &agents, &person, recent, hops_left),
    ]
    .into_iter()
    .filter(|block| !block.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    let prompt = format!("{} wrote in the Huddle:\n\n{}", sender_name(message), message["text"].as_str().unwrap_or(""));
    let session_id = room["sessions"][agent_id].as_str().filter(|s| !s.is_empty()).map(str::to_string);

    let plan = crate::runtime::TurnPlan {
        session_id,
        working_dir,
        expose_tools: crate::runtime::expose_tools(),
        model: None,
        prompt,
        images: Vec::new(),
        tool_results: Vec::new(),
        system_reminder: Some(reminder),
        agent_tools,
    };
    let (reply, session) = match room_turn(&scoped, plan).await {
        Ok(done) => done,
        Err(err) => {
            // A broken session must not keep failing every later message.
            let _ = update_room(state, uid, |room| {
                if let Some(sessions) = room["sessions"].as_object_mut() {
                    sessions.remove(agent_id);
                }
            })
            .await;
            return Err(err);
        }
    };
    update_room(state, uid, |room| {
        if !room["sessions"].is_object() {
            room["sessions"] = json!({});
        }
        room["sessions"][agent_id] = json!(session);
    })
    .await?;
    let reply = reply.trim().to_string();
    if reply.is_empty() {
        return Ok(Some((me, reply, Vec::new())));
    }
    let handles: Vec<(String, String)> = agents
        .iter()
        .filter(|a| a["id"].as_str() != Some(agent_id))
        .map(|a| (a["id"].as_str().unwrap_or("").to_string(), a["name"].as_str().unwrap_or("").to_string()))
        .collect();
    let mentions = reply_targets(find_mentions(&reply, &handles, false), message, agent_id);
    Ok(Some((me, reply, mentions)))
}

struct SessionGuard {
    state: AppState,
    session_id: String,
    completed: bool,
}
impl Drop for SessionGuard {
    fn drop(&mut self) {
        if !self.completed {
            crate::runtime::cancel_and_detach(self.state.clone(), self.session_id.clone());
        }
    }
}

/// One turn on the agent's room session; returns `(final text, session id)`.
/// The final text is what the agent said after its last tool call.
async fn room_turn(state: &AppState, plan: crate::runtime::TurnPlan) -> Result<(String, String), ApiError> {
    use crate::runtime::TurnUpdate;
    use amiro_sdk::ApiEvent;
    let gateway = |message: String| ApiError(StatusCode::BAD_GATEWAY, message);
    let mut turn = crate::runtime::start_turn(state.clone(), plan).await?;
    let session = turn
        .session
        .await
        .map_err(|_| gateway("the runtime closed before starting the room turn".into()))?
        .map_err(gateway)?;
    let mut guard = SessionGuard {
        state: state.clone(),
        session_id: session.session_id.clone(),
        completed: false,
    };
    let mut text = String::new();
    let mut after_tool = false;
    while let Some(update) = turn.updates.recv().await {
        match update {
            TurnUpdate::Event(ApiEvent::ToolStart { .. } | ApiEvent::ToolExec { .. } | ApiEvent::ToolCall { .. }) => {
                after_tool = true;
            }
            TurnUpdate::Event(ApiEvent::TextDelta { text: delta, .. }) => {
                if after_tool {
                    text.clear();
                    after_tool = false;
                }
                if text.chars().count() < MAX_REPLY_CHARS {
                    text.push_str(&delta);
                }
            }
            TurnUpdate::Event(ApiEvent::TextReplace { text: replacement, .. }) => {
                after_tool = false;
                text = clip(&replacement, MAX_REPLY_CHARS);
            }
            TurnUpdate::Error(message) => return Err(gateway(message)),
            TurnUpdate::Done(_) => {
                guard.completed = true;
                return Ok((text, session.session_id));
            }
            _ => {}
        }
    }
    Err(gateway("the runtime ended the room turn without finishing it".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team() -> Vec<(String, String)> {
        vec![
            ("main".into(), "Amiro".into()),
            ("a1".into(), "Scout".into()),
            ("a2".into(), "Writer Bot".into()),
        ]
    }

    #[test]
    fn mentions_match_names_case_insensitively() {
        assert_eq!(find_mentions("hey @scout, look", &team(), false), vec!["a1"]);
        assert_eq!(find_mentions("@Writer Bot draft it", &team(), false), vec!["a2"]);
        assert_eq!(find_mentions("@Amiro and @Scout", &team(), false), vec!["main", "a1"]);
    }

    #[test]
    fn mentions_need_a_word_boundary() {
        assert!(find_mentions("@Scouting party", &team(), false).is_empty());
        assert!(find_mentions("mail scout@example.com", &team(), false).is_empty());
        assert!(find_mentions("no mention here", &team(), false).is_empty());
    }

    #[test]
    fn all_reaches_everyone_only_when_allowed() {
        assert_eq!(find_mentions("@all standup", &team(), true).len(), 3);
        assert_eq!(find_mentions("@everyone", &team(), true).len(), 3);
        assert!(find_mentions("@all standup", &team(), false).is_empty());
    }

    #[test]
    fn a_handoff_answer_goes_back_to_the_asking_agent() {
        let handoff = json!({"from": {"type": "agent", "id": "main"}, "to": ["a1"]});
        assert_eq!(reply_targets(vec![], &handoff, "a1"), vec!["main"]);
        assert_eq!(reply_targets(vec!["a2".into()], &handoff, "a1"), vec!["a2", "main"]);
        assert_eq!(reply_targets(vec!["main".into()], &handoff, "a1"), vec!["main"]);
        let from_person = json!({"from": {"type": "user", "id": "u1"}, "to": ["a1"]});
        assert!(reply_targets(vec![], &from_person, "a1").is_empty());
    }

    #[test]
    fn reminder_drops_handoff_advice_at_the_hop_limit() {
        let agents = vec![
            json!({"id": "main", "name": "Amiro", "role": "Lead"}),
            json!({"id": "a1", "name": "Scout", "role": "Research"}),
        ];
        let open = room_reminder(&agents[0], &agents, "Asha", &[], 2);
        assert!(open.contains("@Scout — Research"));
        assert!(open.contains("@mention them"));
        assert!(!open.contains("@Amiro —"));
        let closed = room_reminder(&agents[0], &agents, "Asha", &[], 0);
        assert!(closed.contains("do not @mention teammates now"));
        assert!(!closed.contains("@mention them by name"));
    }
}
