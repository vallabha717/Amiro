//! Swarm members of a chat thread, and a thread to talk to each one directly.
//!
//! The runtime already knows a swarm's shape: every member is a session whose
//! `parent_session_id` names the agent it reports to, with an `agent_label`
//! and a persisted `swarm_status`. Nothing reached the browser, though, so the
//! web UI could not show who is working or let the user address one of them.
//!
//! Talking to a member reuses the whole chat pipeline instead of growing a
//! second one: `open` maps a thread id onto the member's session, and from
//! then on `/api/chat` and `/api/thread/{id}` stream and replay it exactly as
//! they do the coordinator.

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::{ApiError, AppState, AuthUser};
use crate::threads::{entry_owned, read_threads, upsert_entry};
use axum::http::StatusCode;

fn user_id(user: &AuthUser) -> String {
    user.0.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

#[derive(Deserialize)]
struct MembersQuery {
    thread: String,
}

/// Every session that reports, directly or through another member, to the
/// session behind `root`. Breadth-first so the list reads coordinator-out.
pub fn swarm_descendants(root: &str, sessions: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut frontier = vec![root.to_string()];
    let mut seen = std::collections::HashSet::new();
    seen.insert(root.to_string());
    while let Some(parent) = frontier.pop() {
        for s in sessions {
            let sid = s.get("session_id").and_then(Value::as_str).unwrap_or("");
            if sid.is_empty() || seen.contains(sid) {
                continue;
            }
            if s.get("parent_session_id").and_then(Value::as_str) == Some(parent.as_str()) {
                seen.insert(sid.to_string());
                frontier.insert(0, sid.to_string());
                out.push(s.clone());
            }
        }
    }
    out
}

/// The runtime only reports membership while the swarm's snapshot exists on
/// disk, and it removes the snapshot once the swarm winds down -- so a
/// finished swarm's members would vanish from the panel, and their threads
/// would lose the way back to their coordinator. Every member seen live is
/// therefore remembered on the coordinator's thread entry, and the two lists
/// are merged on read: live data when the runtime has it, the remembered
/// identity otherwise.
async fn remembered_members(
    state: &AppState,
    uid: &str,
    doc: &Value,
    root: &str,
    live: &[Value],
    sessions: &[Value],
) -> Vec<Value> {
    let root_thread = doc.as_object().and_then(|obj| {
        obj.iter().find(|(_, e)| {
            entry_owned(e, uid)
                && e.get("sessionId").and_then(Value::as_str) == Some(root)
                && e.get("swarmRootSessionId").is_none()
        })
    });
    let Some((root_thread_id, root_entry)) = root_thread else {
        return live.to_vec();
    };
    let mut known: Vec<Value> = root_entry
        .get("swarmMembers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let before = known.len();
    for s in live {
        let sid = s.get("session_id").and_then(Value::as_str).unwrap_or("");
        if !known.iter().any(|k| k.get("session_id").and_then(Value::as_str) == Some(sid)) {
            known.push(json!({
                "session_id": sid,
                "parent_session_id": s.get("parent_session_id"),
                "agent_label": s.get("agent_label"),
            }));
        }
    }
    if known.len() != before {
        let _ = upsert_entry(state, root_thread_id, json!({ "swarmMembers": known })).await;
    }

    let mut out = live.to_vec();
    for k in &known {
        let sid = k.get("session_id").and_then(Value::as_str).unwrap_or("");
        if out.iter().any(|s| s.get("session_id").and_then(Value::as_str) == Some(sid)) {
            continue;
        }
        // Still a runtime session (not deleted): show it with the session's
        // own status and the identity remembered from when it was live.
        if let Some(session) = sessions
            .iter()
            .find(|s| s.get("session_id").and_then(Value::as_str) == Some(sid))
        {
            let mut merged = session.clone();
            merged["parent_session_id"] = k.get("parent_session_id").cloned().unwrap_or(Value::Null);
            if merged.get("agent_label").map_or(true, Value::is_null) {
                merged["agent_label"] = k.get("agent_label").cloned().unwrap_or(Value::Null);
            }
            out.push(merged);
        }
    }
    out
}

fn member_json(s: &Value, thread_by_session: &std::collections::HashMap<String, String>) -> Value {
    let sid = s.get("session_id").and_then(Value::as_str).unwrap_or("");
    json!({
        "sessionId": sid,
        "parentSessionId": s.get("parent_session_id"),
        "label": s.get("agent_label"),
        "title": s.get("title"),
        "status": s.get("status"),
        "swarmStatus": s.get("swarm_status"),
        "userConnected": s.get("user_connected").and_then(Value::as_bool).unwrap_or(false),
        "lastActiveAtMs": s.get("last_active_at_ms"),
        "workingDir": s.get("working_dir"),
        "threadId": thread_by_session.get(sid),
    })
}

async fn members(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<MembersQuery>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let doc = read_threads(&state).await?;
    let Some(entry) = doc.get(&q.thread).filter(|e| entry_owned(e, &uid)) else {
        // A brand-new thread has no entry until its first turn; no swarm yet.
        return Ok(Json(json!({ "coordinator": null, "members": [] })));
    };
    let Some(root) = entry.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return Ok(Json(json!({ "coordinator": null, "members": [] })));
    };
    // A member thread shows its own swarm: the coordinator is whoever it
    // reports to, so the user can move between siblings without going back.
    let root = entry
        .get("swarmRootSessionId")
        .and_then(Value::as_str)
        .unwrap_or(root)
        .to_string();

    let sessions = crate::runtime::list_sessions(&state).await?;
    let thread_by_session: std::collections::HashMap<String, String> = doc
        .as_object()
        .map(|obj| {
            obj.iter()
                .filter(|(_, e)| entry_owned(e, &uid))
                .filter_map(|(id, e)| {
                    e.get("sessionId").and_then(Value::as_str).map(|s| (s.to_string(), id.clone()))
                })
                .collect()
        })
        .unwrap_or_default();

    let coordinator = sessions
        .iter()
        .find(|s| s.get("session_id").and_then(Value::as_str) == Some(root.as_str()))
        .map(|s| member_json(s, &thread_by_session));
    let live = swarm_descendants(&root, &sessions);
    let members: Vec<Value> = remembered_members(&state, &uid, &doc, &root, &live, &sessions)
        .await
        .iter()
        .map(|s| member_json(s, &thread_by_session))
        .collect();
    Ok(Json(json!({ "coordinator": coordinator, "members": members })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenBody {
    session_id: String,
    from_thread_id: String,
}

/// Return a thread bound to a swarm member's session, creating one on first
/// use. Only members of a swarm the caller owns can be opened.
async fn open(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<OpenBody>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let doc = read_threads(&state).await?;
    let from = doc
        .get(&body.from_thread_id)
        .filter(|e| entry_owned(e, &uid))
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "thread not found".into()))?;
    let from_session = from.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let root = from
        .get("swarmRootSessionId")
        .and_then(Value::as_str)
        .unwrap_or(from_session)
        .to_string();

    if body.session_id == root {
        let root_thread = doc.as_object().and_then(|obj| {
            obj.iter().find(|(_, e)| {
                entry_owned(e, &uid)
                    && e.get("sessionId").and_then(Value::as_str) == Some(root.as_str())
                    && e.get("swarmRootSessionId").is_none()
            })
        });
        if let Some((id, _)) = root_thread {
            return Ok(Json(json!({ "threadId": id })));
        }
    }

    let sessions = crate::runtime::list_sessions(&state).await?;
    let live = swarm_descendants(&root, &sessions);
    let member = remembered_members(&state, &uid, &doc, &root, &live, &sessions)
        .await
        .into_iter()
        .find(|s| s.get("session_id").and_then(Value::as_str) == Some(body.session_id.as_str()))
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not a member of this swarm".into()))?;

    if let Some((id, _)) = doc.as_object().and_then(|obj| {
        obj.iter().find(|(_, e)| {
            entry_owned(e, &uid)
                && e.get("sessionId").and_then(Value::as_str) == Some(body.session_id.as_str())
        })
    }) {
        return Ok(Json(json!({ "threadId": id })));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let title = member
        .get("agent_label")
        .and_then(Value::as_str)
        .or_else(|| member.get("title").and_then(Value::as_str))
        .unwrap_or("Swarm agent")
        .to_string();
    let working_dir = member
        .get("working_dir")
        .cloned()
        .or_else(|| from.get("workingDir").cloned())
        .unwrap_or(Value::Null);
    upsert_entry(
        &state,
        &id,
        json!({
            "userId": uid,
            "sessionId": body.session_id,
            "title": title,
            "titleSource": "manual",
            "workingDir": working_dir,
            "swarmRootSessionId": root,
            "swarmParentThreadId": body.from_thread_id,
            "createdAt": crate::state::now_iso(),
        }),
    )
    .await?;
    Ok(Json(json!({ "threadId": id })))
}

#[derive(Deserialize)]
struct TranscriptQuery {
    /// The thread the user is looking at (coordinator or member thread).
    thread: String,
    /// The swarm member (or coordinator) session to read.
    session: String,
}

/// A swarm member's transcript, read without binding a thread to it.
///
/// This is what the side-by-side agent panes and the Alt+N peek show: the
/// user wants to watch an agent work, and creating a thread entry just to
/// look would litter the sidebar with one per glance. Only the caller's own
/// swarm can be read -- the coordinator or a member it has been seen with.
async fn transcript(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<TranscriptQuery>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let doc = read_threads(&state).await?;
    let entry = doc
        .get(&q.thread)
        .filter(|e| entry_owned(e, &uid))
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "thread not found".into()))?;
    let own = entry.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let root = entry
        .get("swarmRootSessionId")
        .and_then(Value::as_str)
        .unwrap_or(own)
        .to_string();

    if q.session != root {
        let sessions = crate::runtime::list_sessions(&state).await?;
        let live = swarm_descendants(&root, &sessions);
        let known = remembered_members(&state, &uid, &doc, &root, &live, &sessions).await;
        if !known
            .iter()
            .any(|s| s.get("session_id").and_then(Value::as_str) == Some(q.session.as_str()))
        {
            return Err(ApiError(StatusCode::NOT_FOUND, "not a member of this swarm".into()));
        }
    }

    let history = crate::runtime::get_history(&state, &q.session).await?;
    // Ids are scoped by session, so a pane's messages never collide with the
    // main chat's even when both render the same kind of row.
    let messages = crate::threads::history_to_messages(&q.session, &q.session, &history);
    Ok(Json(json!({ "sessionId": q.session, "messages": messages })))
}

#[derive(Deserialize)]
struct ContextQuery {
    thread: String,
}

/// The thread's real context window and occupancy, straight from the
/// runtime. Lives beside the swarm routes because it answers the same
/// question for the session panel: what is this session's agent doing.
async fn context(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ContextQuery>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let doc = read_threads(&state).await?;
    let Some(session) = doc
        .get(&q.thread)
        .filter(|e| entry_owned(e, &uid))
        .and_then(|e| e.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(Json(json!({ "contextWindow": null, "contextTokens": null })));
    };
    Ok(Json(
        crate::runtime::context_snapshot(&state, session)
            .await
            .unwrap_or_else(|| json!({ "contextWindow": null, "contextTokens": null })),
    ))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/session/context", get(context))
        .route("/api/swarm/transcript", get(transcript))
        .route("/api/swarm/members", get(members))
        .route("/api/swarm/open", post(open))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descendants_walk_the_report_tree() {
        let sessions = vec![
            json!({"session_id": "root"}),
            json!({"session_id": "a", "parent_session_id": "root", "agent_label": "planner"}),
            json!({"session_id": "b", "parent_session_id": "a"}),
            json!({"session_id": "c", "parent_session_id": "other"}),
            json!({"session_id": "d", "parent_session_id": "root"}),
        ];
        let ids: Vec<String> = swarm_descendants("root", &sessions)
            .iter()
            .map(|s| s["session_id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["a", "d", "b"]);
    }
}
