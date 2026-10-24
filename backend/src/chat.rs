//! Chat routes: /api/chat, /api/chat/temporary, /api/chat/title,
//! /api/chat/export, /api/chat/openai-realtime.
//!
//! Model output is the Vercel AI SDK UI Message Stream over SSE, byte-shaped
//! like the adapter's: `data: <json>\n\n` frames plus a final `data: [DONE]`,
//! with the `X-Vercel-Ai-Ui-Message-Stream: v1` header.
//!
//! Every turn is executed by the owned Amiro runtime through
//! [`crate::runtime`]; nothing here fabricates assistant text. When the runtime
//! is unavailable or refuses a turn, the stream carries an `error` frame and
//! ends, and the caller's UI shows a real failure.

use std::convert::Infallible;
use std::path::Path as FsPath;
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use futures::stream::Stream;
use serde_json::{json, Value};

use crate::routes::fsbrowse::{is_denied, is_inside_roots, resolve_browse_roots};
use crate::runtime::{self, TurnPlan, TurnUpdate, TurnUsage};
use crate::state::{ApiError, AppState, AuthUser};
use crate::threads;

const KEEPALIVE: Duration = Duration::from_secs(15);

fn uid_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

/// Share the runtime's no-inference prompt-title fallback while it starts.
/// A request to make something happen later or on a cadence, or to ask how
/// a schedule went.
fn is_scheduling_request(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    [
        "schedule",
        "remind me",
        "reminder",
        "every day",
        "every morning",
        "every evening",
        "every night",
        "every week",
        "every weekday",
        "weekdays at",
        "every monday",
        "every tuesday",
        "every wednesday",
        "every thursday",
        "every friday",
        "every saturday",
        "every sunday",
        "every hour",
        "every month",
        "each morning",
        "daily at",
        "briefing",
        "wrap-up",
        "wrap up",
        "cron",
    ]
    .iter()
    .any(|k| p.contains(k))
}

fn derive_title(text: &str) -> String {
    amiro_session_types::prompt_title(text).unwrap_or_else(|| "New Chat".to_string())
}

fn parts_of(message: &Value) -> &[Value] {
    message
        .get("parts")
        .and_then(|parts| parts.as_array())
        .map(|parts| parts.as_slice())
        .unwrap_or(&[])
}

fn extract_text(message: &Value) -> String {
    parts_of(message)
        .iter()
        .filter(|part| part.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|part| part.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Tool results returned by the client after it answered tool cards. Mirrors
/// the AI SDK shape: `tool-<name>` parts in state `output-available`.
fn extract_tool_results(message: &Value) -> Vec<(String, String)> {
    parts_of(message)
        .iter()
        .filter_map(|part| {
            let kind = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let is_tool = kind.starts_with("tool-") || kind == "dynamic-tool";
            if !is_tool || part.get("state").and_then(|s| s.as_str()) != Some("output-available") {
                return None;
            }
            let call_id = part.get("toolCallId").and_then(|c| c.as_str())?.to_string();
            let output = match part.get("output") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            Some((call_id, output))
        })
        .collect()
}

/// Inline data-URL attachments become runtime images; URLs become prompt text.
fn split_attachments(attachments: Option<&Value>) -> (Vec<(String, String)>, Vec<String>) {
    let mut images = Vec::new();
    let mut extra_text = Vec::new();
    for attachment in attachments
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
    {
        let Some(url) = attachment.get("url").and_then(|u| u.as_str()) else {
            continue;
        };
        if let Some(rest) = url.strip_prefix("data:") {
            if let Some((meta, data)) = rest.split_once(";base64,") {
                let media_type = attachment
                    .get("mediaType")
                    .and_then(|m| m.as_str())
                    .unwrap_or(meta)
                    .to_string();
                images.push((media_type, data.to_string()));
                continue;
            }
        }
        extra_text.push(format!("[attachment: {url}]"));
    }
    (images, extra_text)
}

/// Validate a workspace directory the client asked the turn to run in.
///
/// Fail-closed: an absolute path inside the configured browse roots, not on the
/// deny list, and an existing directory. No silent fallback to another folder.
pub(crate) fn validate_working_dir(raw: &str) -> Result<String, ApiError> {
    let path = FsPath::new(raw);
    if !path.is_absolute() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "working directory must be an absolute path".into(),
        ));
    }
    if is_denied(path) {
        return Err(ApiError(StatusCode::FORBIDDEN, "access denied".into()));
    }
    let roots = resolve_browse_roots();
    if !is_inside_roots(path, &roots) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "working directory is outside the allowed browse roots".into(),
        ));
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        ApiError(
            StatusCode::BAD_REQUEST,
            format!("working directory is not reachable: {error}"),
        )
    })?;
    if !canonical.is_dir() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "working directory is not a directory".into(),
        ));
    }
    Ok(canonical.to_string_lossy().to_string())
}

fn frame(value: Value) -> Result<Event, Infallible> {
    Ok(Event::default().data(value.to_string()))
}

fn done_frame() -> Result<Event, Infallible> {
    Ok(Event::default().data("[DONE]"))
}

