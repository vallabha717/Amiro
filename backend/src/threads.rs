use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

fn threads_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("threads.json")
}

/// Read the thread map without taking the store lock. Read-only callers (chat,
/// title, export) use this; read-modify-write callers take `state.store` first
/// and write through `write_threads`.
pub async fn read_threads(state: &AppState) -> Result<Value, ApiError> {
    read_json(&threads_path(state), json!({})).await
}

pub async fn write_threads(state: &AppState, doc: &Value) -> Result<(), ApiError> {
    write_json(&threads_path(state), doc).await
}

/// One thread mapping, or `None` when the thread does not exist.
pub async fn get_entry(state: &AppState, id: &str) -> Result<Option<Value>, ApiError> {
    let doc = read_threads(state).await?;
    Ok(doc.get(id).cloned())
}

/// Apply runtime metadata only to the same, still-owned session mapping.
/// Late title updates never resurrect deleted threads or overwrite a UI rename.
pub async fn sync_runtime_title(state: &AppState, id: &str, uid: &str, session_id: &str, title: &str) -> Result<Option<String>, ApiError> {
    let title = title.trim();
    if title.is_empty() { return Ok(None); }
    let _guard = state.store.lock().await;
    let mut doc = read_threads(state).await?;
    let Some(entry) = doc.get_mut(id) else { return Ok(None); };
    if !entry_owned(entry, uid) || entry.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || entry.get("titleSource").and_then(Value::as_str) == Some("manual") {
        return Ok(None);
    }
    if entry.get("title").and_then(Value::as_str) == Some(title)
        && entry.get("titleSource").and_then(Value::as_str) == Some("runtime") {
        return Ok(Some(title.to_string()));
    }
    entry["title"] = json!(title);
    entry["titleSource"] = json!("runtime");
    write_threads(state, &doc).await?;
    Ok(Some(title.to_string()))
}

/// Fail-closed ownership: a mapping with no owner belongs to nobody, and only
/// the matching user id may reach it. Refusing ownerless mappings keeps a
/// legacy or malformed record from exposing a shared runtime session.
pub fn entry_owned(entry: &Value, uid: &str) -> bool {
    if uid.is_empty() {
        return false;
    }
    entry
        .get("userId")
        .and_then(|value| value.as_str())
        .map(|owner| owner == uid && !owner.is_empty())
        .unwrap_or(false)
}

/// Merge `patch` into one thread mapping. Takes the store lock, so callers must
/// not already hold it.
pub async fn upsert_entry(state: &AppState, id: &str, patch: Value) -> Result<Value, ApiError> {
    let _guard = state.store.lock().await;
    let mut doc = read_threads(state).await?;
    if !doc.is_object() {
        doc = json!({});
    }
    let existing = doc.get(id).cloned().unwrap_or_else(|| json!({}));
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    for (key, value) in patch.as_object().cloned().unwrap_or_default() {
        merged.insert(key, value);
    }
    let merged = Value::Object(merged);
    if let Some(map) = doc.as_object_mut() {
        map.insert(id.to_string(), merged.clone());
    }
    write_threads(state, &doc).await?;
    Ok(merged)
}

fn user_id(user: &AuthUser) -> String {
    user.0.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn owns(entry: &Value, uid: &str) -> bool {
    entry.get("userId").and_then(|v| v.as_str()).map(|id| id == uid && !id.is_empty()).unwrap_or(false)
}

/// An agent's permanent channel thread (see `routes/agents.rs`).
pub fn is_channel(entry: &Value) -> bool {
    entry.get("channel").and_then(Value::as_bool).unwrap_or(false)
}

/// The state whose runtime holds this thread's session: the team agent's own
/// runtime for threads it ran (`runtime: "agent"`), else the shared one.
pub async fn runtime_state(state: &AppState, entry: &Value) -> AppState {
    if entry.get("runtime").and_then(Value::as_str) == Some("agent") {
        if let Some(agent) = entry.get("agentId").and_then(Value::as_str) {
            if let Ok(scoped) = crate::routes::agents::scoped_state(state, agent).await {
                return scoped;
            }
        }
    }
    state.clone()
}

fn history_msg_id(session_id: &str, index: usize) -> String {
    format!("msg_{}_{}", index, session_id)
}

fn parse_msg_id(id: &str) -> Option<(usize, String)> {
    let rest = id.strip_prefix("msg_")?;
    let (idx_str, sid) = rest.split_once('_')?;
    let idx: usize = idx_str.parse().ok()?;
    Some((idx, sid.to_string()))
}

/// Invisible separator the runtime puts just inside both ends of every
/// persisted reasoning line (`amiro-render-core`'s `REASONING_SENTINEL`).
const REASONING_SENTINEL: char = '\u{2063}';

/// Undo the runtime's dim/italic wrapper for one reasoning line:
/// `*<S>escaped body<S>*  ` becomes the original text. `None` when the line
/// is not a reasoning line.
fn reasoning_line_content(line: &str) -> Option<String> {
    let body = line
        .trim_end_matches([' ', '\r', '\n'])
        .strip_prefix('*')?
        .strip_prefix(REASONING_SENTINEL)?
        .strip_suffix('*')?
        .strip_suffix(REASONING_SENTINEL)?;
    const ESCAPES: &str = "\\*_`[]<>&~|$";
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && chars.peek().is_some_and(|c| ESCAPES.contains(*c)) {
            out.push(chars.next().unwrap());
        } else {
            out.push(ch);
        }
    }
    Some(out)
}

