//! Heartbeat: a periodic background agent turn that runs the checklist in the
//! owner's `HEARTBEAT.md`.
//!
//! Each run uses a fresh runtime session (tools on, working dir = workspace) so
//! context never grows. The result lives in a dedicated "Heartbeat" thread:
//! a quiet run (`HEARTBEAT_OK`) leaves no trace; otherwise the assistant's
//! message is appended to the thread's `localMessages` and the thread is marked
//! `unread`. Routes: `GET /api/agent-home`, `PUT /api/agent-home/heartbeat`,
//! `POST /api/agent-home/heartbeat/run`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::{DateTime, NaiveTime, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};

use crate::agent_home::{self, file_lock, load_state, save_state};
use crate::state::{now_iso, ApiError, AppState, AuthUser};

pub const HEARTBEAT_TITLE: &str = "Heartbeat";
const TICK: Duration = Duration::from_secs(60);
const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_MESSAGE_CHARS: usize = 20_000;
const JOURNAL_BUDGET: usize = 3_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub interval_hours: f64,
    pub quiet_start: String,
    pub quiet_end: String,
    pub timezone: String,
}

impl Settings {
    pub fn default_for(timezone: &str) -> Self {
        Self {
            enabled: true,
            interval_hours: 4.0,
            quiet_start: "22:00".into(),
            quiet_end: "08:00".into(),
            timezone: timezone.to_string(),
        }
    }

    pub fn from_doc(doc: &Value, fallback_tz: &str) -> Self {
        let mut s = Self::default_for(fallback_tz);
        let Some(h) = doc.get("heartbeat") else { return s };
        if let Some(v) = h.get("enabled").and_then(Value::as_bool) {
            s.enabled = v;
        }
        if let Some(v) = h.get("intervalHours").and_then(Value::as_f64) {
            if v.is_finite() && v > 0.0 {
                s.interval_hours = v;
            }
        }
        if let Some(v) = h.get("quietStart").and_then(Value::as_str).filter(|v| parse_hhmm(v).is_some()) {
            s.quiet_start = v.to_string();
        }
        if let Some(v) = h.get("quietEnd").and_then(Value::as_str).filter(|v| parse_hhmm(v).is_some()) {
            s.quiet_end = v.to_string();
        }
        if let Some(v) = h.get("timezone").and_then(Value::as_str).filter(|v| v.parse::<Tz>().is_ok()) {
            s.timezone = v.to_string();
        }
        s
    }

    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "intervalHours": self.interval_hours,
            "quietStart": self.quiet_start,
            "quietEnd": self.quiet_end,
            "timezone": self.timezone,
        })
    }

    fn tz(&self) -> Tz {
        self.timezone.parse().unwrap_or(chrono_tz::UTC)
    }
}

pub fn parse_hhmm(value: &str) -> Option<NaiveTime> {
    let (h, m) = value.trim().split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0)
}

/// Quiet window `[start, end)`, wrapping midnight when `start > end`.
/// `start == end` means no quiet hours.
pub fn in_quiet_hours(local: NaiveTime, start: NaiveTime, end: NaiveTime) -> bool {
    if start == end {
        false
    } else if start < end {
        local >= start && local < end
    } else {
        local >= start || local < end
    }
}

fn quiet_at(settings: &Settings, instant: DateTime<Utc>) -> bool {
    let (Some(start), Some(end)) = (parse_hhmm(&settings.quiet_start), parse_hhmm(&settings.quiet_end)) else {
        return false;
    };
    let local = instant.with_timezone(&settings.tz()).time();
    in_quiet_hours(local, start, end)
}

fn interval(settings: &Settings) -> chrono::Duration {
    chrono::Duration::seconds((settings.interval_hours * 3600.0).round().max(60.0) as i64)
}

/// Pure schedule math: enabled, interval elapsed, not in quiet hours.
pub fn is_due(now: DateTime<Utc>, last: Option<DateTime<Utc>>, settings: &Settings) -> bool {
    if !settings.enabled || quiet_at(settings, now) {
        return false;
    }
    match last {
        None => true,
        Some(last) => now - last >= interval(settings),
    }
}

