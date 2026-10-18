//! Native durable scheduler: one-shot, cron, and interval schedules with
//! per-schedule IANA timezones.
//!
//! Design notes (contract v1):
//! - Storage is two atomic JSON files under `$AMIRO_HOME/store/`:
//!   `schedules.json` (`{id: Schedule}`) and `schedule-runs.json`
//!   (`{id: ScheduleRun}`). Every read-modify-write takes
//!   `AppState::store`, exactly like threads and background jobs.
//! - Cross-process safety is an OS advisory lock on
//!   `$AMIRO_HOME/scheduler.lock` (`std::fs::File::try_lock`). The active
//!   ticker holds it for its whole lifetime; HTTP mutations probe it and
//!   answer 409 when another live backend owns it. The OS releases the lock
//!   when the holder dies, so a standby backend takes over with no stale
//!   PID bookkeeping. Tick claims advance `nextRunAt` under both the file
//!   lock and the store lock, so two processes can never fire the same run.
//! - `once` accepts RFC3339 or naive `%Y-%m-%dT%H:%M[:%S]` wall time in the
//!   schedule's timezone, resolved via `Tz::from_local_datetime` (ambiguous
//!   and DST-gap times are rejected, never silently shifted). The normalized
//!   UTC RFC3339 instant is persisted.
//! - `cron` is standard 5-field Vixie cron (`min hour dom month dow`,
//!   Sunday is 0 or 7, DOM/DOW use OR semantics) evaluated by the `croner`
//!   crate in the schedule's timezone, so DST transitions behave like cron.
//! - Restart policy: runs left `running` by a crash become `interrupted`
//!   (never retried); overdue one-shots fire once on the first tick;
//!   recurring schedules recompute forward from now (no catch-up storms).
//! - Execution never bypasses safety: `execute` runs through
//!   `runtime::start_turn`, which forces the no-tools profile via
//!   `configure_tools`. There is no raw CLI spawn path here.
//! - Every firing persists a normal Amiro thread (`threads.json` with
//!   `userId`, title, and server-authored `localMessages`, readable even
//!   with no runtime session) and the run record carries its `threadId`, so
//!   results are always openable from the UI. Notify mode never depends on
//!   the runtime at all.
//!
//! Execution applies the persisted model route explicitly and fails closed if
//! it is removed from the deployment allowlist. Tools are disabled per session.

use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;

use axum::http::StatusCode;
use chrono::{DateTime, LocalResult, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::{read_json, write_json, ApiError, AppState};

pub const MAX_SCHEDULES_PER_OWNER: usize = 50;
const MAX_RUNS_STORED_PER_SCHEDULE: usize = 50;
const MAX_OUTPUT_PREVIEW_CHARS: usize = 2000;
const MAX_THREAD_TEXT_CHARS: usize = 8000;
const TICK_SECS: u64 = 15;
const STANDBY_RETRY_SECS: u64 = 30;
const MIN_INTERVAL_MINUTES: i64 = 5;
const MAX_INTERVAL_MINUTES: i64 = 43200;
const EXECUTE_TIMEOUT_SECS: u64 = 15 * 60;
const MAX_NAME_LEN: usize = 120;
const MAX_PROMPT_LEN: usize = 8000;
const MAX_MODEL_LEN: usize = 200;

// ---------------------------------------------------------------------------
// Types (camelCase on the wire, matching background-jobs/thread shapes)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ScheduleKind {
    #[serde(rename = "once")]
    Once { at: String },
    #[serde(rename = "cron")]
    Cron { expression: String },
    #[serde(rename = "interval")]
    Interval { minutes: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub prompt: String,
    pub mode: String,
    pub timezone: String,
    pub schedule: ScheduleKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Provenance: "user" (Schedules page / HTTP API, and every pre-existing
    /// row) or "agent" (created through the built-in `amiro` MCP server).
    #[serde(default = "default_created_by")]
    pub created_by: String,
    /// Chat thread the agent created this from, when it said so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_from_thread_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_created_by() -> String {
    "user".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub id: String,
    pub schedule_id: String,
    pub user_id: String,
    pub scheduled_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Errors and small helpers
// ---------------------------------------------------------------------------

fn bad(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

fn conflict(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::CONFLICT, message.into())
}

fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "schedule not found".into())
}

fn fmt_utc(dt: &DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

fn schedules_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("schedules.json")
}

fn runs_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("schedule-runs.json")
}

fn lock_path(state: &AppState) -> PathBuf {
    state.home.join("scheduler.lock")
}

// ---------------------------------------------------------------------------
// Cross-process ticker lock (OS advisory, auto-released on death)
// ---------------------------------------------------------------------------

struct SchedulerLease {
    _file: std::fs::File,
    ready: bool,
}
static SCHED_HOLDER: OnceLock<StdMutex<HashMap<PathBuf, SchedulerLease>>> = OnceLock::new();
fn holder() -> &'static StdMutex<HashMap<PathBuf, SchedulerLease>> {
    SCHED_HOLDER.get_or_init(|| StdMutex::new(HashMap::new()))
}
fn home_key(state: &AppState) -> PathBuf {
    std::fs::canonicalize(&state.home).unwrap_or_else(|_| state.home.clone())
}
struct SchedulerLeaseGuard(PathBuf);
impl Drop for SchedulerLeaseGuard {
    fn drop(&mut self) {
        if let Ok(mut leases) = holder().lock() {
            leases.remove(&self.0);
        }
    }
}
fn try_acquire(state: &AppState) -> Option<SchedulerLeaseGuard> {
    std::fs::create_dir_all(&state.home).ok()?;
    let key = home_key(state);
    let mut leases = holder().lock().ok()?;
    if leases.contains_key(&key) {
        return None;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(false);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(lock_path(state)).ok()?;
    file.try_lock().ok()?;
    leases.insert(
        key.clone(),
        SchedulerLease {
            _file: file,
            ready: false,
        },
    );
    Some(SchedulerLeaseGuard(key))
}
/// Mutations require a retained lifetime lease, never a transient lock probe.
pub fn mutation_allowed(state: &AppState) -> bool {
    holder()
        .lock()
        .ok()
        .and_then(|leases| leases.get(&home_key(state)).map(|lease| lease.ready))
        .unwrap_or(false)
}
fn require_mutation(state: &AppState) -> Result<(), ApiError> {
    if mutation_allowed(state) {
        Ok(())
    } else {
        Err(conflict("scheduler is starting or owned by another Amiro instance; retry on the active instance"))
    }
}

// ---------------------------------------------------------------------------
// In-process no-overlap guard (backed by the `running` run row for crashes)
// ---------------------------------------------------------------------------

static IN_FLIGHT: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();

fn in_flight() -> &'static StdMutex<HashSet<String>> {
    IN_FLIGHT.get_or_init(|| StdMutex::new(HashSet::new()))
}

/// Returns false when the schedule already has an in-flight execution here.
fn mark_running(id: &str) -> bool {
    in_flight().lock().unwrap().insert(id.to_string())
}

fn unmark(id: &str) {
    in_flight().lock().unwrap().remove(id);
}

fn is_running(id: &str) -> bool {
    in_flight().lock().unwrap().contains(id)
}

// ---------------------------------------------------------------------------
// Time math: timezones, one-shot parsing, cron, intervals
// ---------------------------------------------------------------------------

fn parse_timezone(name: &str) -> Result<Tz, ApiError> {
    name.trim().parse::<Tz>().map_err(|_| {
        bad(format!(
            "unknown timezone \"{name}\": use an IANA name such as UTC or America/New_York"
        ))
    })
}

/// Accept RFC3339 (any offset) or naive `%Y-%m-%dT%H:%M[:%S]` wall time in
/// `tz`. Ambiguous (fall-back) and nonexistent (spring-forward gap) local
/// times are rejected instead of silently shifted.
fn parse_once_at(raw: &str, tz: Tz) -> Result<DateTime<Utc>, ApiError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(bad("schedule.at is required for kind \"once\""));
    }
    if let Ok(dt) = s.parse::<DateTime<Utc>>() {
        return Ok(dt.with_timezone(&Utc));
    }
    for fmt in [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, fmt) {
            match tz.from_local_datetime(&naive) {
                LocalResult::Single(dt) => return Ok(dt.with_timezone(&Utc)),
                LocalResult::Ambiguous(_, _) => {
                    return Err(bad(format!(
                        "schedule.at is ambiguous in {tz}; use RFC3339 with an explicit UTC offset"
                    )))
                }
                LocalResult::None => {
                    return Err(bad(format!(
                        "schedule.at \"{s}\" does not exist in {tz} (DST spring-forward gap); pick another time"
                    )));
                }
            }
        }
    }
    Err(bad(format!(
        "schedule.at \"{s}\" must be RFC3339 (e.g. 2026-10-18T09:00:00Z) or naive wall time %Y-%m-%dT%H:%M in {tz}"
    )))
}

fn parse_cron(expression: &str) -> Result<Cron, ApiError> {
    let expr = expression.trim();
    if expr.is_empty() {
        return Err(bad("schedule.expression is required for kind \"cron\""));
    }
    if expr.split_whitespace().count() != 5 {
        return Err(bad(format!(
            "schedule.expression must have exactly 5 fields (min hour dom month dow), got {} field(s) in \"{expr}\"",
            expr.split_whitespace().count()
        )));
    }
    Cron::from_str(expr).map_err(|e| bad(format!("invalid cron expression \"{expr}\": {e}")))
}