/// Split reasoning out of an assistant row's text. Handles both shapes a
/// runtime history row can carry it in: `<thinking>` tags, and the dim/italic
/// sentinel lines the runtime writes when it replays saved reasoning. Without
/// the second, a reloaded chat shows the model's thoughts as plain answer text.
fn extract_thinking_and_text(content: &str) -> (Vec<String>, String) {
    let mut thinkings = Vec::new();
    let mut remaining = String::new();
    let mut rest = content;
    let open_tag = "<thinking>";
    let close_tag = "</thinking>";

    while let Some(start_idx) = rest.find(open_tag) {
        remaining.push_str(&rest[..start_idx]);
        let after_open = &rest[start_idx + open_tag.len()..];
        if let Some(end_idx) = after_open.find(close_tag) {
            let thinking = &after_open[..end_idx];
            thinkings.push(thinking.trim().to_string());
            rest = &after_open[end_idx + close_tag.len()..];
        } else {
            thinkings.push(after_open.trim().to_string());
            rest = "";
            break;
        }
    }
    remaining.push_str(rest);

    // Sentinel lines: a run of them (blank lines inside the run belong to it)
    // is one reasoning block.
    if remaining.contains(REASONING_SENTINEL) {
        let mut text = String::new();
        let mut block: Vec<String> = Vec::new();
        let mut pending_blank = 0usize;
        let flush = |block: &mut Vec<String>, thinkings: &mut Vec<String>| {
            if !block.is_empty() {
                thinkings.push(block.join("\n").trim().to_string());
                block.clear();
            }
        };
        for line in remaining.split_inclusive('\n') {
            if let Some(body) = reasoning_line_content(line) {
                for _ in 0..pending_blank {
                    block.push(String::new());
                }
                pending_blank = 0;
                block.push(body);
            } else if line.trim().is_empty() && !block.is_empty() {
                pending_blank += 1;
            } else {
                flush(&mut block, &mut thinkings);
                pending_blank = 0;
                text.push_str(line);
            }
        }
        flush(&mut block, &mut thinkings);
        remaining = text;
    }
    (thinkings, remaining)
}