/// When the next automatic run is expected (None when disabled).
pub fn next_due_at(now: DateTime<Utc>, last: Option<DateTime<Utc>>, settings: &Settings) -> Option<DateTime<Utc>> {
    if !settings.enabled {
        return None;
    }
    let mut candidate = last.map(|l| l + interval(settings)).unwrap_or(now).max(now);
    // Walk forward minute-by-minute out of quiet hours (at most 24h).
    let mut guard = 0;
    while quiet_at(settings, candidate) && guard < 24 * 60 {
        candidate += chrono::Duration::minutes(1);
        guard += 1;
    }
    Some(candidate)
}

/// A quiet run: empty reply or exactly `HEARTBEAT_OK`.
pub fn is_heartbeat_ok(text: &str) -> bool {
    let t = text.trim().trim_matches('`').trim();
    t.is_empty() || t == "HEARTBEAT_OK"
}

pub fn build_prompt(heartbeat_md: &str, date: &str, tz: &str, journal: &str) -> String {
    let checklist = agent_home::strip_comment_lines(heartbeat_md);
    let journal = if journal.trim().is_empty() { "(none yet)" } else { journal.trim() };
    format!(
        "It's heartbeat time. Run the checklist in HEARTBEAT.md now:\n\n{checklist}\n\nToday is {date} ({tz}). Recent journal: {journal}"
    )
}

/// Last two journal files (`journal/YYYY-MM-DD.md`), newest content favored,
/// within a character budget.
pub fn recent_journal(workspace: &Path, budget: usize) -> String {
    let dir = workspace.join("journal");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter(|e| {
                    e.file_type().map(|t| t.is_file()).unwrap_or(false)
                        && e.file_name().to_string_lossy().ends_with(".md")
                })
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let recent: Vec<_> = files.into_iter().rev().take(2).collect();
    let mut parts = Vec::new();
    let mut remaining = budget;
    for path in recent {
        if remaining == 0 {
            break;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let chars: Vec<char> = text.trim().chars().collect();
        let take = chars.len().min(remaining);
        let tail: String = chars[chars.len() - take..].iter().collect();
        remaining -= take;
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        parts.push(format!("[{name}]\n{tail}"));
    }
    parts.reverse();
    parts.join("\n\n")
}

fn parse_time(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value?.as_str()?.parse::<DateTime<Utc>>().ok()
}

// ---------------------------------------------------------------------------
// Running a heartbeat
// ---------------------------------------------------------------------------

static RUNNING: AtomicBool = AtomicBool::new(false);

struct RunGuard;
impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
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

/// Run one tools-on agent turn in a fresh session and return the final
/// assistant text (the text after the last tool call).
async fn heartbeat_turn(state: &AppState, prompt: String) -> Result<(String, String), ApiError> {
    use crate::runtime::{TurnPlan, TurnUpdate};
    use amiro_sdk::ApiEvent;
    let mut turn = crate::runtime::start_turn(
        state.clone(),
        TurnPlan {
            session_id: None,
            working_dir: state.workspace.to_string_lossy().to_string(),
            expose_tools: crate::runtime::expose_tools(),
            model: None,
            prompt,
            images: Vec::new(),
            tool_results: Vec::new(),
            system_reminder: None,
        },
    )
    .await?;
    let session = turn
        .session
        .await
        .map_err(|_| ApiError(StatusCode::BAD_GATEWAY, "runtime closed before creating the heartbeat session".into()))?
        .map_err(|m| ApiError(StatusCode::BAD_GATEWAY, m))?;
    let mut guard = SessionGuard { state: state.clone(), session_id: session.session_id.clone(), completed: false };
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
                if text.chars().count() < MAX_MESSAGE_CHARS {
                    text.push_str(&delta);
                }
            }
            TurnUpdate::Event(ApiEvent::TextReplace { text: replacement, .. }) => {
                after_tool = false;
                text = replacement.chars().take(MAX_MESSAGE_CHARS).collect();
            }
            TurnUpdate::Error(message) => return Err(ApiError(StatusCode::BAD_GATEWAY, message)),
            TurnUpdate::Done(_) => {
                guard.completed = true;
                return Ok((text, session.session_id));
            }
            _ => {}
        }
    }
    Err(ApiError(StatusCode::BAD_GATEWAY, "runtime ended without a completed heartbeat turn".into()))
}