/// Validate and normalize a schedule kind. The normalized `once.at` is the
/// UTC RFC3339 instant; cron is trimmed; interval minutes are range-checked.
fn normalize_kind(raw: &ScheduleKind, tz: Tz) -> Result<ScheduleKind, ApiError> {
    match raw {
        ScheduleKind::Once { at } => Ok(ScheduleKind::Once {
            at: fmt_utc(&parse_once_at(at, tz)?),
        }),
        ScheduleKind::Cron { expression } => {
            let cron = parse_cron(expression)?;
            // A pattern that can never match again is a dead schedule; refuse
            // it at creation instead of storing a row that never fires.
            let probe = Utc::now().with_timezone(&tz);
            if cron.find_next_occurrence(&probe, false).is_err() {
                return Err(bad(format!(
                    "cron expression \"{}\" never matches a future time",
                    expression.trim()
                )));
            }
            Ok(ScheduleKind::Cron {
                expression: expression.trim().to_string(),
            })
        }
        ScheduleKind::Interval { minutes } => {
            if *minutes < MIN_INTERVAL_MINUTES || *minutes > MAX_INTERVAL_MINUTES {
                return Err(bad(format!(
                    "schedule.minutes must be between {MIN_INTERVAL_MINUTES} and {MAX_INTERVAL_MINUTES}, got {minutes}"
                )));
            }
            Ok(ScheduleKind::Interval { minutes: *minutes })
        }
    }
}

/// Next fire time strictly after `from`, or `None` for a spent one-shot.
fn next_after(
    kind: &ScheduleKind,
    tz: Tz,
    from: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ApiError> {
    match kind {
        ScheduleKind::Once { at } => {
            let dt = parse_once_at(at, tz)?;
            Ok(if dt > from { Some(dt) } else { None })
        }
        ScheduleKind::Cron { expression } => {
            let cron = parse_cron(expression)?;
            let cursor = from.with_timezone(&tz);
            match cron.find_next_occurrence(&cursor, false) {
                Ok(next) => Ok(Some(next.with_timezone(&Utc))),
                Err(_) => Ok(None),
            }
        }
        ScheduleKind::Interval { minutes } => Ok(Some(from + chrono::Duration::minutes(*minutes))),
    }
}

/// Up to `count` fire times strictly after `from`, ascending. Bounded: at
/// most `count` cron iterations, so a request can never scan unbounded time.
fn next_n(
    kind: &ScheduleKind,
    tz: Tz,
    from: DateTime<Utc>,
    count: usize,
) -> Result<Vec<DateTime<Utc>>, ApiError> {
    match kind {
        ScheduleKind::Once { .. } => Ok(next_after(kind, tz, from)?.into_iter().collect()),
        ScheduleKind::Cron { expression } => {
            let cron = parse_cron(expression)?;
            let mut out = Vec::new();
            let mut cursor = from.with_timezone(&tz);
            for _ in 0..count {
                match cron.find_next_occurrence(&cursor, false) {
                    Ok(next) => {
                        out.push(next.with_timezone(&Utc));
                        cursor = next;
                    }
                    Err(_) => break,
                }
            }
            Ok(out)
        }
        ScheduleKind::Interval { minutes } => {
            let mut out = Vec::with_capacity(count);
            let mut cursor = from;
            for _ in 0..count {
                cursor = cursor + chrono::Duration::minutes(*minutes);
                out.push(cursor);
            }
            Ok(out)
        }
    }
}

fn parse_incoming_kind(value: &Value) -> Result<ScheduleKind, ApiError> {
    serde_json::from_value::<ScheduleKind>(value.clone()).map_err(|e| {
        bad(format!(
            "schedule must be one of {{kind:\"once\",at}}, {{kind:\"cron\",expression}} or {{kind:\"interval\",minutes}}: {e}"
        ))
    })
}

// ---------------------------------------------------------------------------
// Validation and model pinning
// ---------------------------------------------------------------------------

fn validate_mode(mode: &str) -> Result<(), ApiError> {
    if mode == "execute" || mode == "notify" || mode == "agent" {
        Ok(())
    } else {
        Err(bad(format!(
            "mode must be \"notify\", \"execute\" or \"agent\", got \"{mode}\""
        )))
    }
}

fn validate_name(name: &str) -> Result<(), ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        Err(bad("name is required"))
    } else if trimmed.chars().count() > MAX_NAME_LEN {
        Err(bad(format!(
            "name must be at most {MAX_NAME_LEN} characters"
        )))
    } else {
        Ok(())
    }
}

fn validate_prompt(prompt: &str) -> Result<(), ApiError> {
    if prompt.trim().is_empty() {
        Err(bad("prompt is required"))
    } else if prompt.chars().count() > MAX_PROMPT_LEN {
        Err(bad(format!(
            "prompt must be at most {MAX_PROMPT_LEN} characters"
        )))
    } else {
        Ok(())
    }
}

fn normalized_model(raw: &str) -> String {
    let raw = raw.trim();
    match raw.strip_prefix("openai-compatible:") {
        Some(rest) if rest.contains(':') => rest.to_string(),
        _ => raw.to_string(),
    }
}

fn validate_pinned_model(model: &str) -> Result<(), ApiError> {
    if model.len() > MAX_MODEL_LEN
        || !model
            .split_once(':')
            .is_some_and(|(provider, name)| !provider.is_empty() && !name.is_empty())
    {
        return Err(bad(
            "choose a provider-qualified model, for example openai-compatible:my-model",
        ));
    }
    if let Ok(allowed) = std::env::var("AMIRO_PINNED_MODELS") {
        if !allowed.trim().is_empty()
            && !allowed.split(',').any(|entry| {
                let entry = normalized_model(entry);
                entry == model
                    || (!entry.contains(':')
                        && model.split_once(':').is_some_and(|(_, name)| name == entry))
            })
        {
            return Err(bad("this model is not enabled for this deployment"));
        }
    }
    Ok(())
}

/// The model the owner last chatted with ("provider:model"). A schedule the
/// agent creates from chat runs on the model you were talking to, unless a
/// deployment default (AMIRO_DEFAULT_MODEL) says otherwise.
static LAST_CHAT_MODEL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn last_chat_model_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("last-chat-model.json")
}

/// Load the remembered chat model at startup.
pub async fn load_last_chat_model(state: &AppState) {
    if let Ok(doc) = read_json(&last_chat_model_path(state), json!({})).await {
        if let Some(model) = doc
            .get("model")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
        {
            if let Ok(mut slot) = LAST_CHAT_MODEL.lock() {
                *slot = Some(model.to_string());
            }
        }
    }
}

/// Remember the model a chat turn used (provider and model names, unqualified).
pub async fn remember_chat_model(state: &AppState, provider: &str, model: &str) {
    if provider.trim().is_empty() || model.trim().is_empty() {
        return;
    }
    let route = normalized_model(&format!("{}:{}", provider.trim(), model.trim()));
    if validate_pinned_model(&route).is_err() {
        return;
    }
    let changed = match LAST_CHAT_MODEL.lock() {
        Ok(mut slot) if slot.as_deref() != Some(route.as_str()) => {
            *slot = Some(route.clone());
            true
        }
        _ => false,
    };
    if changed {
        let _ = write_json(&last_chat_model_path(state), &json!({ "model": route })).await;
    }
}

fn last_chat_model() -> String {
    LAST_CHAT_MODEL
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_default()
}

/// Persist a concrete model route, never silently inherit a future default.
fn pin_model(body: &Value, mode: &str) -> Result<Option<String>, ApiError> {
    if mode != "execute" && mode != "agent" {
        return Ok(None);
    }
    let default = std::env::var("AMIRO_DEFAULT_MODEL")
        .ok()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(last_chat_model);
    let raw = match body.get("model") {
        Some(Value::String(raw)) if !raw.trim().is_empty() => raw.as_str(),
        Some(Value::Null) | None => default.as_str(),
        _ => return Err(bad("model must be a non-empty model route")),
    };
    let model = normalized_model(raw);
    validate_pinned_model(&model)?;
    Ok(Some(model))
}

// ---------------------------------------------------------------------------
// Store access (owner-scoped; cross-owner reads are 404, never leaked)
// ---------------------------------------------------------------------------

async fn load_schedules(state: &AppState) -> Result<Value, ApiError> {
    read_json(&schedules_path(state), json!({})).await
}

async fn load_runs(state: &AppState) -> Result<Value, ApiError> {
    read_json(&runs_path(state), json!({})).await
}

fn decode_schedule(id: &str, value: &Value) -> Option<Schedule> {
    serde_json::from_value::<Schedule>(value.clone())
        .ok()
        .map(|mut s| {
            s.id = id.to_string();
            s
        })
}

fn owned(schedule: &Schedule, uid: &str) -> bool {
    !uid.is_empty() && schedule.user_id == uid
}

fn api_schedule(schedule: &Schedule) -> Value {
    serde_json::to_value(schedule).unwrap_or(json!({}))
}

/// Wire shape for responses: the stored row plus the server-computed
/// `cadenceDescription` (never persisted).
fn public_schedule(schedule: &Schedule) -> Value {
    let mut value = api_schedule(schedule);
    let tz = schedule.timezone.parse::<Tz>().unwrap_or(chrono_tz::UTC);
    if let Some(map) = value.as_object_mut() {
        map.insert(
            "cadenceDescription".into(),
            json!(describe_cadence(&schedule.schedule, tz)),
        );
    }
    value
}

fn api_run(run: &ScheduleRun) -> Value {
    serde_json::to_value(run).unwrap_or(json!({}))
}

fn has_running_run(runs: &Value, schedule_id: &str) -> bool {
    runs.as_object()
        .map(|map| {
            map.values().any(|r| {
                r.get("scheduleId").and_then(|v| v.as_str()) == Some(schedule_id)
                    && r.get("status").and_then(|v| v.as_str()) == Some("running")
            })
        })
        .unwrap_or(false)
}