pub fn history_to_messages(thread_id: &str, session_id: &str, history: &[Value]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    let mut i = 0;
    while i < history.len() {
        let m = &history[i];
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("assistant");
        if role == "user" {
            let content = m.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let mut msg = json!({
                "id": history_msg_id(session_id, i),
                "threadId": thread_id,
                "role": "user",
                "parts": [{"type": "text", "text": content}],
                "createdAt": crate::state::now_iso(),
            });
            if let Some(stats) = m.get("response_stats") {
                let input = stats.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let output = stats.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let mut meta = json!({
                    "usage": {
                        "promptTokens": input,
                        "completionTokens": output,
                        "totalTokens": input + output,
                    }
                });
                if let Some(duration_secs) = stats.get("duration_secs").and_then(|v| v.as_f64()) {
                    meta["durationMs"] = json!((duration_secs * 1000.0).round() as u64);
                }
                msg["metadata"] = meta;
            }
            messages.push(msg);
            i += 1;
        } else {
            let start = i;
            let first_id = history_msg_id(session_id, start);
            let mut parts: Vec<Value> = Vec::new();
            let mut turn_stats: Option<&Value> = None;
            let mut has_tools = false;

            while i < history.len() {
                let row = &history[i];
                let row_role = row.get("role").and_then(|v| v.as_str()).unwrap_or("assistant");
                if row_role == "user" {
                    break;
                }
                // Runtime bookkeeping rows (the "[auto] ..." continuation and
                // guidance reminders, compaction notices) are not part of the
                // conversation. Rendering them as assistant text is what made
                // the credential-card template show up after a reload.
                if row_role == "system" || row_role == "background_task" {
                    i += 1;
                    continue;
                }
                if let Some(stats) = row.get("response_stats") {
                    turn_stats = Some(stats);
                }
                let content = row.get("content").and_then(|v| v.as_str()).unwrap_or("");
                if row_role == "tool" {
                    has_tools = true;
                    if parts.len() == 1 && parts[0].get("type").and_then(|t| t.as_str()) == Some("text") {
                        if parts[0].get("text").and_then(|t| t.as_str()) == Some("") {
                            parts.pop();
                        }
                    }
                    let (call_id, name, input) = if let Some(td) = row.get("tool_data").filter(|v| !v.is_null()) {
                        let id = td.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = td.get("name").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
                        let input = td.get("input").cloned().unwrap_or(json!({}));
                        (id, name, input)
                    } else {
                        (format!("call_{i}"), "tool".to_string(), json!({}))
                    };
                    let part_type = format!("tool-{name}");
                    let parsed_output = match serde_json::from_str::<Value>(content) {
                        Ok(v) if v.is_object() || v.is_array() => v,
                        _ => Value::String(content.to_string()),
                    };
                    parts.push(json!({
                        "type": part_type,
                        "toolCallId": call_id,
                        "toolName": name,
                        "state": "output-available",
                        "providerExecuted": true,
                        "input": input,
                        "output": parsed_output,
                    }));
                } else {
                    let (thinkings, remaining) = extract_thinking_and_text(content);
                    let thinkings_is_empty = thinkings.is_empty();
                    for t in thinkings {
                        parts.push(json!({
                            "type": "reasoning",
                            "text": t,
                        }));
                    }
                    // `remaining` is the row with its reasoning taken out. Only a
                    // row with no reasoning at all keeps its exact original text
                    // (whitespace and all); anything else must use the cleaned
                    // text, or the dim/italic wrapper leaks into the answer.
                    let had_reasoning = !thinkings_is_empty;
                    if !remaining.trim().is_empty() {
                        parts.push(json!({
                            "type": "text",
                            "text": if had_reasoning { remaining.trim().to_string() } else { content.to_string() },
                        }));
                    } else if !had_reasoning && !has_tools && parts.is_empty() {
                        parts.push(json!({
                            "type": "text",
                            "text": content.to_string(),
                        }));
                    }
                }
                i += 1;
            }

            if parts.is_empty() {
                parts.push(json!({"type": "text", "text": ""}));
            }

            let mut msg = json!({
                "id": first_id,
                "threadId": thread_id,
                "role": "assistant",
                "parts": parts,
                "createdAt": crate::state::now_iso(),
            });
            if let Some(stats) = turn_stats {
                let input = stats.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let output = stats.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let mut meta = json!({
                    "usage": {
                        "promptTokens": input,
                        "completionTokens": output,
                        "totalTokens": input + output,
                    }
                });
                if let Some(duration_secs) = stats.get("duration_secs").and_then(|v| v.as_f64()) {
                    meta["durationMs"] = json!((duration_secs * 1000.0).round() as u64);
                }
                msg["metadata"] = meta;
            }
            messages.push(msg);
        }
    }
    messages
}

