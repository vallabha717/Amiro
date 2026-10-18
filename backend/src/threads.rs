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

fn history_msg_id(session_id: &str, index: usize) -> String {
    format!("msg_{}_{}", index, session_id)
}

fn parse_msg_id(id: &str) -> Option<(usize, String)> {
    let rest = id.strip_prefix("msg_")?;
    let (idx_str, sid) = rest.split_once('_')?;
    let idx: usize = idx_str.parse().ok()?;
    Some((idx, sid.to_string()))
}

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
                    for t in thinkings {
                        parts.push(json!({
                            "type": "reasoning",
                            "text": t,
                        }));
                    }
                    if !remaining.trim().is_empty() {
                        parts.push(json!({
                            "type": "text",
                            "text": if !content.contains("<thinking>") { content.to_string() } else { remaining.trim().to_string() },
                        }));
                    } else if !has_tools && parts.is_empty() {
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

async fn list_threads(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let doc = read_json(&threads_path(&state), json!({})).await?;
    let obj = doc.as_object().cloned().unwrap_or_default();
    let mut list: Vec<Value> = obj.iter().filter_map(|(id, e)| {
        if !owns(e, &uid) { return None; }
        Some(json!({
            "id": id,
            "title": e.get("title").and_then(|v| v.as_str()).unwrap_or("New Chat"),
            "userId": e.get("userId").and_then(|v| v.as_str()).unwrap_or(""),
            "createdAt": e.get("createdAt").cloned().unwrap_or(json!(crate::state::now_iso())),
            "lastMessageAt": e.get("lastMessageAt").or_else(|| e.get("createdAt")).cloned().unwrap_or(json!(crate::state::now_iso())),
            "archived": e.get("archived").and_then(|v| v.as_bool()).unwrap_or(false),
            "workingDir": e.get("workingDir").and_then(|v| v.as_str()).unwrap_or_else(|| state.workspace.to_str().unwrap_or("")),
        }))
    }).collect();
    list.sort_by(|a,b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(Json(json!(list)))
}

async fn get_thread(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let doc = read_json(&threads_path(&state), json!({})).await?;
    let entry = doc.get(&id).cloned().ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "thread not found".into()))?;
    if !owns(&entry, &uid) {
        return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into()));
    }
    let session_id = entry.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let history = if session_id.is_empty() {
        Vec::new()
    } else {
        crate::runtime::get_history(&state, session_id)
            .await
            .map_err(|error| {
                ApiError(
                    StatusCode::BAD_GATEWAY,
                    format!("unable to read thread history: {}", error.1),
                )
            })?
    };
    let messages = thread_messages(&entry, &id, session_id, &history);
    Ok(Json(json!({
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
    }
    let sid = entry.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    if !sid.is_empty() {
        let _ = crate::runtime::rename_session(&state, sid, title).await;
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
        if let Some(sid) = entry.get("sessionId").and_then(|v| v.as_str()) {
            let _ = crate::runtime::archive_session(&state, sid).await;
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
        if unarchived_only && e.get("archived").and_then(|v| v.as_bool()).unwrap_or(false) { return None; }
        Some(id.clone())
    }).collect();
    for id in &ids {
        if let Some(entry) = obj.get(id).cloned() {
            if let Some(sid) = entry.get("sessionId").and_then(|v| v.as_str()) {
                let _ = crate::runtime::archive_session(&state, sid).await;
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
                        crate::runtime::rewind_session(state, sid, 0).await?;
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
    let doc = read_json(&threads_path(&state), json!({})).await?;
    let owns_any = doc.as_object().map(|obj| obj.values().any(|e| e.get("sessionId").and_then(|v| v.as_str()) == Some(&sid) && owns(e, &uid))).unwrap_or(false);
    if !owns_any { return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into())); }
    crate::runtime::rewind_session(&state, &sid, idx).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "unable to delete message".into()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn truncate_msg(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Result<StatusCode, ApiError> {
    let uid = user_id(&user);
    let Some((idx, sid)) = parse_msg_id(&id) else {
        return edit_local_message(&state, &uid, &id, true).await;
    };
    let doc = read_json(&threads_path(&state), json!({})).await?;
    let owns_any = doc.as_object().map(|obj| obj.values().any(|e| e.get("sessionId").and_then(|v| v.as_str()) == Some(&sid) && owns(e, &uid))).unwrap_or(false);
    if !owns_any { return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into())); }
    crate::runtime::rewind_session(&state, &sid, idx+1).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "unable to truncate messages".into()))?;
    Ok(StatusCode::NO_CONTENT)
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