fn prune_runs(runs: &mut Value, schedule_id: &str) {
    let Some(map) = runs.as_object_mut() else {
        return;
    };
    let mut ids: Vec<(String, String)> = map
        .iter()
        .filter(|(_, r)| r.get("scheduleId").and_then(|v| v.as_str()) == Some(schedule_id))
        .map(|(id, r)| {
            (
                id.clone(),
                r.get("startedAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            )
        })
        .collect();
    ids.sort_by(|a, b| b.1.cmp(&a.1));
    for (id, _) in ids.into_iter().skip(MAX_RUNS_STORED_PER_SCHEDULE) {
        map.remove(&id);
    }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

pub async fn list_schedules(state: &AppState, uid: &str) -> Result<Vec<Value>, ApiError> {
    let doc = load_schedules(state).await?;
    let mut out: Vec<(String, Value)> = doc
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(id, v)| decode_schedule(id, v))
                .filter(|s| owned(s, uid))
                .map(|s| (s.created_at.clone(), public_schedule(&s)))
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

pub async fn get_schedule(
    state: &AppState,
    uid: &str,
    id: &str,
) -> Result<Option<Value>, ApiError> {
    let doc = load_schedules(state).await?;
    Ok(doc
        .get(id)
        .and_then(|v| decode_schedule(id, v))
        .filter(|s| owned(s, uid))
        .map(|s| public_schedule(&s)))
}

pub async fn create_schedule(state: &AppState, uid: &str, body: &Value) -> Result<Value, ApiError> {
    create_schedule_from(state, uid, body, "user", None).await
}

/// Same validation and persistence as the HTTP create, with explicit
/// provenance (`created_by` is "user" or "agent").
pub async fn create_schedule_from(
    state: &AppState,
    uid: &str,
    body: &Value,
    created_by: &str,
    created_from_thread_id: Option<String>,
) -> Result<Value, ApiError> {
    require_mutation(state)?;
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let prompt = body.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
    let mode = body.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    let timezone = body.get("timezone").and_then(|v| v.as_str()).unwrap_or("");
    validate_name(name)?;
    validate_prompt(prompt)?;
    validate_mode(mode)?;
    if timezone.trim().is_empty() {
        return Err(bad(
            "timezone is required (IANA name, e.g. UTC or America/New_York)",
        ));
    }
    let tz = parse_timezone(timezone)?;
    let kind_raw = body
        .get("schedule")
        .ok_or_else(|| bad("schedule is required"))?;
    let kind = normalize_kind(&parse_incoming_kind(kind_raw)?, tz)?;
    let model = pin_model(body, mode)?;
    let enabled = body
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let _guard = state.store.lock().await;
    let mut doc = load_schedules(state).await?;
    if !doc.is_object() {
        doc = json!({});
    }
    let owned_count = doc
        .as_object()
        .map(|map| {
            map.values()
                .filter_map(|v| v.get("userId").and_then(|u| u.as_str()))
                .filter(|owner| *owner == uid)
                .count()
        })
        .unwrap_or(0);
    if owned_count >= MAX_SCHEDULES_PER_OWNER {
        return Err(bad(format!(
            "schedule limit reached ({MAX_SCHEDULES_PER_OWNER} per user)"
        )));
    }
    let now = crate::state::now_iso();
    let id = uuid::Uuid::new_v4().to_string();
    let next_run_at = if enabled {
        next_after(&kind, tz, Utc::now())?.map(|dt| fmt_utc(&dt))
    } else {
        None
    };
    let schedule = Schedule {
        id: id.clone(),
        user_id: uid.to_string(),
        name: name.trim().to_string(),
        prompt: prompt.trim().to_string(),
        mode: mode.to_string(),
        timezone: timezone.trim().to_string(),
        schedule: kind,
        model,
        enabled,
        next_run_at,
        last_run_at: None,
        last_status: None,
        thread_id: None,
        created_by: created_by.to_string(),
        created_from_thread_id,
        created_at: now.clone(),
        updated_at: now,
    };
    if let Some(map) = doc.as_object_mut() {
        map.insert(id, api_schedule(&schedule));
    }
    write_json(&schedules_path(state), &doc).await?;
    Ok(public_schedule(&schedule))
}

pub async fn update_schedule(
    state: &AppState,
    uid: &str,
    id: &str,
    patch: &Value,
) -> Result<Value, ApiError> {
    require_mutation(state)?;
    let _guard = state.store.lock().await;
    let mut doc = load_schedules(state).await?;
    let existing = doc
        .get(id)
        .and_then(|v| decode_schedule(id, v))
        .filter(|s| owned(s, uid))
        .ok_or_else(not_found)?;
    let mut schedule = existing;

    let mut recompute = false;
    if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
        validate_name(name)?;
        schedule.name = name.trim().to_string();
    }
    if let Some(prompt) = patch.get("prompt").and_then(|v| v.as_str()) {
        validate_prompt(prompt)?;
        schedule.prompt = prompt.trim().to_string();
    }
    if let Some(mode) = patch.get("mode").and_then(|v| v.as_str()) {
        validate_mode(mode)?;
        schedule.mode = mode.to_string();
        if mode == "notify" {
            schedule.model = None;
        } else if patch.get("model").is_some() || schedule.model.is_none() {
            schedule.model = pin_model(patch, mode)?;
        }
    } else if patch.get("model").is_some()
        && (schedule.mode == "execute" || schedule.mode == "agent")
    {
        let mode = schedule.mode.clone();
        schedule.model = pin_model(patch, &mode)?;
    }
    if let Some(timezone) = patch.get("timezone").and_then(|v| v.as_str()) {
        if timezone.trim().is_empty() {
            return Err(bad(
                "timezone must be an IANA name such as UTC or America/New_York",
            ));
        }
        parse_timezone(timezone)?;
        if schedule.timezone != timezone.trim() {
            schedule.timezone = timezone.trim().to_string();
            recompute = true;
        }
    }
    if let Some(kind_raw) = patch.get("schedule") {
        let tz = parse_timezone(&schedule.timezone)?;
        schedule.schedule = normalize_kind(&parse_incoming_kind(kind_raw)?, tz)?;
        recompute = true;
    }
    if let Some(enabled) = patch.get("enabled").and_then(|v| v.as_bool()) {
        if schedule.enabled != enabled {
            schedule.enabled = enabled;
            recompute = true;
        }
    }
    if recompute {
        let tz = parse_timezone(&schedule.timezone)?;
        schedule.next_run_at = if schedule.enabled {
            next_after(&schedule.schedule, tz, Utc::now())?.map(|dt| fmt_utc(&dt))
        } else {
            schedule.next_run_at.clone()
        };
        // Re-enabling a recurring schedule with no pending fire recomputes it.
        if schedule.enabled && schedule.next_run_at.is_none() {
            schedule.next_run_at = match &schedule.schedule {
                ScheduleKind::Once { .. } => {
                    // A past one-shot stays due so it fires once on the tick.
                    let dt = match &schedule.schedule {
                        ScheduleKind::Once { at } => parse_once_at(at, tz).ok(),
                        _ => None,
                    };
                    dt.filter(|d| *d > Utc::now())
                        .map(|d| fmt_utc(&d))
                        .or_else(|| {
                            schedule.next_run_at.clone().or_else(|| {
                                // Keep the original due marker: the tick treats any
                                // past-or-present nextRunAt as due.
                                parse_once_at(
                                    &match &schedule.schedule {
                                        ScheduleKind::Once { at } => at.clone(),
                                        _ => String::new(),
                                    },
                                    tz,
                                )
                                .ok()
                                .map(|d| fmt_utc(&d))
                            })
                        })
                }
                _ => next_after(&schedule.schedule, tz, Utc::now())?.map(|dt| fmt_utc(&dt)),
            };
        }
    }
    schedule.updated_at = crate::state::now_iso();
    if let Some(map) = doc.as_object_mut() {
        map.insert(id.to_string(), api_schedule(&schedule));
    }
    write_json(&schedules_path(state), &doc).await?;
    Ok(public_schedule(&schedule))
}

/// Delete a schedule. Refused with 409 while an execution is in flight:
/// removing the row first would orphan a background execute (its finalize
/// would find no schedule and the run row would stay `running` forever).
/// Persisted threads are never touched, and the run history is KEPT (bounded
/// per schedule by `prune_runs`) so past firings stay readable as the contract
/// and the UI promise, instead of being silently discarded with the row.
pub async fn delete_schedule(state: &AppState, uid: &str, id: &str) -> Result<(), ApiError> {
    require_mutation(state)?;
    let _guard = state.store.lock().await;
    let mut doc = load_schedules(state).await?;
    let exists = doc
        .get(id)
        .and_then(|v| decode_schedule(id, v))
        .filter(|s| owned(s, uid))
        .is_some();
    if !exists {
        return Err(not_found());
    }
    let runs = load_runs(state).await?;
    if is_running(id) || has_running_run(&runs, id) {
        return Err(conflict(
            "schedule has a running execution; retry the delete when it finishes",
        ));
    }
    if let Some(map) = doc.as_object_mut() {
        map.remove(id);
    }
    write_json(&schedules_path(state), &doc).await?;
    Ok(())
}

pub async fn list_runs(state: &AppState, uid: &str, id: &str) -> Result<Vec<Value>, ApiError> {
    let schedules = load_schedules(state).await?;
    let schedule = schedules
        .get(id)
        .and_then(|v| decode_schedule(id, v))
        .filter(|s| owned(s, uid))
        .ok_or_else(not_found)?;
    let runs = load_runs(state).await?;
    let mut out: Vec<(String, Value)> = runs
        .as_object()
        .map(|map| {
            map.iter()
                .filter(|(_, r)| {
                    r.get("scheduleId").and_then(|v| v.as_str()) == Some(schedule.id.as_str())
                })
                .map(|(_, r)| {
                    (
                        r.get("startedAt")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        r.clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

/// Next `count` fire times (UTC ISO) for a kind/timezone pair. Read-only:
/// no lock probe, no store access.
pub async fn preview_next_runs(
    kind_raw: &Value,
    timezone: &str,
    count: usize,
) -> Result<Vec<String>, ApiError> {
    if timezone.trim().is_empty() {
        return Err(bad(
            "timezone is required (IANA name, e.g. UTC or America/New_York)",
        ));
    }
    let tz = parse_timezone(timezone)?;
    let kind = normalize_kind(&parse_incoming_kind(kind_raw)?, tz)?;
    Ok(next_n(&kind, tz, Utc::now(), count.min(20))?
        .iter()
        .map(fmt_utc)
        .collect())
}

// ---------------------------------------------------------------------------
// Human cadence
// ---------------------------------------------------------------------------

fn fmt_clock(hour: u32, minute: u32) -> String {
    let (h12, suffix) = match hour {
        0 => (12, "AM"),
        1..=11 => (hour, "AM"),
        12 => (12, "PM"),
        _ => (hour - 12, "PM"),
    };
    format!("{h12}:{minute:02} {suffix}")
}

fn ordinal(n: u32) -> String {
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

const WEEKDAY_NAMES: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// Day-of-week field to a sorted, de-duplicated set of 0..=6 (Sunday = 0).
/// Supports numbers, 3-letter names, comma lists, and ranges. `None` when the
/// field uses anything else (steps, `*`).
fn parse_dow_set(field: &str) -> Option<Vec<u32>> {
    fn one(token: &str) -> Option<u32> {
        let t = token.trim().to_ascii_uppercase();
        let n = match t.as_str() {
            "SUN" => 0,
            "MON" => 1,
            "TUE" => 2,
            "WED" => 3,
            "THU" => 4,
            "FRI" => 5,
            "SAT" => 6,
            _ => t.parse::<u32>().ok()?,
        };
        if n > 7 {
            None
        } else {
            Some(n % 7)
        }
    }
    let mut out = Vec::new();
    for part in field.split(',') {
        if part.contains('/') || part.contains('*') || part.is_empty() {
            return None;
        }
        if let Some((a, b)) = part.split_once('-') {
            let (a, b) = (one(a)?, one(b)?);
            // A range ending in 7 (e.g. 5-7) means through Sunday.
            let end = if b == 0 && !part.trim_end().ends_with('0') {
                7
            } else {
                b
            };
            if a > end {
                return None;
            }
            out.extend((a..=end).map(|d| d % 7));
        } else {
            out.push(one(part)?);
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn plural_days(days: &[u32]) -> String {
    let names: Vec<String> = days
        .iter()
        .map(|d| format!("{}s", WEEKDAY_NAMES[*d as usize]))
        .collect();
    match names.len() {
        1 => names[0].clone(),
        2 => format!("{} and {}", names[0], names[1]),
        _ => format!(
            "{} and {}",
            names[..names.len() - 1].join(", "),
            names[names.len() - 1]
        ),
    }
}

fn plain_u32(field: &str, max: u32) -> Option<u32> {
    if field.is_empty() || !field.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    field.parse::<u32>().ok().filter(|n| *n <= max)
}

/// Plain-English cron for common shapes; `None` falls back to "Cron: expr".
fn describe_cron(expression: &str) -> Option<String> {
    let f: Vec<&str> = expression.split_whitespace().collect();
    if f.len() != 5 {
        return None;
    }
    let (min, hour, dom, month, dow) = (f[0], f[1], f[2], f[3], f[4]);
    if month != "*" {
        return None;
    }
    // Sub-daily shapes.
    if hour == "*" && dom == "*" && dow == "*" {
        if min == "*" || min == "*/1" {
            return Some("Every minute".into());
        }
        if let Some(n) = min
            .strip_prefix("*/")
            .and_then(|n| plain_u32(n, 59))
            .filter(|n| *n > 0)
        {
            return Some(format!("Every {n} minutes"));
        }
        if let Some(m) = plain_u32(min, 59) {
            return Some(if m == 0 {
                "Every hour".into()
            } else {
                format!("Every hour at :{m:02}")
            });
        }
        return None;
    }
    if min == "0" && dom == "*" && dow == "*" {
        if let Some(n) = hour
            .strip_prefix("*/")
            .and_then(|n| plain_u32(n, 23))
            .filter(|n| *n > 0)
        {
            return Some(if n == 1 {
                "Every hour".into()
            } else {
                format!("Every {n} hours")
            });
        }
    }
    let (m, h) = (plain_u32(min, 59)?, plain_u32(hour, 23)?);
    let at = fmt_clock(h, m);
    if dom == "*" && dow == "*" {
        return Some(format!("Every day at {at}"));
    }
    if dom == "*" {
        let days = parse_dow_set(dow)?;
        return Some(match days.as_slice() {
            [1, 2, 3, 4, 5] => format!("Weekdays at {at}"),
            [0, 6] => format!("Weekends at {at}"),
            [d] => format!("Every {} at {at}", WEEKDAY_NAMES[*d as usize]),
            _ if days.len() == 7 => format!("Every day at {at}"),
            _ => format!("{} at {at}", plural_days(&days)),
        });
    }
    if dow == "*" {
        let d = plain_u32(dom, 31).filter(|d| *d >= 1)?;
        return Some(format!("On the {} of every month at {at}", ordinal(d)));
    }
    None
}

fn describe_interval(minutes: i64) -> String {
    if minutes == 60 {
        "Every hour".into()
    } else if minutes > 0 && minutes % 60 == 0 {
        format!("Every {} hours", minutes / 60)
    } else if minutes == 1 {
        "Every minute".into()
    } else {
        format!("Every {minutes} minutes")
    }
}

/// Server-computed, human cadence for a schedule kind in its timezone.
pub fn describe_cadence(kind: &ScheduleKind, tz: Tz) -> String {
    match kind {
        ScheduleKind::Cron { expression } => {
            describe_cron(expression).unwrap_or_else(|| format!("Cron: {}", expression.trim()))
        }
        ScheduleKind::Interval { minutes } => describe_interval(*minutes),
        ScheduleKind::Once { at } => match parse_once_at(at, tz) {
            Ok(dt) => {
                let local = dt.with_timezone(&tz);
                format!("Once on {} at {}", local.format("%b %-d, %Y"), {
                    use chrono::Timelike;
                    fmt_clock(local.hour(), local.minute())
                })
            }
            Err(_) => format!("Once at {at}"),
        },
    }
}

// ---------------------------------------------------------------------------
// System tasks (read-only view of built-in background work)
// ---------------------------------------------------------------------------

fn newest_mtime(dir: &std::path::Path) -> Option<String> {
    let newest = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max()?;
    Some(fmt_utc(&DateTime::<Utc>::from(newest)))
}

pub async fn system_tasks(state: &AppState) -> Result<Value, ApiError> {
    use crate::agent_home::{self, load_state};
    use crate::heartbeat::{cadence_text, next_due_at, parse_time, Settings, HEARTBEAT_TITLE};
    let doc = load_state(state).await?;
    let owner = agent_home::owner_user(state).await;
    let tz = agent_home::owner_timezone(state, owner.as_ref(), &doc).await;
    let settings = Settings::from_doc(&doc, &tz);
    let last = parse_time(doc.get("lastHeartbeatAt"));
    let next = next_due_at(Utc::now(), last, &settings).map(|t| fmt_utc(&t));
    let last_status = doc
        .get("lastResult")
        .and_then(Value::as_str)
        .filter(|r| matches!(*r, "quiet" | "message" | "error" | "skipped"));
    let memory_last = newest_mtime(&state.runtime_home.join("memory"));
    Ok(json!({"tasks": [
        {
            "id": "heartbeat",
            "name": HEARTBEAT_TITLE,
            "description": "Your agent checks in on its own and runs the checklist in HEARTBEAT.md, messaging you only when something needs attention.",
            "enabled": settings.enabled,
            "cadence": cadence_text(&settings),
            "nextRunAt": next,
            "lastRunAt": doc.get("lastHeartbeatAt").cloned().unwrap_or(Value::Null),
            "lastStatus": last_status,
            "threadId": doc.get("threadId").cloned().unwrap_or(Value::Null),
            "editable": true,
        },
        {
            "id": "memory",
            "name": "Memory upkeep",
            "description": "Your agent saves what it learns after each conversation.",
            "enabled": true,
            "cadence": "After each conversation",
            "nextRunAt": Value::Null,
            "lastRunAt": memory_last,
            "lastStatus": Value::Null,
            "editable": false,
        },
    ]}))
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Persist a visible Amiro thread for a firing (notify content or execute
/// output/failure). Uses the same `localMessages` shape `get_thread` already
/// prepends, so the result opens as a normal conversation even though no
/// runtime session exists. Best-effort: returns `None` when the write fails.
async fn persist_result_thread(
    state: &AppState,
    uid: &str,
    title: &str,
    text: &str,
    now: &str,
) -> Option<String> {
    let thread_id = uuid::Uuid::new_v4().to_string();
    let message = json!({
        "id": format!("schedmsg_{thread_id}"),
        "threadId": thread_id,
        "role": "assistant",
        "parts": [{"type": "text", "text": truncate_chars(text, MAX_THREAD_TEXT_CHARS)}],
        "createdAt": now,
    });
    let _guard = state.store.lock().await;
    let path = state.home.join("threads.json");
    let mut doc = read_json(&path, json!({})).await.ok()?;
    if !doc.is_object() {
        return None;
    }
    let users = read_json(&state.home.join("users.json"), json!({"users":[]}))
        .await
        .ok()?;
    if !users
        .get("users")
        .and_then(Value::as_array)?
        .iter()
        .any(|user| user["id"].as_str() == Some(uid))
    {
        return None;
    }
    let entry = json!({
        "sessionId": "",
        "userId": uid,
        "title": title,
        "localMessages": [message],
        "createdAt": now,
        "lastMessageAt": now,
        "archived": false,
        "workingDir": state.workspace.to_string_lossy().to_string(),
    });
    if let Some(map) = doc.as_object_mut() {
        map.insert(thread_id.clone(), entry);
    }
    write_json(&path, &doc).await.ok()?;
    Some(thread_id)
}

struct ExecOutcome {
    status: String,
    preview: String,
    thread_id: Option<String>,
}

async fn execute_notify(state: &AppState, schedule: &Schedule, now: &str) -> ExecOutcome {
    let thread_id = persist_result_thread(
        state,
        &schedule.user_id,
        &schedule.name,
        &schedule.prompt,
        now,
    )
    .await;
    let delivered = thread_id.is_some();
    ExecOutcome {
        status: if delivered { "ok" } else { "failed" }.to_string(),
        preview: if delivered {
            truncate_chars(&schedule.prompt, MAX_OUTPUT_PREVIEW_CHARS)
        } else {
            "Could not persist the in-app reminder. Check storage and account availability."
                .to_string()
        },
        thread_id,
    }
}

struct ScheduledTurnGuard {
    state: AppState,
    session_id: String,
    completed: bool,
}
impl Drop for ScheduledTurnGuard {
    fn drop(&mut self) {
        if !self.completed {
            crate::runtime::cancel_and_detach(self.state.clone(), self.session_id.clone());
        }
    }
}

/// Collect an explicit model-aware, no-tools turn. Dropping this future on its
/// deadline cancels the actual runtime session, not just the HTTP waiter.
async fn scheduled_model_turn(state: &AppState, schedule: &Schedule) -> Result<String, ApiError> {
    use crate::runtime::{TurnPlan, TurnUpdate};
    use amiro_sdk::ApiEvent;
    let model = schedule
        .model
        .as_deref()
        .ok_or_else(|| bad("schedule has no pinned model; edit it and select a model"))?;
    validate_pinned_model(model)?;
    let mut turn = crate::runtime::start_turn(
        state.clone(),
        TurnPlan {
            session_id: None,
            working_dir: state.workspace.to_string_lossy().to_string(),
            expose_tools: false,
            model: Some(model.to_string()),
            prompt: schedule.prompt.clone(),
            images: Vec::new(),
            tool_results: Vec::new(),
            system_reminder: None,
        },
    )
    .await?;
    let session = turn
        .session
        .await
        .map_err(|_| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                "runtime closed before creating the scheduled session".into(),
            )
        })?
        .map_err(|message| ApiError(StatusCode::BAD_GATEWAY, message))?;
    let mut guard = ScheduledTurnGuard {
        state: state.clone(),
        session_id: session.session_id,
        completed: false,
    };
    let mut text = String::new();
    while let Some(update) = turn.updates.recv().await {
        match update {
            TurnUpdate::Event(ApiEvent::TextDelta { text: delta, .. }) => {
                let remaining = MAX_THREAD_TEXT_CHARS.saturating_sub(text.chars().count());
                text.extend(delta.chars().take(remaining));
            }
            TurnUpdate::Event(ApiEvent::TextReplace {
                text: replacement, ..
            }) => {
                text = truncate_chars(&replacement, MAX_THREAD_TEXT_CHARS);
            }
            TurnUpdate::Error(message) => return Err(ApiError(StatusCode::BAD_GATEWAY, message)),
            TurnUpdate::Done(_) => {
                guard.completed = true;
                let _ = crate::runtime::archive_session(state, &guard.session_id).await;
                return Ok(text);
            }
            _ => {}
        }
    }
    Err(ApiError(
        StatusCode::BAD_GATEWAY,
        "runtime ended without a completed scheduled turn".into(),
    ))
}

async fn execute_execute(state: &AppState, schedule: &Schedule, now: &str) -> ExecOutcome {
    let result = tokio::time::timeout(
        Duration::from_secs(EXECUTE_TIMEOUT_SECS),
        scheduled_model_turn(state, schedule),
    )
    .await;
    let (mut status, body) = match result {
        Ok(Ok(text)) => (
            "ok",
            if text.trim().is_empty() {
                "(the scheduled run produced no output)".to_string()
            } else {
                text
            },
        ),
        Ok(Err(error)) => ("failed", format!("Scheduled task failed: {}", error.1)),
        Err(_) => (
            "failed",
            format!(
                "Scheduled task timed out after {} minutes and was cancelled",
                EXECUTE_TIMEOUT_SECS / 60
            ),
        ),
    };
    let thread_id =
        persist_result_thread(state, &schedule.user_id, &schedule.name, &body, now).await;
    let preview = if thread_id.is_none() {
        status = "failed";
        "Could not persist the scheduled result. Check storage and account availability."
            .to_string()
    } else {
        truncate_chars(&body, MAX_OUTPUT_PREVIEW_CHARS)
    };
    ExecOutcome {
        status: status.to_string(),
        preview,
        thread_id,
    }
}

/// `agent` mode: a tools-on turn in a fresh session with the agent workspace
/// as working dir (agent-home files load, Connectors/MCP and file tools work),
/// the pinned model, the shared timeout, and cancel-on-drop. Skipped (never
/// silently dropped) when a live chat turn is in flight.
async fn execute_agent(state: &AppState, schedule: &Schedule, now: &str) -> ExecOutcome {
    if crate::runtime::any_session_busy(state).await {
        return ExecOutcome {
            status: "skipped".to_string(),
            preview: "Skipped: a conversation was in progress. The next run is still scheduled."
                .to_string(),
            thread_id: None,
        };
    }
    let turn = async {
        let model = schedule
            .model
            .as_deref()
            .ok_or_else(|| bad("schedule has no pinned model; edit it and select a model"))?;
        validate_pinned_model(model)?;
        crate::heartbeat::agent_turn(state, schedule.prompt.clone(), Some(model.to_string())).await
    };
    let result = tokio::time::timeout(Duration::from_secs(EXECUTE_TIMEOUT_SECS), turn).await;
    let (mut status, body) = match result {
        Ok(Ok((text, session_id))) => {
            let _ = crate::runtime::archive_session(state, &session_id).await;
            (
                "ok",
                if text.trim().is_empty() {
                    "(the scheduled run produced no output)".to_string()
                } else {
                    text
                },
            )
        }
        Ok(Err(error)) => ("failed", format!("Scheduled task failed: {}", error.1)),
        Err(_) => (
            "failed",
            format!(
                "Scheduled task timed out after {} minutes and was cancelled",
                EXECUTE_TIMEOUT_SECS / 60
            ),
        ),
    };
    let thread_id =
        persist_result_thread(state, &schedule.user_id, &schedule.name, &body, now).await;
    let preview = if thread_id.is_none() {
        status = "failed";
        "Could not persist the scheduled result. Check storage and account availability."
            .to_string()
    } else {
        truncate_chars(&body, MAX_OUTPUT_PREVIEW_CHARS)
    };
    ExecOutcome {
        status: status.to_string(),
        preview,
        thread_id,
    }
}

async fn run_execution(state: &AppState, schedule: Schedule) -> ExecOutcome {
    let now = crate::state::now_iso();
    let owner_exists = read_json(&state.home.join("users.json"), json!({"users":[]}))
        .await
        .ok()
        .and_then(|doc| {
            doc.get("users").and_then(Value::as_array).map(|users| {
                users
                    .iter()
                    .any(|user| user["id"].as_str() == Some(schedule.user_id.as_str()))
            })
        })
        .unwrap_or(false);
    if !owner_exists {
        return ExecOutcome {
            status: "failed".to_string(),
            preview: "Schedule owner is unavailable. No task was executed.".to_string(),
            thread_id: None,
        };
    }
    if !schedule.enabled {
        return ExecOutcome {
            status: "skipped".to_string(),
            preview: "schedule was paused before it fired".to_string(),
            thread_id: None,
        };
    }
    if schedule.mode == "notify" {
        execute_notify(state, &schedule, &now).await
    } else if schedule.mode == "agent" {
        execute_agent(state, &schedule, &now).await
    } else {
        execute_execute(state, &schedule, &now).await
    }
}

// ---------------------------------------------------------------------------
// Claim/finalize durability helpers
// ---------------------------------------------------------------------------

/// Only `running` is a live state; every other status is closed.
fn run_is_terminal(status: &str) -> bool {
    status != "running"
}

/// True when the schedule already has a closed run row. A one-shot with any
/// terminal run was claimed (and very likely fired), so it must never fire
/// again even when its stored `nextRunAt` still looks due after a crash
/// between the two claim writes.
fn schedule_has_terminal_run(runs: &Value, schedule_id: &str) -> bool {
    runs.as_object()
        .map(|map| {
            map.values().any(|r| {
                r.get("scheduleId").and_then(|v| v.as_str()) == Some(schedule_id)
                    && r.get("status")
                        .and_then(|v| v.as_str())
                        .map(run_is_terminal)
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Stored `nextRunAt` as an instant, when it parses.
fn parse_next_run_at(schedule: &Schedule) -> Option<DateTime<Utc>> {
    schedule
        .next_run_at
        .as_deref()
        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
}

/// Finalize a finished execution. The store lock is taken FIRST and held
/// across every read and write, and the in-flight mark is released LAST, while
/// the lock is still held. Releasing it earlier let a tick claim the schedule
/// in the window between "no longer marked running" and "new timing durable",
/// which overlapped two executions of the same schedule.
async fn finalize(
    state: &AppState,
    schedule_id: &str,
    run_id: &str,
    fire_time: DateTime<Utc>,
    outcome: ExecOutcome,
) {
    let notif_info = {
        let _guard = state.store.lock().await;
        let info = finalize_locked(state, schedule_id, run_id, fire_time, outcome).await;
        // Still holding the store lock: no tick can observe the released mark
        // before the new timing is on disk.
        unmark(schedule_id);
        info
    };
    if let Some((uid, name, status, preview, thread_id)) = notif_info {
        if status == "ok" || status == "failed" {
            let urgency = if status == "failed" { "high" } else { "normal" };
            let _ = crate::routes::notifications::emit_notification(
                state,
                &uid,
                &name,
                &preview,
                "schedule_result",
                urgency,
                thread_id,
                Some(schedule_id.to_string()),
                "schedule.result",
            )
            .await;
        }
    }
}

/// Body of [`finalize`], called with the store lock held. Never releases the
/// in-flight mark; the caller owns that and does it only after this returns.
async fn finalize_locked(
    state: &AppState,
    schedule_id: &str,
    run_id: &str,
    fire_time: DateTime<Utc>,
    outcome: ExecOutcome,
) -> Option<(String, String, String, String, Option<String>)> {
    let ExecOutcome {
        status,
        preview,
        thread_id,
    } = outcome;
    let finished = crate::state::now_iso();
    let mut schedules = match load_schedules(state).await {
        Ok(doc) => doc,
        Err(error) => {
            tracing::error!(
                schedule = schedule_id,
                %error,
                "schedule finalize: schedules store unreadable; leaving the run row for startup recovery"
            );
            return None;
        }
    };
    let mut runs = match load_runs(state).await {
        Ok(doc) => doc,
        Err(error) => {
            tracing::error!(
                schedule = schedule_id,
                run = run_id,
                %error,
                "schedule finalize: run store unreadable; the outcome could not be persisted"
            );
            return None;
        }
    };
    if !schedules.is_object() {
        schedules = json!({});
    }
    if !runs.is_object() {
        runs = json!({});
    }
    let schedule = schedules
        .get(schedule_id)
        .and_then(|v| decode_schedule(schedule_id, v));
    let had_schedule = schedule.is_some();

    // Close the run row. A row startup recovery already closed (`interrupted`)
    // is never re-labelled: the process that claimed it died, so the real
    // result is unknown and a late success must not be fabricated for it.
    let mut closed = false;
    if let Some(obj) = runs.get_mut(run_id).and_then(|r| r.as_object_mut()) {
        if obj.get("status").and_then(|v| v.as_str()) != Some("interrupted") {
            obj.insert("status".into(), json!(status.clone()));
            obj.insert("finishedAt".into(), json!(finished.clone()));
            obj.insert("outputPreview".into(), json!(preview.clone()));
            if let Some(tid) = thread_id.clone() {
                obj.insert("threadId".into(), json!(tid));
            }
        }
        closed = true;
    }
    if !closed {
        // The row is gone (store edited by hand, or a delete raced): record
        // the outcome anyway instead of dropping a failure silently.
        if let Some(map) = runs.as_object_mut() {
            map.insert(
                run_id.to_string(),
                json!({
                    "id": run_id,
                    "scheduleId": schedule_id,
                    "userId": schedule
                        .as_ref()
                        .map(|s| s.user_id.clone())
                        .unwrap_or_default(),
                    "scheduledAt": fmt_utc(&fire_time),
                    "startedAt": finished.clone(),
                    "finishedAt": finished.clone(),
                    "status": status.clone(),
                    "outputPreview": preview.clone(),
                    "threadId": thread_id.clone(),
                }),
            );
        }
    }

    let notif_meta = schedule
        .as_ref()
        .map(|s| (s.user_id.clone(), s.name.clone(), status.clone(), preview.clone(), thread_id.clone()));
    if let Some(mut schedule) = schedule {
        schedule.last_run_at = Some(finished.clone());
        schedule.last_status = Some(status.clone());
        if let Some(tid) = thread_id.clone() {
            schedule.thread_id = Some(tid);
        }
        if schedule.enabled {
            match &schedule.schedule {
                // One-shots complete after a single firing, success or
                // failure: no retries, no replays.
                ScheduleKind::Once { .. } => {
                    schedule.enabled = false;
                    schedule.next_run_at = None;
                }
                // Recurring advance from COMPLETION time, never from the fire
                // time: a run that outlived its interval must not queue a
                // catch-up storm of fires that are already in the past.
                _ => {
                    let tz = parse_timezone(&schedule.timezone).unwrap_or(chrono_tz::UTC);
                    schedule.next_run_at = next_after(&schedule.schedule, tz, Utc::now())
                        .ok()
                        .flatten()
                        .map(|dt| fmt_utc(&dt));
                }
            }
        }
        // `!enabled` means the owner paused (or edited) while this run was in
        // flight. That decision is authoritative: never un-pause here and
        // never roll a paused schedule's timing forward under them. A resume
        // recomputes the schedule from scratch anyway.
        schedule.updated_at = finished.clone();
        if let Some(map) = schedules.as_object_mut() {
            map.insert(schedule_id.to_string(), api_schedule(&schedule));
        }
    }

    // Bounded history: newest MAX_RUNS_STORED_PER_SCHEDULE rows survive.
    prune_runs(&mut runs, schedule_id);

    // Run row first (bounded history included): if we die before the schedule
    // write, the closed run row still blocks a one-shot replay while the
    // claimed timing is untouched. The reverse order could lose the fire
    // marker with no record of the firing.
    if let Err(error) = write_json(&runs_path(state), &runs).await {
        tracing::error!(
            schedule = schedule_id,
            run = run_id,
            %error,
            "schedule finalize: run row write failed; startup recovery will close it"
        );
    }
    if had_schedule {
        if let Err(error) = write_json(&schedules_path(state), &schedules).await {
            tracing::error!(
                schedule = schedule_id,
                %error,
                "schedule finalize: schedule write failed; the claimed timing stands"
            );
        }
    }
    notif_meta
}

/// Claim due schedules and spawn their executions. The claim (find due +
/// advance `nextRunAt` + open the `running` run row) happens under the store
/// lock so a tick and a run-now can never double-fire the same schedule.
async fn tick(state: &AppState) {
    let now = Utc::now();
    let claims: Vec<(Schedule, ScheduleRun, DateTime<Utc>)> = {
        let _guard = state.store.lock().await;
        let mut schedules = match load_schedules(state).await {
            Ok(doc) => doc,
            Err(error) => {
                tracing::error!(%error, "schedule tick: schedules store unreadable; skipping this tick");
                return;
            }
        };
        let mut runs = match load_runs(state).await {
            Ok(doc) => doc,
            Err(error) => {
                tracing::error!(%error, "schedule tick: run store unreadable; skipping this tick");
                return;
            }
        };
        if !schedules.is_object() || !runs.is_object() {
            return;
        }
        let mut claims = Vec::new();
        let ids: Vec<String> = schedules
            .as_object()
            .map(|map| map.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            let Some(mut schedule) = schedules.get(&id).and_then(|v| decode_schedule(&id, v))
            else {
                continue;
            };
            if !schedule.enabled || is_running(&schedule.id) {
                continue;
            }
            let Some(due) = parse_next_run_at(&schedule) else {
                continue;
            };
            if due > now {
                continue;
            }
            if has_running_run(&runs, &schedule.id) {
                continue;
            }
            if !mark_running(&schedule.id) {
                continue;
            }
            // Advance the claim immediately so a concurrent tick or run-now
            // sees the new fire time, not the due one. The advance is computed
            // from `now`, never from the (possibly days old) due instant: a
            // backend that was down must not fire a catch-up storm of every
            // missed cron/interval slot.
            let advanced = match &schedule.schedule {
                // A one-shot is consumed by this claim: dropping the fire
                // marker in the same write is what stops a second firing.
                ScheduleKind::Once { .. } => None,
                _ => match parse_timezone(&schedule.timezone) {
                    Ok(tz) => next_after(&schedule.schedule, tz, now).ok().flatten(),
                    Err(_) => {
                        unmark(&schedule.id);
                        continue;
                    }
                },
            };
            schedule.next_run_at = advanced.map(|dt| fmt_utc(&dt));
            schedule.updated_at = crate::state::now_iso();
            let run = ScheduleRun {
                id: uuid::Uuid::new_v4().to_string(),
                schedule_id: schedule.id.clone(),
                user_id: schedule.user_id.clone(),
                scheduled_at: fmt_utc(&due),
                started_at: Some(crate::state::now_iso()),
                finished_at: None,
                status: "running".to_string(),
                output_preview: None,
                thread_id: None,
            };
            if let Some(map) = schedules.as_object_mut() {
                map.insert(schedule.id.clone(), api_schedule(&schedule));
            }
            if let Some(map) = runs.as_object_mut() {
                map.insert(run.id.clone(), api_run(&run));
            }
            claims.push((schedule, run, due));
        }
        if claims.is_empty() {
            return;
        }
        // Durability order matters. The `running` run row is written BEFORE the
        // schedule's claimed timing: if the process dies between the two
        // writes, recovery finds a durable claim (the run row) and closes it as
        // interrupted, so a one-shot is never silently lost. The old reverse
        // order could consume the one-shot's fire marker with no record that it
        // ever fired, losing the firing entirely.
        if let Err(error) = write_json(&runs_path(state), &runs).await {
            tracing::error!(
                %error,
                "schedule tick: claimed run rows could not be persisted; the claim is abandoned and retried next tick"
            );
            for (schedule, _, _) in &claims {
                unmark(&schedule.id);
            }
            return;
        }
        if let Err(error) = write_json(&schedules_path(state), &schedules).await {
            // The run rows are already durable, so the claim stands and the
            // executions proceed; finalize rewrites the timing. If we die
            // first, recovery closes the run row and a one-shot that already
            // has a terminal run never replays. Aborting here would report a
            // failure for work that is about to run.
            tracing::error!(
                %error,
                "schedule tick: claimed timing could not be persisted; continuing from the durable run rows"
            );
        }
        claims
    };
    for (schedule, run, due) in claims {
        let state = state.clone();
        tokio::spawn(async move {
            let outcome = run_execution(&state, schedule.clone()).await;
            finalize(&state, &schedule.id, &run.id, due, outcome).await;
        });
    }
}

/// Crash recovery, run once by the active ticker before its first tick:
/// executions left `running` become `interrupted` (never retried); an overdue
/// one-shot that was never claimed keeps its past `nextRunAt` so the first tick
/// fires it exactly once; a one-shot that already has a closed run row never
/// fires again; recurring schedules KEEP a still-future `nextRunAt` and only
/// resolve a missed/missing one forward from now (no catch-up storms, and no
/// gratuitous retiming of a perfectly healthy interval).
async fn recover(state: &AppState) {
    let now = Utc::now();
    let finished = crate::state::now_iso();
    let _guard = state.store.lock().await;
    let mut schedules = match load_schedules(state).await {
        Ok(doc) => doc,
        Err(error) => {
            tracing::error!(%error, "schedule recovery: schedules store unreadable; recovery skipped");
            return;
        }
    };
    let mut runs = match load_runs(state).await {
        Ok(doc) => doc,
        Err(error) => {
            tracing::error!(%error, "schedule recovery: run store unreadable; recovery skipped");
            return;
        }
    };
    if !schedules.is_object() {
        schedules = json!({});
    }
    if !runs.is_object() {
        runs = json!({});
    }
    // 1. A run interrupted by the crash is closed for good. It is never
    //    retried, and its terminal status is what proves the firing happened.
    let mut runs_changed = false;
    if let Some(map) = runs.as_object_mut() {
        for run in map.values_mut() {
            if run.get("status").and_then(|v| v.as_str()) == Some("running") {
                if let Some(obj) = run.as_object_mut() {
                    obj.insert("status".into(), json!("interrupted"));
                    obj.insert("finishedAt".into(), json!(finished.clone()));
                    runs_changed = true;
                }
            }
        }
    }
    // 2. Timing.
    let mut schedules_changed = false;
    if let Some(map) = schedules.as_object_mut() {
        for (id, value) in map.iter_mut() {
            let Some(mut schedule) = decode_schedule(id, value) else {
                continue;
            };
            // Paused by the owner between boots: their timing is untouched.
            if !schedule.enabled {
                continue;
            }
            match &schedule.schedule {
                ScheduleKind::Once { .. } => {
                    // A closed run row means this one-shot was already claimed
                    // and fired (or crashed mid-execution). Its stored
                    // `nextRunAt` can still look due after a crash between the
                    // two claim writes, so clear it here: a one-shot never
                    // fires twice.
                    if schedule_has_terminal_run(&runs, id) {
                        schedule.next_run_at = None;
                        schedule.enabled = false;
                        schedule.updated_at = finished.clone();
                        *value = api_schedule(&schedule);
                        schedules_changed = true;
                    }
                    // Otherwise a past-due one-shot keeps its due marker and
                    // the first tick fires it exactly once.
                }
                _ => {
                    // A future time is still valid: leave it exactly as it is
                    // instead of shoving every interval forward by a boot.
                    if parse_next_run_at(&schedule)
                        .map(|dt| dt > now)
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    // Missed (or uncomputable) slot: resolve forward from now
                    // and skip the missed slots entirely.
                    let Ok(tz) = parse_timezone(&schedule.timezone) else {
                        continue;
                    };
                    schedule.next_run_at = next_after(&schedule.schedule, tz, now)
                        .ok()
                        .flatten()
                        .map(|dt| fmt_utc(&dt));
                    schedule.updated_at = finished.clone();
                    *value = api_schedule(&schedule);
                    schedules_changed = true;
                }
            }
        }
    }
    if runs_changed {
        if let Err(error) = write_json(&runs_path(state), &runs).await {
            tracing::error!(%error, "schedule recovery: interrupted run rows could not be persisted");
        }
    }
    if schedules_changed {
        if let Err(error) = write_json(&schedules_path(state), &schedules).await {
            tracing::error!(%error, "schedule recovery: recovered timings could not be persisted");
        }
    }
}

/// Start the ticker. Call AFTER `listener.bind()` succeeds so a process that
/// cannot serve never runs schedules. A standby backend (lock held elsewhere)
/// retries every 30s and takes over transparently when the holder dies.
pub fn spawn_scheduler(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if std::env::var("AMIRO_NO_SCHEDULER").as_deref() == Ok("1") {
            return;
        }
        let lease = loop {
            if let Some(lease) = try_acquire(&state) {
                break lease;
            }
            tokio::time::sleep(Duration::from_secs(STANDBY_RETRY_SECS)).await;
        };
        recover(&state).await;
        if let Ok(mut leases) = holder().lock() {
            if let Some(held) = leases.get_mut(&lease.0) {
                held.ready = true;
            }
        }
        loop {
            tick(&state).await;
            tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
        }
    })
}

// ---------------------------------------------------------------------------
// Manual trigger (POST /:id/run)
// ---------------------------------------------------------------------------

pub async fn run_schedule_now(
    state: &AppState,
    uid: &str,
    id: &str,
) -> Result<(Value, Value), ApiError> {
    require_mutation(state)?;
    let (stored, run) = {
        let _guard = state.store.lock().await;
        let mut schedules = load_schedules(state).await?;
        let mut runs = load_runs(state).await?;
        if !schedules.is_object() {
            schedules = json!({});
        }
        if !runs.is_object() {
            runs = json!({});
        }
        let schedule = schedules
            .get(id)
            .and_then(|v| decode_schedule(id, v))
            .filter(|s| owned(s, uid))
            .ok_or_else(not_found)?;
        // `enabled=false` stops TIMER firings only. Run now is an explicit
        // user action and is allowed while paused (contract v1, SCHEDULES.md);
        // only a genuinely in-flight execution is rejected.
        if is_running(&schedule.id) || has_running_run(&runs, &schedule.id) {
            return Err(conflict("schedule already has a running execution"));
        }
        if !mark_running(&schedule.id) {
            return Err(conflict("schedule already has a running execution"));
        }
        let now = crate::state::now_iso();
        let run = ScheduleRun {
            id: uuid::Uuid::new_v4().to_string(),
            schedule_id: schedule.id.clone(),
            user_id: schedule.user_id.clone(),
            scheduled_at: now.clone(),
            started_at: Some(now.clone()),
            finished_at: None,
            status: "running".to_string(),
            output_preview: None,
            thread_id: None,
        };
        // A manual run of a one-shot consumes it: the fire marker is dropped in
        // the same claim, so the timer can never fire it a second time and a
        // crash cannot replay it. The stored `enabled` flag is left exactly as
        // the owner set it (paused stays paused).
        let mut claimed = schedule.clone();
        if matches!(claimed.schedule, ScheduleKind::Once { .. }) {
            claimed.next_run_at = None;
            claimed.updated_at = now.clone();
        }
        if let Some(map) = schedules.as_object_mut() {
            map.insert(claimed.id.clone(), api_schedule(&claimed));
        }
        if let Some(map) = runs.as_object_mut() {
            map.insert(run.id.clone(), api_run(&run));
        }
        // Durability order: the `running` row first, then the claimed marker
        // (same reasoning as `tick`). A crash in between leaves a durable run
        // row that recovery closes as interrupted, so the one-shot is neither
        // lost nor replayed.
        if let Err(error) = write_json(&runs_path(state), &runs).await {
            unmark(&schedule.id);
            tracing::error!(
                schedule = %schedule.id,
                %error,
                "run now: run row could not be persisted"
            );
            return Err(ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not persist schedule run".into(),
            ));
        }
        let mut claim_persisted = true;
        if claimed.next_run_at != schedule.next_run_at {
            if let Err(error) = write_json(&schedules_path(state), &schedules).await {
                // The run row is durable, so the claim stands and the execution
                // proceeds; finalize (or startup recovery) closes the record.
                // Reporting a failure here would lie about work that is about
                // to run.
                claim_persisted = false;
                tracing::error!(
                    schedule = %schedule.id,
                    %error,
                    "run now: one-shot fire marker could not be persisted; continuing from the durable run row"
                );
            }
        }
        (if claim_persisted { claimed } else { schedule }, run)
    };
    // The execution snapshot is enabled even when the stored row is paused:
    // `run_execution` refuses a paused snapshot, and a manual run is explicit.
    // Only the snapshot is enabled; the persisted row keeps the owner's pause.
    let mut exec_schedule = stored.clone();
    exec_schedule.enabled = true;
    if stored.mode == "notify" {
        // Notify is always fast (JSON writes only): run inline and return the
        // finished record.
        let outcome = run_execution(state, exec_schedule).await;
        let finished = crate::state::now_iso();
        let finished_run = ScheduleRun {
            status: outcome.status.clone(),
            finished_at: Some(finished.clone()),
            output_preview: Some(outcome.preview.clone()),
            thread_id: outcome.thread_id.clone(),
            ..run
        };
        let fire_time = Utc::now();
        finalize(state, &stored.id, &finished_run.id, fire_time, outcome).await;
        let updated = get_schedule(state, uid, &stored.id)
            .await?
            .unwrap_or(public_schedule(&stored));
        Ok((updated, api_run(&finished_run)))
    } else {
        // Execute can run for minutes: return the running record now and
        // finish in the background, like background jobs do.
        let state_clone = state.clone();
        let run_id = run.id.clone();
        let schedule_id = stored.id.clone();
        let fire_time = Utc::now();
        tokio::spawn(async move {
            let outcome = run_execution(&state_clone, exec_schedule).await;
            finalize(&state_clone, &schedule_id, &run_id, fire_time, outcome).await;
        });
        Ok((public_schedule(&stored), api_run(&run)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        chrono::NaiveDate::from_ymd_opt(y, mo, d)
            .unwrap()
            .and_hms_opt(h, mi, 0)
            .unwrap()
            .and_utc()
    }

    fn cron(expr: &str) -> String {
        describe_cadence(
            &ScheduleKind::Cron {
                expression: expr.into(),
            },
            chrono_tz::UTC,
        )
    }

    #[test]
    fn mode_validation_accepts_agent() {
        for m in ["notify", "execute", "agent"] {
            assert!(validate_mode(m).is_ok());
        }
        assert!(validate_mode("tools").is_err());
        assert!(validate_mode("").is_err());
    }

    #[test]
    fn cadence_cron_common_shapes() {
        assert_eq!(cron("0 9 * * *"), "Every day at 9:00 AM");
        assert_eq!(cron("0 8 * * 1-5"), "Weekdays at 8:00 AM");
        assert_eq!(cron("0 8 * * MON-FRI"), "Weekdays at 8:00 AM");
        assert_eq!(cron("0 17 * * 5"), "Every Friday at 5:00 PM");
        assert_eq!(cron("0 17 * * FRI"), "Every Friday at 5:00 PM");
        assert_eq!(cron("30 7 * * 1,4"), "Mondays and Thursdays at 7:30 AM");
        assert_eq!(
            cron("30 7 * * 1,3,5"),
            "Mondays, Wednesdays and Fridays at 7:30 AM"
        );
        assert_eq!(cron("0 10 * * 6,0"), "Weekends at 10:00 AM");
        assert_eq!(cron("0 10 * * 7"), "Every Sunday at 10:00 AM");
        assert_eq!(cron("0 * * * *"), "Every hour");
        assert_eq!(cron("*/15 * * * *"), "Every 15 minutes");
        assert_eq!(cron("* * * * *"), "Every minute");
        assert_eq!(cron("0 */4 * * *"), "Every 4 hours");
        assert_eq!(cron("15 * * * *"), "Every hour at :15");
        assert_eq!(cron("0 9 1 * *"), "On the 1st of every month at 9:00 AM");
        assert_eq!(cron("0 9 22 * *"), "On the 22nd of every month at 9:00 AM");
        assert_eq!(cron("0 9 13 * *"), "On the 13th of every month at 9:00 AM");
        assert_eq!(cron("0 0 * * *"), "Every day at 12:00 AM");
        assert_eq!(cron("5 12 * * *"), "Every day at 12:05 PM");
        assert_eq!(cron("59 23 * * *"), "Every day at 11:59 PM");
    }

    #[test]
    fn cadence_cron_falls_back() {
        assert_eq!(cron("0 9,17 * * *"), "Cron: 0 9,17 * * *");
        assert_eq!(cron("0 9 * 6 *"), "Cron: 0 9 * 6 *");
        assert_eq!(cron("0 9 1 * 1"), "Cron: 0 9 1 * 1");
        assert_eq!(cron("0 9 * * */2"), "Cron: 0 9 * * */2");
        assert_eq!(cron("  0 9 * * *  "), "Every day at 9:00 AM");
    }

    #[test]
    fn cadence_interval_and_once() {
        let d = |k| describe_cadence(&k, chrono_tz::UTC);
        assert_eq!(
            d(ScheduleKind::Interval { minutes: 30 }),
            "Every 30 minutes"
        );
        assert_eq!(d(ScheduleKind::Interval { minutes: 60 }), "Every hour");
        assert_eq!(d(ScheduleKind::Interval { minutes: 240 }), "Every 4 hours");
        assert_eq!(
            d(ScheduleKind::Interval { minutes: 90 }),
            "Every 90 minutes"
        );
        assert_eq!(
            d(ScheduleKind::Once {
                at: "2026-10-20T09:00:00.000Z".into()
            }),
            "Once on Oct 20, 2026 at 9:00 AM"
        );
        let kolkata: Tz = "Asia/Kolkata".parse().unwrap();
        assert_eq!(
            describe_cadence(
                &ScheduleKind::Once {
                    at: "2026-10-20T03:30:00.000Z".into()
                },
                kolkata
            ),
            "Once on Oct 20, 2026 at 9:00 AM"
        );
        let ny: Tz = "America/New_York".parse().unwrap();
        assert_eq!(
            describe_cadence(
                &ScheduleKind::Once {
                    at: "2026-10-21T02:30:00.000Z".into()
                },
                ny
            ),
            "Once on Oct 20, 2026 at 10:30 PM"
        );
    }

    #[test]
    fn once_accepts_rfc3339_and_naive_wall_time() {
        let tz: Tz = "America/New_York".parse().unwrap();
        // RFC3339 with offset.
        let dt = parse_once_at("2026-10-18T09:00:00+00:00", tz).unwrap();
        assert_eq!(fmt_utc(&dt), "2026-10-18T09:00:00.000Z");
        // Naive wall time resolved in the schedule timezone (EDT, UTC-4).
        let dt = parse_once_at("2026-10-18T09:00", tz).unwrap();
        assert_eq!(fmt_utc(&dt), "2026-10-18T13:00:00.000Z");
    }

    #[test]
    fn once_rejects_ambiguous_fold_and_gap() {
        let tz: Tz = "America/New_York".parse().unwrap();
        // 2026-11-01 01:30 happens twice (fall-back fold): ambiguous wall time,
        // locked contract is 400 with an explicit-offset hint.
        let err = parse_once_at("2026-11-01T01:30", tz).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(
            err.1.contains("ambiguous"),
            "fold rejection must say why: {}",
            err.1
        );
        // The same instant with an explicit offset is unambiguous.
        let dt = parse_once_at("2026-11-01T01:30:00-04:00", tz).unwrap();
        assert_eq!(fmt_utc(&dt), "2026-11-01T05:30:00.000Z");
        // 2026-03-08 02:30 never happens (spring-forward gap): rejected.
        assert!(parse_once_at("2026-03-08T02:30", tz).is_err());
        assert!(parse_once_at("not a time", tz).is_err());
    }

    #[test]
    fn cron_requires_five_fields() {
        assert!(parse_cron("0 9 * * *").is_ok());
        assert!(parse_cron("0 9 * * * *").is_err());
        assert!(parse_cron("* * * *").is_err());
        assert!(parse_cron("nope").is_err());
    }

    #[test]
    fn kolkata_morning_maps_to_utc() {
        // Asia/Kolkata is UTC+5:30 with no DST: 09:00 local == 03:30Z.
        let tz: Tz = "Asia/Kolkata".parse().unwrap();
        let kind = ScheduleKind::Cron {
            expression: "0 9 * * *".to_string(),
        };
        let from = utc(2026, 10, 17, 0, 0);
        let next = next_after(&kind, tz, from).unwrap().unwrap();
        assert_eq!(fmt_utc(&next), "2026-10-17T03:30:00.000Z");
    }

    #[test]
    fn sunday_zero_matches_sunday_not_saturday() {
        let tz = chrono_tz::UTC;
        let kind = ScheduleKind::Cron {
            expression: "0 0 * * 0".to_string(),
        };
        // Saturday 2026-10-17 12:00Z -> next fire is Sunday 2026-10-18 00:00Z.
        let next = next_after(&kind, tz, utc(2026, 10, 17, 12, 0))
            .unwrap()
            .unwrap();
        assert_eq!(fmt_utc(&next), "2026-10-18T00:00:00.000Z");
    }

    #[test]
    fn dom_dow_use_or_semantics() {
        let tz = chrono_tz::UTC;
        // 1st of month OR Sunday: from Sat 2026-10-17 the next fire is the
        // Sunday 2026-10-18, not 2026-11-01.
        let kind = ScheduleKind::Cron {
            expression: "0 0 1 * 0".to_string(),
        };
        let next = next_after(&kind, tz, utc(2026, 10, 17, 12, 0))
            .unwrap()
            .unwrap();
        assert_eq!(fmt_utc(&next), "2026-10-18T00:00:00.000Z");
    }

    #[test]
    fn dst_spring_forward_shifts_missing_fire_forward() {
        // America/New_York springs forward 2026-03-08 02:00 -> 03:00, so a
        // 02:30 daily cron cannot fire at 02:30 local. Vixie-correct behavior
        // (which croner implements): the job still fires once that day, at
        // the first valid wall time 03:00 EDT (07:00Z), not a fabricated
        // 02:30 EST and not skipped to the next day.
        let tz: Tz = "America/New_York".parse().unwrap();
        let kind = ScheduleKind::Cron {
            expression: "30 2 * * *".to_string(),
        };
        let next = next_after(&kind, tz, utc(2026, 3, 7, 12, 0))
            .unwrap()
            .unwrap();
        assert_eq!(fmt_utc(&next), "2026-03-08T07:00:00.000Z");
    }

    #[test]
    fn interval_bounds_are_enforced() {
        let tz = chrono_tz::UTC;
        assert!(normalize_kind(&ScheduleKind::Interval { minutes: 4 }, tz).is_err());
        assert!(normalize_kind(&ScheduleKind::Interval { minutes: 5 }, tz).is_ok());
        assert!(normalize_kind(&ScheduleKind::Interval { minutes: 43200 }, tz).is_ok());
        assert!(normalize_kind(&ScheduleKind::Interval { minutes: 43201 }, tz).is_err());
    }

    #[test]
    fn preview_returns_ascending_runs() {
        let tz = chrono_tz::UTC;
        let kind = ScheduleKind::Interval { minutes: 60 };
        let runs = next_n(&kind, tz, utc(2026, 10, 17, 0, 0), 5).unwrap();
        assert_eq!(runs.len(), 5);
        for w in runs.windows(2) {
            assert!(w[0] < w[1]);
        }
        assert_eq!(fmt_utc(&runs[0]), "2026-10-17T01:00:00.000Z");
    }

    #[test]
    fn spent_oneshot_has_no_next_run() {
        let tz = chrono_tz::UTC;
        let kind = ScheduleKind::Once {
            at: "2026-10-01T00:00:00Z".to_string(),
        };
        assert!(next_after(&kind, tz, utc(2026, 10, 17, 0, 0))
            .unwrap()
            .is_none());
    }

    #[test]
    fn unknown_timezone_is_rejected() {
        assert!(parse_timezone("Mars/Olympus").is_err());
        assert!(parse_timezone("UTC").is_ok());
    }
}