/// In-app reminders do not need a model or a runtime session. Keep their
/// server-authored messages visible if the user later continues the thread.
fn thread_messages(entry: &Value, thread_id: &str, session_id: &str, history: &[Value]) -> Vec<Value> {
    let mut messages = entry
        .get("localMessages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    messages.extend(history_to_messages(thread_id, session_id, history));
    messages
}

/// The caller's chat list: the main agent's threads, or — in a team agent's
/// space (`X-Amiro-Agent`) — that agent's. The runtime titles come from the
/// same agent's runtime.
async fn list_threads(crate::routes::agents::AgentState(state): crate::routes::agents::AgentState, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let scope = state.agent_scope();
    let doc = read_json(&threads_path(&state), json!({})).await?;
    let obj = doc.as_object().cloned().unwrap_or_default();
    let runtime_titles = if obj.values().any(|entry| owns(entry, &uid) && entry.get("titleSource").and_then(Value::as_str) != Some("manual")) {
        crate::runtime::session_titles(&state).await.unwrap_or_default()
    } else { Default::default() };
    for (id, entry) in &obj {
        if owns(entry, &uid) {
            if let Some(session_id) = entry.get("sessionId").and_then(Value::as_str) {
                if let Some(title) = runtime_titles.get(session_id) {
                    let _ = sync_runtime_title(&state, id, &uid, session_id, title).await;
                }
            }
        }
    }
    let doc = read_threads(&state).await?;
    let obj = doc.as_object().cloned().unwrap_or_default();
    // Team agents' threads live on their own page; this list is the main agent's.
    let team = crate::routes::agents::team_agent_ids(&state).await;
    let mut list: Vec<Value> = obj.iter().filter_map(|(id, e)| {
        if !owns(e, &uid) { return None; }
        let agent = e.get("agentId").and_then(Value::as_str);
        match scope.as_deref() {
            Some(scoped) => if agent != Some(scoped) { return None; },
            None => if agent.is_some_and(|a| team.iter().any(|t| t == a)) { return None; },
        }
        Some(json!({
            "id": id,
            "title": e.get("title").and_then(|v| v.as_str()).unwrap_or("New Chat"),
            "userId": e.get("userId").and_then(|v| v.as_str()).unwrap_or(""),
            "createdAt": e.get("createdAt").cloned().unwrap_or(json!(crate::state::now_iso())),
            "lastMessageAt": e.get("lastMessageAt").or_else(|| e.get("createdAt")).cloned().unwrap_or(json!(crate::state::now_iso())),
            "archived": e.get("archived").and_then(|v| v.as_bool()).unwrap_or(false),
            "workingDir": e.get("workingDir").and_then(|v| v.as_str()).unwrap_or_else(|| state.workspace.to_str().unwrap_or("")),
            "heartbeat": e.get("heartbeat").and_then(|v| v.as_bool()).unwrap_or(false),
            "unread": e.get("unread").and_then(|v| v.as_bool()).unwrap_or(false),
            "agentId": e.get("agentId").and_then(Value::as_str).unwrap_or(crate::routes::agents::MAIN_AGENT_ID),
            "channel": is_channel(e),
        }))
    }).collect();
    list.sort_by(|a,b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(Json(json!(list)))
}

async fn get_thread(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let doc = read_json(&threads_path(&state), json!({})).await?;
    let mut entry = doc.get(&id).cloned().ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "thread not found".into()))?;
    if !owns(&entry, &uid) {
        return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into()));
    }
    let session_id_owned = entry.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let session_id = session_id_owned.as_str();
    let runtime = runtime_state(&state, &entry).await;
    if !session_id.is_empty() && entry.get("titleSource").and_then(Value::as_str) != Some("manual") {
        if let Ok(Some(title)) = crate::runtime::session_title(&runtime, session_id).await {
            if let Some(title) = sync_runtime_title(&state, &id, &uid, session_id, &title).await? {
                entry["title"] = json!(title);
            }
        }
    }
    let history = if session_id.is_empty() {
        Vec::new()
    } else {
        crate::runtime::get_history(&runtime, session_id)
            .await
            .map_err(|error| {
                ApiError(
                    StatusCode::BAD_GATEWAY,
                    format!("unable to read thread history: {}", error.1),
                )
            })?
    };
    let messages = thread_messages(&entry, &id, session_id, &history);
    // Opening a thread reads it.
    if entry.get("unread").and_then(Value::as_bool) == Some(true) {
        let _ = upsert_entry(&state, &id, json!({"unread": false})).await;
    }
    Ok(Json(json!({
        "heartbeat": entry.get("heartbeat").and_then(Value::as_bool).unwrap_or(false),
        "id": id,
        "title": entry.get("title").and_then(|v| v.as_str()).unwrap_or("New Chat"),
        "userId": entry.get("userId").and_then(|v| v.as_str()).unwrap_or(""),
        "createdAt": entry.get("createdAt").cloned().unwrap_or(json!(crate::state::now_iso())),
        "lastMessageAt": entry.get("lastMessageAt").or_else(|| entry.get("createdAt")).cloned().unwrap_or(json!(crate::state::now_iso())),
        "archived": entry.get("archived").and_then(|v| v.as_bool()).unwrap_or(false),
        "workingDir": entry.get("workingDir").and_then(|v| v.as_str()).unwrap_or_else(|| state.workspace.to_str().unwrap_or("")),
        "messages": messages,
    })))
}