/// Create the Heartbeat thread once (remembering its id in agent-home.json).
async fn ensure_thread(state: &AppState, owner_id: &str) -> Result<String, ApiError> {
    let _guard = file_lock().lock().await;
    let mut doc = load_state(state).await?;
    if let Some(id) = doc.get("threadId").and_then(Value::as_str) {
        if crate::threads::get_entry(state, id).await?.is_some() {
            return Ok(id.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    crate::threads::upsert_entry(
        state,
        &id,
        json!({
            "sessionId": "",
            "userId": owner_id,
            "title": HEARTBEAT_TITLE,
            "heartbeat": true,
            "unread": false,
            "localMessages": [],
            "createdAt": now,
            "lastMessageAt": now,
            "archived": false,
            "workingDir": state.workspace.to_string_lossy().to_string(),
        }),
    )
    .await?;
    doc["threadId"] = json!(id);
    save_state(state, &doc).await?;
    Ok(id)
}

async fn append_message(state: &AppState, thread_id: &str, text: &str) -> Result<(), ApiError> {
    let _guard = state.store.lock().await;
    let mut doc = crate::threads::read_threads(state).await?;
    let entry = doc
        .get_mut(thread_id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "heartbeat thread missing".into()))?;
    let now = now_iso();
    let message = json!({
        "id": format!("heartbeat_{}", uuid::Uuid::new_v4()),
        "threadId": thread_id,
        "role": "assistant",
        "parts": [{"type": "text", "text": text}],
        "createdAt": now,
    });
    match entry.get_mut("localMessages").and_then(Value::as_array_mut) {
        Some(list) => list.push(message),
        None => entry["localMessages"] = json!([message]),
    }
    entry["unread"] = json!(true);
    entry["lastMessageAt"] = json!(now);
    entry["archived"] = json!(false);
    crate::threads::write_threads(state, &doc).await
}

async fn record(state: &AppState, result: &str, error: Option<&str>) {
    let _guard = file_lock().lock().await;
    if let Ok(mut doc) = load_state(state).await {
        doc["lastHeartbeatAt"] = json!(now_iso());
        doc["lastResult"] = json!(result);
        doc["lastError"] = error.map(|e| json!(e)).unwrap_or(Value::Null);
        if let Err(e) = save_state(state, &doc).await {
            tracing::warn!(error = %e.1, "failed to record heartbeat result");
        }
    }
}

/// Run one heartbeat now. `result` is one of `quiet`, `message`, `error`, or
/// `skipped` (with a `reason`). Does not check the schedule; the loop does.
pub async fn run_heartbeat(state: &AppState) -> Value {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return json!({"result": "skipped", "reason": "already running"});
    }
    let _running = RunGuard;
    let Some(owner) = agent_home::owner_user(state).await else {
        return json!({"result": "skipped", "reason": "no owner account"});
    };
    let owner_id = owner.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    agent_home::seed(state).await;
    let md = match tokio::fs::read_to_string(state.workspace.join("HEARTBEAT.md")).await {
        Ok(md) => md,
        Err(_) => return json!({"result": "skipped", "reason": "HEARTBEAT.md is missing"}),
    };
    if crate::runtime::any_session_busy(state).await {
        return json!({"result": "skipped", "reason": "a turn is in flight"});
    }
    let doc = load_state(state).await.unwrap_or(json!({}));
    let tz_name = agent_home::owner_timezone(state, Some(&owner), &doc).await;
    let settings = Settings::from_doc(&doc, &tz_name);
    let date = Utc::now().with_timezone(&settings.tz()).format("%Y-%m-%d").to_string();
    let ws = state.workspace.clone();
    let journal = tokio::task::spawn_blocking(move || recent_journal(&ws, JOURNAL_BUDGET))
        .await
        .unwrap_or_default();
    let prompt = build_prompt(&md, &date, &settings.timezone, &journal);

    let outcome = tokio::time::timeout(TURN_TIMEOUT, heartbeat_turn(state, prompt)).await;
    let (text, session_id) = match outcome {
        Ok(Ok(done)) => done,
        Ok(Err(error)) => {
            tracing::warn!(error = %error.1, "heartbeat turn failed");
            record(state, "error", Some(&error.1)).await;
            return json!({"result": "error", "error": error.1});
        }
        Err(_) => {
            record(state, "error", Some("timed out")).await;
            return json!({"result": "error", "error": "heartbeat timed out"});
        }
    };
    // The exchange lives only in the throwaway session; archive it so it never
    // shows up in the visible thread list.
    let _ = crate::runtime::archive_session(state, &session_id).await;
    if is_heartbeat_ok(&text) {
        record(state, "quiet", None).await;
        return json!({"result": "quiet"});
    }
    let saved = async {
        let thread_id = ensure_thread(state, &owner_id).await?;
        append_message(state, &thread_id, text.trim()).await?;
        Ok::<String, ApiError>(thread_id)
    }
    .await;
    match saved {
        Ok(thread_id) => {
            record(state, "message", None).await;
            json!({"result": "message", "threadId": thread_id, "text": text.trim()})
        }
        Err(error) => {
            record(state, "error", Some(&error.1)).await;
            json!({"result": "error", "error": error.1})
        }
    }
}

/// Spawn the minute loop. Seeds the agent home first.
pub fn spawn_heartbeat(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            let doc = match load_state(&state).await {
                Ok(doc) => doc,
                Err(_) => continue,
            };
            let owner = agent_home::owner_user(&state).await;
            if owner.is_none() {
                continue;
            }
            let tz = agent_home::owner_timezone(&state, owner.as_ref(), &doc).await;
            let settings = Settings::from_doc(&doc, &tz);
            let last = parse_time(doc.get("lastHeartbeatAt"));
            if last.is_none() {
                // First sighting: start the clock instead of firing at once.
                let _guard = file_lock().lock().await;
                if let Ok(mut fresh) = load_state(&state).await {
                    if fresh.get("lastHeartbeatAt").is_none() {
                        fresh["lastHeartbeatAt"] = json!(now_iso());
                        let _ = save_state(&state, &fresh).await;
                    }
                }
                continue;
            }
            if !is_due(Utc::now(), last, &settings) {
                continue;
            }
            if !state.workspace.join("HEARTBEAT.md").is_file() {
                continue;
            }
            let outcome = run_heartbeat(&state).await;
            if outcome["result"] == "skipped" {
                tracing::debug!(?outcome, "heartbeat skipped");
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

fn require_owner(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(Value::as_str) == Some("admin") {
        Ok(())
    } else {
        Err(ApiError(StatusCode::FORBIDDEN, "owner only".into()))
    }
}

fn file_info(workspace: &Path, name: &str) -> Value {
    match std::fs::symlink_metadata(workspace.join(name)) {
        Ok(md) if md.is_file() => json!({
            "name": name,
            "exists": true,
            "size": md.len(),
            "modifiedAt": md.modified().ok().map(|t| DateTime::<Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        }),
        _ => json!({"name": name, "exists": false, "size": 0, "modifiedAt": Value::Null}),
    }
}

async fn heartbeat_view(state: &AppState) -> Result<Value, ApiError> {
    let doc = load_state(state).await?;
    let owner = agent_home::owner_user(state).await;
    let tz = agent_home::owner_timezone(state, owner.as_ref(), &doc).await;
    let settings = Settings::from_doc(&doc, &tz);
    let last = parse_time(doc.get("lastHeartbeatAt"));
    let mut view = settings.to_json();
    view["lastHeartbeatAt"] = doc.get("lastHeartbeatAt").cloned().unwrap_or(Value::Null);
    view["lastResult"] = doc.get("lastResult").cloned().unwrap_or(Value::Null);
    view["threadId"] = doc.get("threadId").cloned().unwrap_or(Value::Null);
    view["nextDueAt"] = next_due_at(Utc::now(), last, &settings)
        .map(|t| json!(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .unwrap_or(Value::Null);
    Ok(view)
}

async fn get_agent_home(State(state): State<AppState>, _user: AuthUser) -> Result<Json<Value>, ApiError> {
    let ws = state.workspace.clone();
    let files: Vec<Value> = ["IDENTITY.md", "SOUL.md", "USER.md", "NOW.md", "HEARTBEAT.md", "BOOTSTRAP.md"]
        .iter()
        .map(|name| file_info(&ws, name))
        .collect();
    let journal_count = std::fs::read_dir(ws.join("journal"))
        .map(|rd| rd.filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".md")).count())
        .unwrap_or(0);
    Ok(Json(json!({
        "files": files,
        "journalCount": journal_count,
        "heartbeat": heartbeat_view(&state).await?,
    })))
}

/// Validate and merge a partial settings body into the stored heartbeat block.
pub fn apply_patch(current: &Settings, body: &Value) -> Result<Settings, String> {
    let mut next = current.clone();
    if let Some(v) = body.get("enabled") {
        next.enabled = v.as_bool().ok_or("enabled must be a boolean")?;
    }
    if let Some(v) = body.get("intervalHours") {
        let hours = v.as_f64().ok_or("intervalHours must be a number")?;
        if !(0.25..=168.0).contains(&hours) {
            return Err("intervalHours must be between 0.25 and 168".into());
        }
        next.interval_hours = hours;
    }
    for (key, slot) in [("quietStart", &mut next.quiet_start), ("quietEnd", &mut next.quiet_end)] {
        if let Some(v) = body.get(key) {
            let s = v.as_str().filter(|s| parse_hhmm(s).is_some()).ok_or(format!("{key} must be HH:MM"))?;
            *slot = s.to_string();
        }
    }
    if let Some(v) = body.get("timezone") {
        let s = v.as_str().filter(|s| s.parse::<Tz>().is_ok()).ok_or("timezone must be an IANA name")?;
        next.timezone = s.to_string();
    }
    Ok(next)
}

async fn put_heartbeat(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    {
        let _guard = file_lock().lock().await;
        let mut doc = load_state(&state).await?;
        let owner = agent_home::owner_user(&state).await;
        let tz = agent_home::owner_timezone(&state, owner.as_ref(), &doc).await;
        let current = Settings::from_doc(&doc, &tz);
        let next = apply_patch(&current, &body).map_err(|m| ApiError(StatusCode::BAD_REQUEST, m))?;
        doc["heartbeat"] = next.to_json();
        save_state(&state, &doc).await?;
    }
    Ok(Json(json!({"heartbeat": heartbeat_view(&state).await?})))
}

async fn run_now(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let outcome = run_heartbeat(&state).await;
    Ok(Json(json!({"result": outcome["result"].clone(), "outcome": outcome, "heartbeat": heartbeat_view(&state).await?})))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/agent-home", get(get_agent_home))
        .route("/api/agent-home/heartbeat", put(put_heartbeat))
        .route("/api/agent-home/heartbeat/run", post(run_now))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }
    fn settings() -> Settings {
        Settings::default_for("UTC")
    }

    #[test]
    fn quiet_hours_wrap_midnight() {
        let (s, e) = (parse_hhmm("22:00").unwrap(), parse_hhmm("08:00").unwrap());
        assert!(in_quiet_hours(parse_hhmm("23:30").unwrap(), s, e));
        assert!(in_quiet_hours(parse_hhmm("03:00").unwrap(), s, e));
        assert!(!in_quiet_hours(parse_hhmm("08:00").unwrap(), s, e));
        assert!(!in_quiet_hours(parse_hhmm("12:00").unwrap(), s, e));
        let (s, e) = (parse_hhmm("13:00").unwrap(), parse_hhmm("14:00").unwrap());
        assert!(in_quiet_hours(parse_hhmm("13:30").unwrap(), s, e));
        assert!(!in_quiet_hours(parse_hhmm("14:00").unwrap(), s, e));
        assert!(!in_quiet_hours(parse_hhmm("10:00").unwrap(), s, s));
    }

    #[test]
    fn due_math() {
        let s = settings();
        assert!(is_due(at("2026-01-01T12:00:00Z"), None, &s));
        assert!(!is_due(at("2026-01-01T12:00:00Z"), Some(at("2026-01-01T09:00:00Z")), &s));
        assert!(is_due(at("2026-01-01T12:00:00Z"), Some(at("2026-01-01T08:00:00Z")), &s));
        // quiet hours
        assert!(!is_due(at("2026-01-01T23:00:00Z"), None, &s));
        let mut off = s.clone();
        off.enabled = false;
        assert!(!is_due(at("2026-01-01T12:00:00Z"), None, &off));
        // timezone shifts the window: 23:00Z is 08:00 in Tokyo, quiet over.
        let mut tokyo = s.clone();
        tokyo.timezone = "Asia/Tokyo".into();
        assert!(is_due(at("2026-01-01T23:00:00Z"), None, &tokyo));
    }

    #[test]
    fn next_due_skips_quiet_hours() {
        let s = settings();
        let next = next_due_at(at("2026-01-01T21:00:00Z"), Some(at("2026-01-01T20:00:00Z")), &s).unwrap();
        assert_eq!(next, at("2026-01-02T08:00:00Z"));
        let mut off = s;
        off.enabled = false;
        assert!(next_due_at(at("2026-01-01T12:00:00Z"), None, &off).is_none());
    }

    #[test]
    fn heartbeat_ok_detection() {
        assert!(is_heartbeat_ok("HEARTBEAT_OK"));
        assert!(is_heartbeat_ok("  HEARTBEAT_OK\n"));
        assert!(is_heartbeat_ok(""));
        assert!(is_heartbeat_ok("   "));
        assert!(!is_heartbeat_ok("HEARTBEAT_OK, but also: your tax form is due"));
        assert!(!is_heartbeat_ok("Heads up about Friday."));
    }

    #[test]
    fn prompt_strips_comments() {
        let p = build_prompt("_ secret note\n# Heartbeat\n\n- [ ] Check NOW.md\n", "2026-03-04", "UTC", "");
        assert!(p.starts_with("It's heartbeat time. Run the checklist in HEARTBEAT.md now:\n\n# Heartbeat"));
        assert!(!p.contains("secret note"));
        assert!(p.contains("Today is 2026-03-04 (UTC). Recent journal: (none yet)"));
    }

    #[test]
    fn journal_takes_last_two_within_budget() {
        let ws = std::env::temp_dir().join(format!("amiro-hb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join("journal")).unwrap();
        for (d, c) in [("2026-01-01", "old"), ("2026-01-02", "mid"), ("2026-01-03", "new")] {
            std::fs::write(ws.join(format!("journal/{d}.md")), c).unwrap();
        }
        let j = recent_journal(&ws, 3000);
        assert!(!j.contains("old") && j.contains("mid") && j.contains("new"));
        assert!(j.find("mid").unwrap() < j.find("new").unwrap());
        std::fs::write(ws.join("journal/2026-01-04.md"), "x".repeat(5000)).unwrap();
        assert!(recent_journal(&ws, 3000).chars().filter(|c| *c == 'x').count() <= 3000);
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn patch_validates() {
        let s = settings();
        let n = apply_patch(&s, &json!({"intervalHours": 2, "quietStart": "23:00", "enabled": false})).unwrap();
        assert!(!n.enabled && n.interval_hours == 2.0 && n.quiet_start == "23:00");
        assert!(apply_patch(&s, &json!({"quietEnd": "8am"})).is_err());
        assert!(apply_patch(&s, &json!({"timezone": "Mars/Base"})).is_err());
        assert!(apply_patch(&s, &json!({"intervalHours": 0})).is_err());
    }
}