/// Build the SSE response with the AI SDK stream header the frontend expects.
fn sse_response<S>(stream: S) -> Response
where
    S: Stream<Item = Result<Event, Infallible>> + Send + 'static,
{
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(KEEPALIVE).text("keepalive"))
        .into_response();
    response.headers_mut().insert(
        "x-vercel-ai-ui-message-stream",
        HeaderValue::from_static("v1"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// Cancels the runtime turn when the browser goes away mid-turn.
struct CancelGuard {
    state: AppState,
    session_id: String,
    armed: bool,
}

impl CancelGuard {
    fn new(state: AppState, session_id: String) -> Self {
        Self {
            state,
            session_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if self.armed {
            runtime::cancel_session(self.state.clone(), self.session_id.clone());
        }
    }
}

fn usage_metadata(usage: Option<TurnUsage>) -> Option<Value> {
    usage.and_then(|usage| serde_json::to_value(usage).ok())
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async fn chat_handler(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let thread_id = body
        .get("id")
        .or_else(|| body.get("threadId"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if thread_id.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "id is required".into()));
    }
    let uid = uid_of(&user);

    let entry = threads::get_entry(&state, &thread_id).await?;
    if let Some(entry) = &entry {
        if !threads::entry_owned(entry, &uid) {
            return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into()));
        }
    }

    // A thread that already belongs to an agent keeps it; the body only picks
    // the agent for a brand-new thread. A team agent always works in its own
    // folder, so a client folder can never point it at another agent's files.
    let agent_id = entry
        .as_ref()
        .and_then(|entry| entry.get("agentId"))
        .or_else(|| body.get("agentId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let agent_dir = match agent_id.as_deref() {
        Some(id) => crate::routes::agents::working_dir_for(&state, id)
            .await?
            .map(|dir| dir.to_string_lossy().to_string()),
        None => None,
    };
    // A team agent's turn runs on its own runtime: its providers, connectors,
    // keys, memory and sessions (docs/multi-agent-team/03-per-agent-config.md).
    let agent_runtime = agent_dir.is_some();
    let state_for_stream = match agent_id.as_deref() {
        Some(id) if agent_runtime => crate::routes::agents::scoped_state(&state, id).await?,
        _ => state.clone(),
    };
    // A team agent gets only its container tools (possibly none), never the
    // runtime's host tools. See `sandbox.rs`. It must read the agent-scoped
    // state, so only the agent's own connectors are ever offered.
    let agent_tools = match (&agent_id, &agent_dir) {
        (Some(id), Some(_)) => crate::sandbox::AgentToolset::for_agent(&state_for_stream, id).await?,
        _ => None,
    };
    let is_channel = entry
        .as_ref()
        .and_then(|entry| entry.get("channel"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    let requested_dir = if agent_dir.is_some() {
        None
    } else {
        body.get("workingDir")
            .or_else(|| body.get("projectDirectory"))
            .or_else(|| body.get("workspaceRoot"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(validate_working_dir)
            .transpose()?
    };

    let message = body.get("message").cloned().unwrap_or(json!({}));
    let user_text = extract_text(&message);
    let tool_results = extract_tool_results(&message);
    let (images, extra_text) = split_attachments(body.get("attachments"));
    let attachments_raw = body.get("attachments").cloned();
    let prompt = std::iter::once(user_text.clone())
        .chain(extra_text)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    let chat_model = body.get("chatModel").cloned().unwrap_or(json!({}));
    let requested_model = runtime::resolve_model(
        chat_model
            .get("provider")
            .and_then(|p| p.as_str())
            .unwrap_or(""),
        chat_model
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or(""),
    );
    crate::schedules::remember_chat_model(
        &state,
        chat_model
            .get("provider")
            .and_then(|p| p.as_str())
            .unwrap_or(""),
        chat_model
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or(""),
    )
    .await;

    let permission_mode = body
        .get("permissionMode")
        .and_then(|mode| mode.as_str())
        .unwrap_or("auto")
        .to_string();
    let tools = runtime::expose_tools();
    let mode_ok = !tools || permission_mode == "auto" || permission_mode == "edit";

    let response_id = uuid::Uuid::new_v4().to_string();
    // Threads from before agents had their own runtime hold a session on the
    // shared runtime; such a thread starts a new session on the agent's.
    let stale_session = agent_runtime
        && entry.as_ref().and_then(|e| e.get("runtime")).and_then(Value::as_str) != Some("agent");
    let mentions_arr = body
        .get("mentions")
        .and_then(|mentions| mentions.as_array())
        .cloned()
        .unwrap_or_default();

    let stream = async_stream::stream! {
        yield frame(json!({"type": "start", "messageId": response_id}));
        // Nothing to answer: no text, no attachments and no tool-card answers.
        // The browser's auto-resume can fire one of these after a turn; letting
        // it through made the runtime fabricate an "[auto]" turn that carried
        // the capability guidance and later showed up in reloaded transcripts.
        if prompt.trim().is_empty() && images.is_empty() && tool_results.is_empty() {
            yield frame(json!({"type": "finish"}));
            yield done_frame();
            return;
        }
        if !mode_ok {
            yield frame(json!({"type": "start-step"}));
            yield frame(json!({"type": "text-start", "id": response_id}));
            yield frame(json!({
                "type": "text-delta",
                "id": response_id,
                "delta": "This backend runs tools automatically. Switch the permission mode to \"auto\" (or \"edit\") to start the turn.",
            }));
            yield frame(json!({"type": "text-end", "id": response_id}));
            yield frame(json!({"type": "finish-step"}));
            yield frame(json!({"type": "finish"}));
            yield done_frame();
            return;
        }

        // Decide the session: reuse the thread's session unless the user moved
        // the thread to a different folder, which the runtime cannot do in place.
        let previous_session = entry
            .as_ref()
            .and_then(|entry| entry.get("sessionId"))
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty() && !stale_session)
            .map(str::to_string);
        let stored_dir = state_for_stream.workspace.to_string_lossy().to_string();
        let stored_dir = match agent_dir.clone() {
            Some(dir) => dir,
            None => entry
                .as_ref()
                .and_then(|entry| entry.get("workingDir"))
                .and_then(|value| value.as_str())
                .unwrap_or(&stored_dir)
                .to_string(),
        };
        let rotation = requested_dir
            .as_deref()
            .map(|dir| dir != stored_dir)
            .unwrap_or(false);
        let session_id = if rotation { None } else { previous_session.clone() };
        let working_dir = requested_dir.clone().unwrap_or(stored_dir);

        let mut reminder_blocks: Vec<String> = vec![
            crate::agent::build_capability_guidance_block(&state_for_stream.home),
        ];
        if !mentions_arr.is_empty() {
            let names: Vec<String> = mentions_arr
                .iter()
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                .map(str::to_string)
                .collect();
            if !names.is_empty() {
                reminder_blocks.push(format!("The user referenced: {}", names.join(", ")));
            }
            for mention in &mentions_arr {
                if mention.get("type").and_then(|t| t.as_str()) == Some("skill") {
                    if let Some(skill_name) = mention.get("name").and_then(|n| n.as_str()) {
                        if let Some((resolved_name, source, skill_body)) =
                            crate::routes::skills::resolve_skill_for_turn(
                                &state_for_stream,
                                &uid,
                                skill_name,
                                Some(FsPath::new(&working_dir)),
                            )
                            .await
                        {
                            let clipped: String = skill_body.chars().take(12_000).collect();
                            reminder_blocks.push(format!(
                                "User-selected instruction set: \"{resolved_name}\" (stored by Amiro, source {source})\n\
                                 --- begin \"{resolved_name}\" ---\n{clipped}\n--- end \"{resolved_name}\" ---"
                            ));
                        }
                    }
                }
            }
        } else {
            let lower = prompt.to_lowercase();
            let mut auto_skill: Option<&str> = None;

            if lower.contains("visualize")
                || lower.contains("visualise")
                || lower.contains("diagram")
                || lower.contains("flowchart")
                || lower.contains("architecture diagram")
                || lower.contains("visual explainer")
                || lower.contains("draw a ")
                || lower.contains("draw an ")
            {
                auto_skill = Some("visualize");
            } else if is_scheduling_request(&prompt) {
                auto_skill = Some("schedules");
            } else if lower.contains("connect model")
                || lower.contains("configure model")
                || lower.contains("add model")
                || lower.contains("set up model")
                || lower.contains("setup model")
                || lower.contains("llm provider")
                || lower.contains("provider setup")
                || lower.contains("change model")
                || lower.contains("switch model")
            {
                auto_skill = Some("llm-provider-setup");
            } else if lower.contains("voice")
                || lower.contains("text to speech")
                || lower.contains("tts")
                || lower.contains("speech to text")
                || lower.contains("stt")
                || lower.contains("elevenlabs")
                || lower.contains("deepgram")
                || lower.contains("read aloud")
            {
                auto_skill = Some("voice-setup");
            } else if lower.contains("search provider")
                || lower.contains("web search")
                || lower.contains("tavily")
                || lower.contains("brave search")
                || lower.contains("serper")
                || lower.contains("firecrawl")
                || lower.contains("searxng")
            {
                auto_skill = Some("web-search-setup");
            } else if lower.contains("mcp")
                || lower.contains("connector")
                || lower.contains("composio")
                || lower.contains("connect linear")
                || lower.contains("connect notion")
                || lower.contains("connect figma")
                || lower.contains("connect github")
            {
                auto_skill = Some("mcp-setup");
            }

            if let Some(skill_id) = auto_skill {
                if let Some((resolved_name, source, skill_body)) =
                    crate::routes::skills::resolve_skill_for_turn(
                        &state_for_stream,
                        &uid,
                        skill_id,
                        Some(FsPath::new(&working_dir)),
                    )
                    .await
                {
                    let clipped: String = skill_body.chars().take(12_000).collect();
                    reminder_blocks.push(format!(
                        "Auto-activated skill for this request: \"{resolved_name}\" (source {source})\n\
                         --- begin \"{resolved_name}\" ---\n{clipped}\n--- end \"{resolved_name}\" ---"
                    ));
                }
            }
        }
        // Best-effort: also keep a copy of sent files in the agent's workspace.
        let saved_attachments =
            crate::agent_home::save_chat_attachments(&state_for_stream, attachments_raw.as_ref()).await;
        if let Some(note) = crate::agent_home::attachment_reminder(&saved_attachments) {
            reminder_blocks.push(note);
        }
        let reminder = reminder_blocks
            .into_iter()
            .filter(|b| !b.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");

        let plan = TurnPlan {
            session_id,
            working_dir: working_dir.clone(),
            expose_tools: tools,
            model: requested_model.clone(),
            prompt: prompt.clone(),
            images,
            tool_results,
            system_reminder: Some(reminder).filter(|reminder| !reminder.is_empty()),
            agent_tools: agent_tools.clone(),
        };

        let turn = match runtime::start_turn(state_for_stream.clone(), plan).await {
            Ok(turn) => turn,
            Err(error) => {
                yield frame(json!({"type": "error", "errorText": error.1}));
                yield frame(json!({"type": "finish"}));
                yield done_frame();
                return;
            }
        };

        let session = match turn.session.await {
            Ok(Ok(session)) => session,
            Ok(Err(message)) => {
                yield frame(json!({"type": "error", "errorText": message}));
                yield frame(json!({"type": "finish"}));
                yield done_frame();
                return;
            }
            Err(_) => {
                yield frame(json!({"type": "error", "errorText": "Amiro runtime turn did not start"}));
                yield frame(json!({"type": "finish"}));
                yield done_frame();
                return;
            }
        };

        let now = crate::state::now_iso();
        let mut patch = json!({
            "sessionId": session.session_id,
            "userId": uid,
            "lastMessageAt": now,
            "archived": false,
        });
        if let Some(dir) = session.working_dir.as_deref() {
            patch["workingDir"] = json!(dir);
        } else {
            patch["workingDir"] = json!(working_dir);
        }
        if let Some(id) = agent_id.as_deref() {
            patch["agentId"] = json!(id);
        }
        if agent_runtime {
            patch["runtime"] = json!("agent");
        }
        if entry.as_ref().and_then(|e| e.get("heartbeat")).and_then(|v| v.as_bool()) == Some(true) {
            patch["unread"] = json!(false);
        } else if is_channel {
            // A channel keeps the agent's name as its title.
        } else if previous_session.is_none() {
            patch["title"] = json!(derive_title(&user_text));
            patch["titleSource"] = json!("runtime");
            patch["createdAt"] = json!(now);
        }
        if session.created {
            if let Some(previous) = previous_session.as_deref() {
                patch["previousSessionId"] = json!(previous);
            }
        }
        if let Err(error) = threads::upsert_entry(&state_for_stream, &thread_id, patch).await {
            yield frame(json!({"type": "error", "errorText": error.1}));
            yield frame(json!({"type": "finish"}));
            yield done_frame();
            return;
        }
        {
            let initial_title = entry
                .as_ref()
                .and_then(|e| e.get("title"))
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| derive_title(&user_text));
            let short_name = crate::swarm::extract_session_name(&session.session_id);
            let icon = short_name.map(crate::swarm::session_icon);
            yield frame(json!({
                "type": "data-thread-title",
                "data": {
                    "threadId": thread_id,
                    "title": initial_title,
                    "sessionId": &session.session_id,
                    "shortName": short_name,
                    "icon": icon
                },
                "transient": true
            }));
        }
        if session.created {
            if let Some(previous) = previous_session.as_deref() {
                // Archive the session left behind by a folder change. Best
                // effort: the thread mapping already points at the new session.
                let _ = runtime::archive_session(&state_for_stream, previous).await;
            }
        }

        let turn_started = std::time::Instant::now();
        let mut tool_count: u64 = 0;
        let mut guard = CancelGuard::new(state_for_stream.clone(), session.session_id.clone());
        // The chat list shows this thread as working until the turn ends.
        let activity = crate::thread_activity::RunningGuard::start(&uid, &thread_id);
        let mut updates = turn.updates;
        let mut text_id = uuid::Uuid::new_v4().to_string();
        let mut reasoning_id = uuid::Uuid::new_v4().to_string();
        let mut text_open = false;
        let mut reasoning_open = false;
        let mut tool_inputs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut tool_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut tool_input_emitted: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut usage: Option<TurnUsage> = None;
        let mut failed = false;
        let mut stopped_message: Option<String> = None;
        let mut assistant_preview = String::new();

        yield frame(json!({"type": "start-step"}));
        while let Some(update) = updates.recv().await {
            match update {
                TurnUpdate::Event(event) => {
                    use amiro_sdk::ApiEvent;
                    match event {
                        ApiEvent::TextDelta { text, .. } | ApiEvent::TextReplace { text, .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                            if !text_open {
                                text_id = uuid::Uuid::new_v4().to_string();
                                yield frame(json!({"type": "text-start", "id": text_id}));
                                text_open = true;
                            }
                            if assistant_preview.chars().count() < 280 {
                                assistant_preview.extend(text.chars().take(280usize.saturating_sub(assistant_preview.chars().count())));
                            }
                            yield frame(json!({"type": "text-delta", "id": text_id, "delta": text}));
                        }
                        ApiEvent::TextDone { .. } => {
                            if text_open {
                                yield frame(json!({"type": "text-end", "id": text_id}));
                                text_open = false;
                            }
                        }
                        ApiEvent::ReasoningDelta { text, .. } => {
                            if !reasoning_open {
                                reasoning_id = uuid::Uuid::new_v4().to_string();
                                yield frame(json!({"type": "reasoning-start", "id": reasoning_id}));
                                reasoning_open = true;
                            }
                            yield frame(json!({"type": "reasoning-delta", "id": reasoning_id, "delta": text}));
                        }
                        ApiEvent::ReasoningDone { .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                        }
                        ApiEvent::ToolStart { call_id, name, .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                            if text_open {
                                yield frame(json!({"type": "text-end", "id": text_id}));
                                text_open = false;
                            }
                            tool_names.insert(call_id.clone(), name.clone());
                            yield frame(json!({"type": "tool-input-start", "toolCallId": call_id, "toolName": name, "providerExecuted": true}));
                        }
                        ApiEvent::ToolInputDelta { call_id, delta, .. } => {
                            tool_inputs.entry(call_id.clone()).or_default().push_str(&delta);
                            yield frame(json!({"type": "tool-input-delta", "toolCallId": call_id, "inputTextDelta": delta}));
                        }
                        ApiEvent::ToolExec { call_id, name, .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                            if text_open {
                                yield frame(json!({"type": "text-end", "id": text_id}));
                                text_open = false;
                            }
                            tool_names.insert(call_id.clone(), name.clone());
                            let raw_input = tool_inputs.get(&call_id).map(|s| s.as_str()).unwrap_or("");
                            let parsed_input: Value = serde_json::from_str(raw_input).unwrap_or_else(|_| json!({}));
                            yield frame(json!({"type": "tool-input-available", "toolCallId": call_id, "toolName": name, "input": parsed_input, "providerExecuted": true}));
                            tool_input_emitted.insert(call_id);
                            tool_count += 1;
                        }
                        ApiEvent::ToolCall { call_id, name, input, .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                            if text_open {
                                yield frame(json!({"type": "text-end", "id": text_id}));
                                text_open = false;
                            }
                            tool_names.insert(call_id.clone(), name.clone());
                            if crate::sandbox::is_agent_tool(&name) {
                                // Answered by the backend in the agent's container, not by the UI.
                                yield frame(json!({"type": "tool-input-available", "toolCallId": call_id, "toolName": name, "input": input, "providerExecuted": true}));
                            } else {
                                yield frame(json!({"type": "tool-input-available", "toolCallId": call_id, "toolName": name, "input": input}));
                            }
                            tool_input_emitted.insert(call_id);
                            tool_count += 1;
                        }
                        ApiEvent::ToolDone { call_id, name, output, error, .. } => {
                            if !tool_input_emitted.contains(&call_id) {
                                let tool_name = tool_names.get(&call_id).cloned().unwrap_or_else(|| name.clone());
                                if !tool_names.contains_key(&call_id) {
                                    yield frame(json!({"type": "tool-input-start", "toolCallId": call_id, "toolName": tool_name, "providerExecuted": true}));
                                }
                                let raw_input = tool_inputs.get(&call_id).map(|s| s.as_str()).unwrap_or("");
                                let parsed_input: Value = serde_json::from_str(raw_input).unwrap_or_else(|_| json!({}));
                                yield frame(json!({"type": "tool-input-available", "toolCallId": call_id, "toolName": tool_name, "input": parsed_input, "providerExecuted": true}));
                                tool_input_emitted.insert(call_id.clone());
                                tool_count += 1;
                            }
                            let parsed_output = match serde_json::from_str::<Value>(&output) {
                                Ok(v) if v.is_object() || v.is_array() => v,
                                _ => Value::String(output),
                            };
                            if let Some(error) = error {
                                yield frame(json!({"type": "tool-output-error", "toolCallId": call_id, "errorText": error, "providerExecuted": true}));
                            } else {
                                yield frame(json!({"type": "tool-output-available", "toolCallId": call_id, "output": parsed_output, "providerExecuted": true}));
                                let resolved_tool = tool_names.get(&call_id).map(|s| s.as_str()).unwrap_or(name.as_str());
                                if matches!(resolved_tool, "todo" | "todo_write") {
                                    if let Some(todo_title) = runtime::todo_session_title(&state_for_stream, &session.session_id) {
                                        if let Ok(Some(title)) = threads::sync_runtime_title(&state_for_stream, &thread_id, &uid, &session.session_id, &todo_title).await {
                                            let short_name = crate::swarm::extract_session_name(&session.session_id);
                                            let icon = short_name.map(crate::swarm::session_icon);
                                            yield frame(json!({"type":"data-thread-title","data":{"threadId":thread_id,"title":title,"sessionId":&session.session_id,"shortName":short_name,"icon":icon},"transient":true}));
                                        }
                                    }
                                }
                            }
                        }
                        ApiEvent::TokenUsage { input, output, cache_read_input, .. } => {
                            let read = cache_read_input.unwrap_or(0);
                            usage = Some(TurnUsage {
                                prompt_tokens: input + read,
                                completion_tokens: output,
                                total_tokens: input + read + output,
                            });
                        }
                        ApiEvent::TurnStopped { message, .. } => {
                            stopped_message = Some(message);
                        }
                        ApiEvent::SessionRenamed { session_id, display_title, .. } => {
                            if session_id == session.session_id {
                                if let Ok(Some(title)) = threads::sync_runtime_title(&state_for_stream, &thread_id, &uid, &session_id, &display_title).await {
                                    let short_name = crate::swarm::extract_session_name(&session_id);
                                    let icon = short_name.map(crate::swarm::session_icon);
                                    yield frame(json!({"type":"data-thread-title","data":{"threadId":thread_id,"title":title,"sessionId":session_id,"shortName":short_name,"icon":icon},"transient":true}));
                                }
                            }
                        }
                        ApiEvent::Error { code, message } => {
                            failed = true;
                            yield frame(json!({"type": "error", "errorText": format!("{code:?}: {message}")}));
                        }
                        _ => {}
                    }
                }
                TurnUpdate::Error(message) => {
                    failed = true;
                    yield frame(json!({"type": "error", "errorText": message}));
                }
                TurnUpdate::Done(turn_usage) => {
                    usage = turn_usage.or(usage);
                    break;
                }
            }
        }
        guard.disarm();

        if let Some(message) = stopped_message {
            failed = true;
            yield frame(json!({"type": "error", "errorText": message}));
        }
        if text_open {
            yield frame(json!({"type": "text-end", "id": text_id}));
        }
        if reasoning_open {
            yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
        }
        yield frame(json!({"type": "finish-step"}));

        // Prompt titles and todo-derived labels are owned by the runtime.
        // Read metadata once after the turn, never launch a cosmetic model turn.
        let mut resolved_title = derive_title(&user_text);
        if let Ok(Some(title)) = runtime::session_title(&state_for_stream, &session.session_id).await {
            resolved_title = title.clone();
            if let Ok(Some(title)) = threads::sync_runtime_title(&state_for_stream, &thread_id, &uid, &session.session_id, &title).await {
                resolved_title = title.clone();
                let short_name = crate::swarm::extract_session_name(&session.session_id);
                let icon = short_name.map(crate::swarm::session_icon);
                yield frame(json!({"type":"data-thread-title","data":{"threadId":thread_id,"title":title,"sessionId":&session.session_id,"shortName":short_name,"icon":icon},"transient":true}));
            }
        }
        // Whether the user is watching this chat right now, read once so the
        // notification and the chat list agree.
        let watching = crate::notify::presence::is_thread_focused(&uid, &thread_id);
        if !failed && !assistant_preview.trim().is_empty() {
            // Chat replies go through the signal pipeline. A reply the user
            // is watching is suppressed there; one they left is notified.
            let _ = crate::notify::emit_signal(
                &state_for_stream,
                &uid,
                &serde_json::json!({
                    "sourceChannel": "assistant_tool",
                    "sourceContextId": thread_id.clone(),
                    "sourceEventName": "chat.assistant_reply",
                    "title": &resolved_title,
                    "body": assistant_preview.trim(),
                    "urgency": "normal",
                    "threadId": thread_id,
                    "attentionHints": {
                        "requiresAction": false,
                        "isAsyncBackground": false,
                        "visibleInSourceNow": watching,
                    },
                    "routingIntent": "single_channel",
                }),
            )
            .await;
        }
        activity.finish(&state_for_stream, failed).await;
        let mut metadata = json!({
            "chatModel": chat_model,
            "model": requested_model,
            "durationMs": turn_started.elapsed().as_millis() as u64,
            "toolCount": tool_count,
        });
        if let Some(usage) = usage_metadata(usage) {
            metadata["usage"] = usage;
        }
        // The real context window and occupancy, from the runtime, so the
        // UI never has to guess a limit from the model's name.
        if let Some(context) = runtime::context_snapshot(&state_for_stream, &session.session_id).await {
            metadata["context"] = context;
        }
        yield frame(json!({"type": "finish", "messageMetadata": metadata}));
        yield done_frame();
    };

    Ok(sse_response(stream))
}

async fn chat_temporary(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let uid = uid_of(&user);
    let messages = body
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let user_text = messages
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(|r| r.as_str()) == Some("user"))
        .map(extract_text)
        .or_else(|| messages.last().map(extract_text))
        .unwrap_or_default();
    let (images, extra_text) = split_attachments(body.get("attachments"));
    let prompt = std::iter::once(user_text)
        .chain(extra_text)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let chat_model = body.get("chatModel").cloned().unwrap_or(json!({}));
    let requested_model = runtime::resolve_model(
        chat_model
            .get("provider")
            .and_then(|p| p.as_str())
            .unwrap_or(""),
        chat_model
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or(""),
    );
    let instructions = body
        .get("instructions")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .chars()
        .take(8000)
        .collect::<String>();
    let working_dir = state.workspace.to_string_lossy().to_string();
    let response_id = uuid::Uuid::new_v4().to_string();
    let state_for_stream = state.clone();

    let stream = async_stream::stream! {
        yield frame(json!({"type": "start", "messageId": response_id}));
        let plan = TurnPlan {
            session_id: None,
            working_dir,
            expose_tools: runtime::expose_tools(),
            model: requested_model.clone(),
            prompt,
            images,
            tool_results: Vec::new(),
            system_reminder: Some(instructions).filter(|value| !value.is_empty()),
            agent_tools: None,
        };
        let turn = match runtime::start_turn(state_for_stream.clone(), plan).await {
            Ok(turn) => turn,
            Err(error) => {
                yield frame(json!({"type": "error", "errorText": error.1}));
                yield frame(json!({"type": "finish"}));
                yield done_frame();
                return;
            }
        };
        let session_id = match turn.session.await {
            Ok(Ok(session)) => session.session_id,
            Ok(Err(message)) => {
                yield frame(json!({"type": "error", "errorText": message}));
                yield frame(json!({"type": "finish"}));
                yield done_frame();
                return;
            }
            Err(_) => {
                yield frame(json!({"type": "error", "errorText": "Amiro runtime turn did not start"}));
                yield frame(json!({"type": "finish"}));
                yield done_frame();
                return;
            }
        };
        let _ = uid;
        let turn_started = std::time::Instant::now();
        let mut tool_count: u64 = 0;
        let mut updates = turn.updates;
        yield frame(json!({"type": "start-step"}));
        let mut text_id = uuid::Uuid::new_v4().to_string();
        let mut reasoning_id = uuid::Uuid::new_v4().to_string();
        let mut text_open = false;
        let mut reasoning_open = false;
        let mut tool_inputs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut tool_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        let mut tool_input_emitted: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut usage: Option<TurnUsage> = None;
        while let Some(update) = updates.recv().await {
            match update {
                TurnUpdate::Event(event) => {
                    use amiro_sdk::ApiEvent;
                    match event {
                        ApiEvent::TextDelta { text, .. } | ApiEvent::TextReplace { text, .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                            if !text_open {
                                text_id = uuid::Uuid::new_v4().to_string();
                                yield frame(json!({"type": "text-start", "id": text_id}));
                                text_open = true;
                            }
                            yield frame(json!({"type": "text-delta", "id": text_id, "delta": text}));
                        }
                        ApiEvent::TextDone { .. } => {
                            if text_open {
                                yield frame(json!({"type": "text-end", "id": text_id}));
                                text_open = false;
                            }
                        }
                        ApiEvent::ReasoningDelta { text, .. } => {
                            if !reasoning_open {
                                reasoning_id = uuid::Uuid::new_v4().to_string();
                                yield frame(json!({"type": "reasoning-start", "id": reasoning_id}));
                                reasoning_open = true;
                            }
                            yield frame(json!({"type": "reasoning-delta", "id": reasoning_id, "delta": text}));
                        }
                        ApiEvent::ReasoningDone { .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                        }
                        ApiEvent::ToolStart { call_id, name, .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                            if text_open {
                                yield frame(json!({"type": "text-end", "id": text_id}));
                                text_open = false;
                            }
                            tool_names.insert(call_id.clone(), name.clone());
                            yield frame(json!({"type": "tool-input-start", "toolCallId": call_id, "toolName": name, "providerExecuted": true}));
                        }
                        ApiEvent::ToolInputDelta { call_id, delta, .. } => {
                            tool_inputs.entry(call_id.clone()).or_default().push_str(&delta);
                            yield frame(json!({"type": "tool-input-delta", "toolCallId": call_id, "inputTextDelta": delta}));
                        }
                        ApiEvent::ToolExec { call_id, name, .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                            if text_open {
                                yield frame(json!({"type": "text-end", "id": text_id}));
                                text_open = false;
                            }
                            tool_names.insert(call_id.clone(), name.clone());
                            let raw_input = tool_inputs.get(&call_id).map(|s| s.as_str()).unwrap_or("");
                            let parsed_input: Value = serde_json::from_str(raw_input).unwrap_or_else(|_| json!({}));
                            yield frame(json!({"type": "tool-input-available", "toolCallId": call_id, "toolName": name, "input": parsed_input, "providerExecuted": true}));
                            tool_input_emitted.insert(call_id);
                            tool_count += 1;
                        }
                        ApiEvent::ToolCall { call_id, name, input, .. } => {
                            if reasoning_open {
                                yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
                                reasoning_open = false;
                            }
                            if text_open {
                                yield frame(json!({"type": "text-end", "id": text_id}));
                                text_open = false;
                            }
                            tool_names.insert(call_id.clone(), name.clone());
                            if crate::sandbox::is_agent_tool(&name) {
                                // Answered by the backend in the agent's container, not by the UI.
                                yield frame(json!({"type": "tool-input-available", "toolCallId": call_id, "toolName": name, "input": input, "providerExecuted": true}));
                            } else {
                                yield frame(json!({"type": "tool-input-available", "toolCallId": call_id, "toolName": name, "input": input}));
                            }
                            tool_input_emitted.insert(call_id);
                            tool_count += 1;
                        }
                        ApiEvent::ToolDone { call_id, name, output, error, .. } => {
                            if !tool_input_emitted.contains(&call_id) {
                                let tool_name = tool_names.get(&call_id).cloned().unwrap_or_else(|| name.clone());
                                if !tool_names.contains_key(&call_id) {
                                    yield frame(json!({"type": "tool-input-start", "toolCallId": call_id, "toolName": tool_name, "providerExecuted": true}));
                                }
                                let raw_input = tool_inputs.get(&call_id).map(|s| s.as_str()).unwrap_or("");
                                let parsed_input: Value = serde_json::from_str(raw_input).unwrap_or_else(|_| json!({}));
                                yield frame(json!({"type": "tool-input-available", "toolCallId": call_id, "toolName": tool_name, "input": parsed_input, "providerExecuted": true}));
                                tool_input_emitted.insert(call_id.clone());
                                tool_count += 1;
                            }
                            let parsed_output = match serde_json::from_str::<Value>(&output) {
                                Ok(v) if v.is_object() || v.is_array() => v,
                                _ => Value::String(output),
                            };
                            if let Some(error) = error {
                                yield frame(json!({"type": "tool-output-error", "toolCallId": call_id, "errorText": error, "providerExecuted": true}));
                            } else {
                                yield frame(json!({"type": "tool-output-available", "toolCallId": call_id, "output": parsed_output, "providerExecuted": true}));
                            }
                        }
                        ApiEvent::TokenUsage { input, output, cache_read_input, .. } => {
                            let read = cache_read_input.unwrap_or(0);
                            usage = Some(TurnUsage {
                                prompt_tokens: input + read,
                                completion_tokens: output,
                                total_tokens: input + read + output,
                            });
                        }
                        ApiEvent::TurnStopped { message, .. } => {
                            yield frame(json!({"type": "error", "errorText": message}));
                        }
                        ApiEvent::Error { code, message } => {
                            yield frame(json!({"type": "error", "errorText": format!("{code:?}: {message}")}));
                        }
                        _ => {}
                    }
                }
                TurnUpdate::Error(message) => {
                    yield frame(json!({"type": "error", "errorText": message}));
                }
                TurnUpdate::Done(turn_usage) => {
                    usage = turn_usage.or(usage);
                    break;
                }
            }
        }
        if text_open {
            yield frame(json!({"type": "text-end", "id": text_id}));
        }
        if reasoning_open {
            yield frame(json!({"type": "reasoning-end", "id": reasoning_id}));
        }
        yield frame(json!({"type": "finish-step"}));
        let mut metadata = json!({
            "chatModel": chat_model,
            "model": requested_model,
            "durationMs": turn_started.elapsed().as_millis() as u64,
            "toolCount": tool_count,
        });
        if let Some(usage) = usage_metadata(usage) {
            metadata["usage"] = usage;
        }
        yield frame(json!({"type": "finish", "messageMetadata": metadata}));
        yield done_frame();

        // A temporary chat leaves nothing behind: the session is archived once
        // the turn is over.
        let _ = runtime::archive_session(&state_for_stream, &session_id).await;
    };

    Ok(sse_response(stream))
}

async fn chat_title(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let uid = uid_of(&user);
    let thread_id = body
        .get("threadId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    let message = body
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("hello")
        .to_string();

    let entry = threads::get_entry(&state, &thread_id)
        .await?
        .filter(|entry| threads::entry_owned(entry, &uid))
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "thread not found".into()))?;
    let _ = message; // Legacy callers may send text, but the runtime owns naming.
    let response_id = uuid::Uuid::new_v4().to_string();
    let state_for_stream = state.clone();
    let stream = async_stream::stream! {
        yield frame(json!({"type": "start", "messageId": response_id}));
        yield frame(json!({"type": "start-step"}));
        yield frame(json!({"type": "text-start", "id": response_id}));
        let mut title = entry.get("title").and_then(Value::as_str).unwrap_or("New Chat").to_string();
        if entry.get("titleSource").and_then(Value::as_str) != Some("manual") {
            if let Some(session_id) = entry.get("sessionId").and_then(Value::as_str) {
                match runtime::session_title(&state_for_stream, session_id).await {
                    Ok(Some(runtime_title)) => {
                        if let Ok(Some(applied)) = threads::sync_runtime_title(&state_for_stream, &thread_id, &uid, session_id, &runtime_title).await {
                            title = applied;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => yield frame(json!({"type": "data-title-unavailable", "data": {"reason": error.1}, "transient": true})),
                }
            }
        }
        yield frame(json!({"type": "text-delta", "id": response_id, "delta": title}));
        yield frame(json!({"type": "text-end", "id": response_id}));
        yield frame(json!({"type": "finish-step"}));
        yield frame(json!({"type": "finish"}));
        yield done_frame();
    };

    Ok(sse_response(stream))
}

async fn chat_export(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = uid_of(&user);
    let thread_id = body
        .get("threadId")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();

    let mut title = "Chat Export".to_string();
    let mut messages: Vec<Value> = Vec::new();
    if !thread_id.is_empty() {
        let entry = threads::get_entry(&state, &thread_id).await?;
        match entry {
            Some(entry) if threads::entry_owned(&entry, &uid) => {
                title = entry
                    .get("title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Chat Export")
                    .to_string();
                if let Some(session_id) = entry.get("sessionId").and_then(|value| value.as_str()) {
                    match runtime::get_history(&state, session_id).await {
                        Ok(history) => {
                            messages =
                                threads::history_to_messages(&thread_id, session_id, &history)
                        }
                        Err(error) => {
                            return Err(ApiError(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                format!("unable to read thread history: {}", error.1),
                            ));
                        }
                    }
                }
            }
            Some(_) => return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into())),
            None => return Err(ApiError(StatusCode::NOT_FOUND, "thread not found".into())),
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let record = json!({
        "id": id,
        "title": title,
        "exporterId": uid,
        "originalThreadId": if thread_id.is_empty() { Value::Null } else { json!(thread_id) },
        "threadId": if thread_id.is_empty() { Value::Null } else { json!(thread_id) },
        "createdAt": crate::state::now_iso(),
        "expiresAt": body.get("expiresAt").cloned().unwrap_or(Value::Null),
        "messages": messages,
        "commentCount": 0,
    });
    let path = state.home.join("store").join("exports.json");
    {
        let _lock = state.store.lock().await;
        let mut doc = crate::state::read_json(&path, json!({})).await?;
        if let Value::Object(ref mut map) = doc {
            map.insert(id.clone(), record);
        } else {
            let mut map = serde_json::Map::new();
            map.insert(id.clone(), record);
            doc = Value::Object(map);
        }
        crate::state::write_json(&path, &doc).await?;
    }
    Ok(Json(json!(id)))
}

async fn chat_openai_realtime(_user: AuthUser) -> Result<Json<Value>, ApiError> {
    Err(ApiError(
        StatusCode::NOT_IMPLEMENTED,
        "not supported on the Amiro runtime backend".into(),
    ))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/chat", post(chat_handler))
        .route("/api/chat/temporary", post(chat_temporary))
        .route("/api/chat/title", post(chat_title))
        .route("/api/chat/export", post(chat_export))
        .route("/api/chat/openai-realtime", post(chat_openai_realtime))
}

#[cfg(test)]
mod scheduling_request_tests {
    use super::is_scheduling_request;

    #[test]
    fn detects_scheduling_asks() {
        assert!(is_scheduling_request(
            "Send me a briefing every weekday at 8"
        ));
        assert!(is_scheduling_request("remind me Friday to file expenses"));
        assert!(is_scheduling_request("Why did my evening wrap-up fail?"));
        assert!(!is_scheduling_request("What's the capital of France?"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_follow_the_runtime_rule() {
        assert_eq!(derive_title("   "), "New Chat");
        assert_eq!(derive_title("hello   world"), "hello world");
        let long = "a".repeat(80);
        let title = derive_title(&long);
        assert_eq!(title.chars().count(), 65);
        assert!(title.ends_with('…'));
        assert_eq!(
            derive_title("<system-reminder>private</system-reminder> Fix titles"),
            "Fix titles"
        );
        assert_eq!(derive_title("/model test"), "New Chat");
    }

    #[test]
    fn data_url_attachments_become_images_and_urls_become_text() {
        let attachments = json!([
            {"url": "data:image/png;base64,AAAA", "mediaType": "image/png"},
            {"url": "https://example.test/a.png"}
        ]);
        let (images, extra) = split_attachments(Some(&attachments));
        assert_eq!(images, vec![("image/png".to_string(), "AAAA".to_string())]);
        assert_eq!(
            extra,
            vec!["[attachment: https://example.test/a.png]".to_string()]
        );
    }

    #[test]
    fn tool_results_require_output_available_state() {
        let message = json!({"parts": [
            {"type": "tool-read", "state": "output-available", "toolCallId": "c1", "output": {"ok": true}},
            {"type": "tool-read", "state": "input-available", "toolCallId": "c2", "output": "x"},
            {"type": "text", "text": "hi"}
        ]});
        let results = extract_tool_results(&message);
        assert_eq!(
            results,
            vec![("c1".to_string(), "{\"ok\":true}".to_string())]
        );
        assert_eq!(extract_text(&message), "hi");
    }
}