async fn put_thread(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let _guard = state.store.lock().await;
    let path = threads_path(&state);
    let mut doc = read_json(&path, json!({})).await?;
    let entry = doc.get(&id).cloned().ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "thread not found".into()))?;
    if !owns(&entry, &uid) { return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into())); }
    let title = body.get("title").and_then(|v| v.as_str()).unwrap_or_else(|| entry.get("title").and_then(|v| v.as_str()).unwrap_or("New Chat"));
    if let Some(obj) = doc.get_mut(&id).and_then(|v| v.as_object_mut()) {
        obj.insert("title".into(), json!(title));
        if body.get("title").and_then(Value::as_str).is_some() {
            obj.insert("titleSource".into(), json!("manual"));
        }
    }
    let sid = entry.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if !sid.is_empty() {
        let _ = crate::runtime::rename_session(&runtime_state(&state, &entry).await, sid, title).await;
    }
    write_json(&path, &doc).await?;
    let updated = doc.get(&id).cloned().unwrap_or(json!({}));
    Ok(Json(json!({
        "id": id,
        "title": updated.get("title").and_then(|v| v.as_str()).unwrap_or(title),
        "userId": updated.get("userId").and_then(|v| v.as_str()).unwrap_or(""),
        "createdAt": updated.get("createdAt").cloned().unwrap_or(json!(crate::state::now_iso())),
        "lastMessageAt": updated.get("lastMessageAt").or_else(|| updated.get("createdAt")).cloned().unwrap_or(json!(crate::state::now_iso())),
        "archived": updated.get("archived").and_then(|v| v.as_bool()).unwrap_or(false),
    })))
}

async fn delete_thread(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let uid = user_id(&user);
    let _guard = state.store.lock().await;
    let path = threads_path(&state);
    let mut doc = read_json(&path, json!({})).await?;
    if let Some(entry) = doc.get(&id).cloned() {
        if !owns(&entry, &uid) { return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into())); }
        if is_channel(&entry) {
            return Err(ApiError(StatusCode::CONFLICT, "An agent's channel can't be deleted.".into()));
        }
        if let Some(sid) = entry.get("sessionId").and_then(|v| v.as_str()) {
            let _ = crate::runtime::archive_session(&runtime_state(&state, &entry).await, sid).await;
        }
        if let Some(obj) = doc.as_object_mut() { obj.remove(&id); }
        write_json(&path, &doc).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ScopeQuery { scope: Option<String> }

async fn delete_threads(State(state): State<AppState>, user: AuthUser, Query(q): Query<ScopeQuery>) -> Result<StatusCode, ApiError> {
    let uid = user_id(&user);
    let _guard = state.store.lock().await;
    let path = threads_path(&state);
    let mut doc = read_json(&path, json!({})).await?;
    let obj = doc.as_object_mut().ok_or_else(|| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "invalid threads".into()))?;
    let unarchived_only = q.scope.as_deref() == Some("unarchived");
    let ids: Vec<String> = obj.iter().filter_map(|(id, e)| {
        if !owns(e, &uid) { return None; }
        if is_channel(e) { return None; }
        if unarchived_only && e.get("archived").and_then(|v| v.as_bool()).unwrap_or(false) { return None; }
        Some(id.clone())
    }).collect();
    for id in &ids {
        if let Some(entry) = obj.get(id).cloned() {
            if let Some(sid) = entry.get("sessionId").and_then(|v| v.as_str()) {
                let _ = crate::runtime::archive_session(&runtime_state(&state, &entry).await, sid).await;
            }
        }
        obj.remove(id);
    }
    write_json(&path, &doc).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Local reminders use durable message ids rather than runtime history offsets.
async fn edit_local_message(state: &AppState, uid: &str, id: &str, truncate: bool) -> Result<StatusCode, ApiError> {
    let _guard = state.store.lock().await;
    let path = threads_path(state);
    let mut doc = read_json(&path, json!({})).await?;
    let entries = doc.as_object_mut().ok_or_else(|| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "invalid threads".into()))?;
    let mut found = false;
    for entry in entries.values_mut() {
        if !owns(entry, uid) { continue; }
        if let Some(messages) = entry.get_mut("localMessages").and_then(Value::as_array_mut) {
            if let Some(index) = messages.iter().position(|message| message.get("id").and_then(Value::as_str) == Some(id)) {
                if truncate { messages.truncate(index + 1); } else { messages.remove(index); }
                if truncate {
                    if let Some(sid) = entry.get("sessionId").and_then(Value::as_str).filter(|sid| !sid.is_empty()) {
                        crate::runtime::rewind_session(&runtime_state(state, entry).await, sid, 0).await?;
                    }
                }
                found = true;
                break;
            }
        }
    }
    if !found { return Err(ApiError(StatusCode::NOT_FOUND, "message not found".into())); }
    write_json(&path, &doc).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_msg(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let uid = user_id(&user);
    let Some((idx, sid)) = parse_msg_id(&id) else {
        return edit_local_message(&state, &uid, &id, false).await;
    };
    let entry = owned_session_entry(&state, &uid, &sid).await?;
    crate::runtime::rewind_session(&runtime_state(&state, &entry).await, &sid, idx).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "unable to delete message".into()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn truncate_msg(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let uid = user_id(&user);
    let Some((idx, sid)) = parse_msg_id(&id) else {
        return edit_local_message(&state, &uid, &id, true).await;
    };
    let entry = owned_session_entry(&state, &uid, &sid).await?;
    crate::runtime::rewind_session(&runtime_state(&state, &entry).await, &sid, idx+1).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "unable to truncate messages".into()))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The caller's thread entry that holds runtime session `sid`, or 404.
async fn owned_session_entry(state: &AppState, uid: &str, sid: &str) -> Result<Value, ApiError> {
    let doc = read_json(&threads_path(state), json!({})).await?;
    doc.as_object()
        .and_then(|obj| obj.values().find(|e| e.get("sessionId").and_then(|v| v.as_str()) == Some(sid) && owns(e, uid)))
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "thread not found".into()))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/thread", get(list_threads).delete(delete_threads))
        .route("/api/thread/{id}", get(get_thread).put(put_thread).delete(delete_thread))
        .route("/api/thread/messages/{id}", delete(delete_msg))
        .route("/api/thread/messages/{id}/truncate", post(truncate_msg))
}

#[cfg(test)]
mod reminder_tests {
    use super::*;

    #[tokio::test]
    async fn reminder_message_actions_are_durable_and_owner_scoped() {
        let home = std::env::temp_dir().join(format!("amiro-reminder-test-{}", uuid::Uuid::new_v4()));
        let mut state = AppState::from_env();
        state.home = home.clone();
        write_json(&threads_path(&state), &json!({"t":{
            "userId":"owner", "localMessages":[{"id":"first"},{"id":"second"}]
        }})).await.unwrap();
        let denied = edit_local_message(&state, "stranger", "first", false).await.unwrap_err();
        assert_eq!(denied.0, StatusCode::NOT_FOUND);
        edit_local_message(&state, "owner", "first", true).await.unwrap();
        let doc = read_threads(&state).await.unwrap();
        assert_eq!(doc["t"]["localMessages"], json!([{"id":"first"}]));
        edit_local_message(&state, "owner", "first", false).await.unwrap();
        assert_eq!(read_threads(&state).await.unwrap()["t"]["localMessages"], json!([]));
        tokio::fs::remove_dir_all(home).await.unwrap();
    }

    #[test]
    fn local_reminder_is_visible_without_a_runtime_session() {
        let reminder = json!({
            "id":"reminder-1", "threadId":"thread-1", "role":"assistant",
            "parts":[{"type":"text","text":"Call the dentist"}]
        });
        let entry = json!({"localMessages":[reminder.clone()]});
        assert_eq!(thread_messages(&entry, "thread-1", "", &[]), vec![reminder]);
    }

    #[test]
    fn continuing_a_reminder_thread_preserves_the_original_reminder() {
        let entry = json!({"localMessages":[{"id":"reminder-1","role":"assistant"}]});
        let messages = thread_messages(&entry, "thread-1", "session-1", &[
            json!({"role":"user","content":"Thanks"}),
            json!({"role":"assistant","content":"You are welcome"}),
        ]);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["id"], "reminder-1");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["parts"][0]["text"], "You are welcome");
    }

    #[test]
    fn ordinary_threads_keep_the_existing_runtime_message_shape() {
        let history = [json!({"role":"assistant","content":"Hello"})];
        assert_eq!(
            thread_messages(&json!({}), "thread-1", "session-1", &history)[0]["id"],
            "msg_0_session-1"
        );
    }

    #[test]
    fn replayed_reasoning_lines_become_reasoning_parts_not_answer_text() {
        let s = '\u{2063}';
        let content = format!(
            "*{s}Let me think \\*hard\\*{s}*  \n*{s}Second line{s}*  \n\nThe answer is 4.\n"
        );
        let (thoughts, rest) = extract_thinking_and_text(&content);
        assert_eq!(thoughts, vec!["Let me think *hard*\nSecond line".to_string()]);
        assert_eq!(rest.trim(), "The answer is 4.");
        assert!(!rest.contains(s));
    }

    #[test]
    fn system_rows_are_not_shown_as_assistant_text() {
        let s = '\u{2063}';
        let history = vec![
            json!({"role": "user", "content": "Hello"}),
            json!({"role": "assistant", "content": "Hi there."}),
            json!({"role": "system", "content": "[auto] ## Credential Security & In-Chat UI Execution\n<Human Label>"}),
            json!({"role": "assistant", "content": format!("*{s}Nothing new to answer.{s}*  \n\n")}),
        ];
        let messages = history_to_messages("t", "s", &history);
        let text = serde_json::to_string(&messages).unwrap();
        assert!(!text.contains("Credential Security"), "{text}");
        assert!(!text.contains("Human Label"), "{text}");
        assert!(!text.contains(s), "sentinel leaked: {text}");
    }

    #[test]
    fn plain_text_is_left_alone_by_the_reasoning_splitter() {
        let (thoughts, rest) = extract_thinking_and_text("*emphasis* is fine\n");
        assert!(thoughts.is_empty());
        assert_eq!(rest, "*emphasis* is fine\n");
    }

    #[test]
    fn history_folds_assistant_and_tool_rows_preserving_reasoning_and_tools() {
        let history = [
            json!({"role": "user", "content": "Calculate 2+2"}),
            json!({
                "role": "assistant",
                "content": "<thinking>\nI need to use calculator\n</thinking>\nRunning tool...",
            }),
            json!({
                "role": "tool",
                "content": "{\"result\": 4}",
                "tool_data": {
                    "id": "calc-1",
                    "name": "calculator",
                    "input": {"expr": "2+2"}
                }
            }),
            json!({
                "role": "assistant",
                "content": "The answer is 4.",
                "response_stats": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "duration_secs": 1.25
                }
            }),
        ];
        let msgs = history_to_messages("t1", "s1", &history);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["parts"][0]["text"], "Calculate 2+2");

        assert_eq!(msgs[1]["id"], "msg_1_s1");
        assert_eq!(msgs[1]["role"], "assistant");
        let parts = msgs[1]["parts"].as_array().unwrap();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0]["type"], "reasoning");
        assert_eq!(parts[0]["text"], "I need to use calculator");
        assert_eq!(parts[1]["type"], "text");
        assert_eq!(parts[1]["text"], "Running tool...");
        assert_eq!(parts[2]["type"], "tool-calculator");
        assert_eq!(parts[2]["toolCallId"], "calc-1");
        assert_eq!(parts[2]["toolName"], "calculator");
        assert_eq!(parts[2]["state"], "output-available");
        assert_eq!(parts[2]["input"]["expr"], "2+2");
        assert_eq!(parts[2]["output"]["result"], 4);
        assert_eq!(parts[3]["type"], "text");
        assert_eq!(parts[3]["text"], "The answer is 4.");

        assert_eq!(msgs[1]["metadata"]["usage"]["promptTokens"], 100);
        assert_eq!(msgs[1]["metadata"]["usage"]["completionTokens"], 50);
        assert_eq!(msgs[1]["metadata"]["usage"]["totalTokens"], 150);
        assert_eq!(msgs[1]["metadata"]["durationMs"], 1250);
    }
}
