//! Built-in cleanup ("Cleanup" on the Schedules page): deletes chats, schedule
//! run logs and log files nobody has touched for a set time. The owner picks the
//! age, the time of day and what it covers; it then runs daily without the
//! model. It can also run on demand, with a preview first, from the page or from
//! chat (`housekeeping_*` tools in `agent_mcp.rs`).
//!
//! Always kept: an agent's channel, a chat with a turn still running, schedules
//! themselves and any run still in progress.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};

use crate::state::{now_iso, read_json, write_json, ApiError, AppState, AuthUser};

const TICK: Duration = Duration::from_secs(60);
pub const MIN_HOURS: u64 = 1;
pub const MAX_HOURS: u64 = 24 * 365;
/// Log folders under the app home that cleanup may prune, relative to it.
const LOG_DIRS: [&str; 1] = ["logs"];
/// How deep cleanup looks inside a log folder.
const LOG_DEPTH: usize = 3;
/// Chats named in a report; the count is always exact.
const REPORT_TITLES: usize = 20;

/// What the owner set on the Schedules page (or from chat).
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub older_than_hours: u64,
    /// Local time of day it runs, `HH:MM`, in the owner's timezone.
    pub time: String,
    pub chats: bool,
    pub archived: bool,
    pub schedule_runs: bool,
    pub log_files: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            older_than_hours: 48,
            time: "03:00".into(),
            chats: true,
            archived: false,
            schedule_runs: true,
            log_files: true,
        }
    }
}

impl Settings {
    pub fn from_doc(doc: &Value) -> Self {
        let base = Self::default();
        let flag =
            |key: &str, fallback: bool| doc.get(key).and_then(Value::as_bool).unwrap_or(fallback);
        Self {
            enabled: flag("enabled", base.enabled),
            older_than_hours: doc
                .get("olderThanHours")
                .and_then(Value::as_u64)
                .filter(|h| (MIN_HOURS..=MAX_HOURS).contains(h))
                .unwrap_or(base.older_than_hours),
            time: doc
                .get("time")
                .and_then(Value::as_str)
                .filter(|t| parse_time_of_day(t).is_some())
                .map(str::to_string)
                .unwrap_or(base.time),
            chats: flag("chats", base.chats),
            archived: flag("archived", base.archived),
            schedule_runs: flag("scheduleRuns", base.schedule_runs),
            log_files: flag("logFiles", base.log_files),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "olderThanHours": self.older_than_hours,
            "time": self.time,
            "chats": self.chats,
            "archived": self.archived,
            "scheduleRuns": self.schedule_runs,
            "logFiles": self.log_files,
        })
    }

    /// Merge a partial body (camelCase, as the page sends it; `snake_case`
    /// as tools send it; `olderThanDays` as a convenience).
    pub fn apply_patch(&self, body: &Value) -> Result<Self, String> {
        let mut next = self.clone();
        let pick = |camel: &str, snake: &str| body.get(camel).or_else(|| body.get(snake));
        for (camel, snake, slot) in [
            ("enabled", "enabled", &mut next.enabled),
            ("chats", "chats", &mut next.chats),
            ("archived", "archived", &mut next.archived),
            ("scheduleRuns", "schedule_runs", &mut next.schedule_runs),
            ("logFiles", "log_files", &mut next.log_files),
        ] {
            if let Some(v) = pick(camel, snake) {
                *slot = v
                    .as_bool()
                    .ok_or(format!("{camel} must be true or false"))?;
            }
        }
        let hours = match (
            pick("olderThanHours", "older_than_hours"),
            pick("olderThanDays", "older_than_days"),
        ) {
            (Some(v), _) => Some(v.as_f64().ok_or("olderThanHours must be a number")?),
            (None, Some(v)) => Some(v.as_f64().ok_or("olderThanDays must be a number")? * 24.0),
            (None, None) => None,
        };
        if let Some(hours) = hours {
            let hours = hours.round();
            if !(MIN_HOURS as f64..=MAX_HOURS as f64).contains(&hours) {
                return Err(format!(
                    "the age must be between {MIN_HOURS} hour and {} days",
                    MAX_HOURS / 24
                ));
            }
            next.older_than_hours = hours as u64;
        }
        if let Some(v) = pick("time", "time") {
            let time = v
                .as_str()
                .filter(|t| parse_time_of_day(t).is_some())
                .ok_or("time must be HH:MM, e.g. 03:00")?;
            next.time = time.to_string();
        }
        if !(next.chats || next.schedule_runs || next.log_files) {
            return Err("choose at least one of chats, schedule run logs or log files".into());
        }
        Ok(next)
    }
}

pub fn parse_time_of_day(value: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(value.trim(), "%H:%M").ok()
}

/// "2 days", "1 week", "36 hours".
pub fn age_text(hours: u64) -> String {
    let plural = |n: u64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    if hours % 168 == 0 {
        plural(hours / 168, "week")
    } else if hours % 24 == 0 {
        plural(hours / 24, "day")
    } else {
        plural(hours, "hour")
    }
}

/// The first `time` (local, in `tz`) strictly after `after`.
pub fn next_run_after(after: DateTime<Utc>, time: &str, tz: Tz) -> Option<DateTime<Utc>> {
    let at = parse_time_of_day(time)?;
    let local_day = after.with_timezone(&tz).date_naive();
    (0..3).find_map(|offset| {
        let day = local_day + chrono::Duration::days(offset);
        let candidate = tz
            .from_local_datetime(&day.and_time(at))
            .earliest()?
            .with_timezone(&Utc);
        (candidate > after).then_some(candidate)
    })
}

fn parse_utc(value: Option<&Value>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value?.as_str()?)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

fn store_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("housekeeping.json")
}

async fn load(state: &AppState) -> Result<Value, ApiError> {
    read_json(&store_path(state), json!({})).await
}

async fn owner_tz(state: &AppState) -> Tz {
    let owner = crate::agent_home::owner_user(state).await;
    let doc = crate::agent_home::load_state(state)
        .await
        .unwrap_or_else(|_| json!({}));
    crate::agent_home::owner_timezone(state, owner.as_ref(), &doc)
        .await
        .parse()
        .unwrap_or(chrono_tz::UTC)
}

/// The next automatic run, or `None` while it is off. Counted from the last
/// run, or from when it was switched on, so turning it on never fires at once.
fn next_due(doc: &Value, settings: &Settings, tz: Tz) -> Option<DateTime<Utc>> {
    if !settings.enabled {
        return None;
    }
    let anchor = parse_utc(doc.get("lastRunAt"))
        .into_iter()
        .chain(parse_utc(doc.get("enabledAt")))
        .max()
        .unwrap_or_else(Utc::now);
    next_run_after(anchor, &settings.time, tz)
}

/// Settings, last run and next run, for the page and the agent.
pub async fn view(state: &AppState) -> Result<Value, ApiError> {
    let doc = load(state).await?;
    let settings = Settings::from_doc(&doc);
    let tz = owner_tz(state).await;
    Ok(json!({
        "settings": settings.to_json(),
        "timezone": tz.name(),
        "summary": summary(&settings),
        "lastRunAt": doc.get("lastRunAt").cloned().unwrap_or(Value::Null),
        "lastReport": doc.get("lastReport").cloned().unwrap_or(Value::Null),
        "nextRunAt": next_due(&doc, &settings, tz).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    }))
}

/// "Daily at 3:00 AM · chats, run logs and log files untouched for 2 days".
pub fn summary(settings: &Settings) -> String {
    let mut what = Vec::new();
    if settings.chats {
        what.push(if settings.archived {
            "chats (archived too)"
        } else {
            "chats"
        });
    }
    if settings.schedule_runs {
        what.push("run logs");
    }
    if settings.log_files {
        what.push("log files");
    }
    let what = match what.as_slice() {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    let clock = parse_time_of_day(&settings.time)
        .map(|t| {
            crate::schedules::fmt_clock(chrono::Timelike::hour(&t), chrono::Timelike::minute(&t))
        })
        .unwrap_or_else(|| settings.time.clone());
    format!(
        "Daily at {clock} · {what} untouched for {}",
        age_text(settings.older_than_hours)
    )
}

pub async fn save_settings(state: &AppState, patch: &Value) -> Result<Value, ApiError> {
    {
        let _guard = state.store.lock().await;
        let mut doc = load(state).await?;
        if !doc.is_object() {
            doc = json!({});
        }
        let current = Settings::from_doc(&doc);
        let next = current
            .apply_patch(patch)
            .map_err(|m| ApiError(StatusCode::BAD_REQUEST, m))?;
        if next.enabled && !current.enabled {
            doc["enabledAt"] = json!(now_iso());
        }
        for (key, value) in next.to_json().as_object().into_iter().flatten() {
            doc[key] = value.clone();
        }
        write_json(&store_path(state), &doc).await?;
    }
    view(state).await
}

// ---------------------------------------------------------------------------
// The cleanup itself
// ---------------------------------------------------------------------------

/// When a chat was last touched: its last message, else when it was made.
fn chat_touched(entry: &Value) -> Option<DateTime<Utc>> {
    parse_utc(entry.get("lastMessageAt")).or_else(|| parse_utc(entry.get("createdAt")))
}

fn chat_running(id: &str, entry: &Value) -> bool {
    let uid = entry.get("userId").and_then(Value::as_str).unwrap_or("");
    crate::chat_runs::get(uid, id).is_some_and(|run| !run.is_done())
}

/// Delete (or with `dry_run`, only list) what `settings` covers and nobody has
/// touched since `older_than_hours` ago. Returns what it found or removed.
pub async fn clean(
    state: &AppState,
    settings: &Settings,
    dry_run: bool,
) -> Result<Value, ApiError> {
    let cutoff = Utc::now() - chrono::Duration::hours(settings.older_than_hours as i64);
    let mut chats: Vec<Value> = Vec::new();
    let mut runs_removed = 0usize;
    {
        let _guard = state.store.lock().await;
        if settings.chats {
            let path = state.home.join("threads.json");
            let mut doc = read_json(&path, json!({})).await?;
            let stale: Vec<(String, Value)> = doc
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(id, entry)| {
                    !crate::threads::is_channel(entry)
                        && (settings.archived
                            || !entry
                                .get("archived")
                                .and_then(Value::as_bool)
                                .unwrap_or(false))
                        && chat_touched(entry).is_some_and(|t| t < cutoff)
                        && !chat_running(id, entry)
                })
                .map(|(id, entry)| (id.clone(), entry.clone()))
                .collect();
            for (id, entry) in &stale {
                chats.push(json!({
                    "id": id,
                    "title": entry.get("title").cloned().unwrap_or(Value::Null),
                    "lastMessageAt": entry.get("lastMessageAt").or_else(|| entry.get("createdAt")).cloned().unwrap_or(Value::Null),
                }));
            }
            if !dry_run && !stale.is_empty() {
                for (id, entry) in &stale {
                    if let Some(sid) = entry.get("sessionId").and_then(Value::as_str) {
                        let runtime = crate::threads::runtime_state(state, entry).await;
                        let _ = crate::runtime::archive_session(&runtime, sid).await;
                    }
                    if let Some(map) = doc.as_object_mut() {
                        map.remove(id);
                    }
                }
                write_json(&path, &doc).await?;
            }
        }
        if settings.schedule_runs {
            let path = crate::schedules::runs_path(state);
            let mut doc = read_json(&path, json!({})).await?;
            let stale: Vec<String> = doc
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(_, run)| {
                    run.get("status").and_then(Value::as_str) != Some("running")
                        && parse_utc(run.get("finishedAt"))
                            .or_else(|| parse_utc(run.get("scheduledAt")))
                            .is_some_and(|t| t < cutoff)
                })
                .map(|(id, _)| id.clone())
                .collect();
            runs_removed = stale.len();
            if !dry_run && !stale.is_empty() {
                if let Some(map) = doc.as_object_mut() {
                    for id in &stale {
                        map.remove(id);
                    }
                }
                write_json(&path, &doc).await?;
            }
        }
    }
    let (files, bytes) = if settings.log_files {
        let roots = log_dirs(state);
        let cutoff_time = std::time::SystemTime::from(cutoff);
        tokio::task::spawn_blocking(move || prune_logs(&roots, cutoff_time, dry_run))
            .await
            .unwrap_or_default()
    } else {
        Default::default()
    };
    chats.sort_by(|a, b| {
        a["lastMessageAt"]
            .as_str()
            .cmp(&b["lastMessageAt"].as_str())
    });
    let chat_count = chats.len();
    chats.truncate(REPORT_TITLES);
    Ok(json!({
        "dryRun": dry_run,
        "olderThanHours": settings.older_than_hours,
        "cutoff": cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "chats": chat_count,
        "chatList": chats,
        "scheduleRuns": runs_removed,
        "logFiles": files.len(),
        "logFileList": files,
        "bytes": bytes,
        "text": report_text(chat_count, runs_removed, files.len(), bytes, dry_run, settings.older_than_hours),
    }))
}

/// The app's and the runtime's log folders, plus the workspace's `data/logs`.
fn log_dirs(state: &AppState) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = LOG_DIRS.iter().map(|d| state.home.join(d)).collect();
    dirs.push(state.runtime_home.join("logs"));
    dirs.push(state.workspace.join("data").join("logs"));
    dirs
}

fn is_log_file(name: &str) -> bool {
    name.ends_with(".log") || name.contains(".log.")
}

/// Remove `*.log` files (and rotated `*.log.N` / `*.log.gz`) last written
/// before `cutoff`. Symlinks are never followed or removed.
fn prune_logs(
    roots: &[PathBuf],
    cutoff: std::time::SystemTime,
    dry_run: bool,
) -> (Vec<String>, u64) {
    fn walk(
        dir: &Path,
        depth: usize,
        cutoff: std::time::SystemTime,
        dry_run: bool,
        out: &mut (Vec<String>, u64),
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.path().symlink_metadata() else {
                continue;
            };
            if meta.is_dir() && depth > 0 {
                walk(&entry.path(), depth - 1, cutoff, dry_run, out);
            } else if meta.is_file()
                && is_log_file(&entry.file_name().to_string_lossy())
                && meta.modified().is_ok_and(|m| m < cutoff)
                && (dry_run || std::fs::remove_file(entry.path()).is_ok())
            {
                out.0.push(entry.path().to_string_lossy().to_string());
                out.1 += meta.len();
            }
        }
    }
    let mut out = (Vec::new(), 0);
    for root in roots {
        walk(root, LOG_DEPTH, cutoff, dry_run, &mut out);
    }
    out
}

fn report_text(
    chats: usize,
    runs: usize,
    files: usize,
    bytes: u64,
    dry_run: bool,
    hours: u64,
) -> String {
    let n = |count: usize, one: &str| format!("{count} {one}{}", if count == 1 { "" } else { "s" });
    let mb = bytes as f64 / 1_048_576.0;
    let parts = format!(
        "{}, {} and {} ({mb:.1} MB)",
        n(chats, "chat"),
        n(runs, "schedule run log"),
        n(files, "log file"),
    );
    if dry_run {
        format!("Would delete {parts} untouched for {}.", age_text(hours))
    } else {
        format!("Deleted {parts} untouched for {}.", age_text(hours))
    }
}

/// Run now with the saved settings, overridden by `overrides` (same keys as
/// a settings patch), and record a real run as the last one.
pub async fn run_now(
    state: &AppState,
    overrides: &Value,
    dry_run: bool,
) -> Result<Value, ApiError> {
    let doc = load(state).await?;
    let settings = Settings::from_doc(&doc)
        .apply_patch(overrides)
        .map_err(|m| ApiError(StatusCode::BAD_REQUEST, m))?;
    let report = clean(state, &settings, dry_run).await?;
    if !dry_run {
        record(state, &report).await?;
    }
    Ok(report)
}

async fn record(state: &AppState, report: &Value) -> Result<(), ApiError> {
    let _guard = state.store.lock().await;
    let mut doc = load(state).await?;
    if !doc.is_object() {
        doc = json!({});
    }
    doc["lastRunAt"] = json!(now_iso());
    doc["lastReport"] = report.clone();
    write_json(&store_path(state), &doc).await
}

/// Daily automatic runs while it is on.
pub fn spawn_housekeeping(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            // Only the instance that owns this home's scheduler runs it.
            if !crate::schedules::mutation_allowed(&state) {
                continue;
            }
            let Ok(doc) = load(&state).await else {
                continue;
            };
            let settings = Settings::from_doc(&doc);
            let tz = owner_tz(&state).await;
            if !next_due(&doc, &settings, tz).is_some_and(|due| due <= Utc::now()) {
                continue;
            }
            let report = match clean(&state, &settings, false).await {
                Ok(report) => report,
                Err(error) => {
                    json!({"error": error.1, "text": format!("Cleanup failed: {}", error.1)})
                }
            };
            let _ = record(&state, &report).await;
        }
    })
}

/// The Schedules page's built-in task row.
pub async fn system_task(state: &AppState) -> Value {
    let view = view(state).await.unwrap_or_else(|_| json!({}));
    let report = &view["lastReport"];
    let last_status = if report.is_null() {
        Value::Null
    } else if report.get("error").is_some() {
        json!("error")
    } else if report["chats"].as_u64().unwrap_or(0)
        + report["scheduleRuns"].as_u64().unwrap_or(0)
        + report["logFiles"].as_u64().unwrap_or(0)
        > 0
    {
        json!("cleaned")
    } else {
        json!("nothing")
    };
    json!({
        "id": "cleanup",
        "name": "Cleanup",
        "description": "Deletes chats, schedule run logs and log files nobody has touched for the age you choose.",
        "enabled": view["settings"]["enabled"].as_bool().unwrap_or(false),
        "cadence": view["summary"].clone(),
        "nextRunAt": view["nextRunAt"].clone(),
        "lastRunAt": view["lastRunAt"].clone(),
        "lastStatus": last_status,
        "lastSummary": report.get("text").cloned().unwrap_or(Value::Null),
        "threadId": Value::Null,
        "editable": true,
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

async fn get_view(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    Ok(Json(view(&state).await?))
}

async fn put_settings(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    Ok(Json(save_settings(&state, &body).await?))
}

/// POST /api/housekeeping/run `{dryRun?, ...settings overrides}`.
async fn post_run(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&user)?;
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    let report = run_now(&state, &body, dry_run).await?;
    Ok(Json(
        json!({"report": report, "housekeeping": view(&state).await?}),
    ))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/housekeeping", get(get_view).put(put_settings))
        .route("/api/housekeeping/run", post(post_run))
}

#[cfg(test)]
#[path = "housekeeping_tests.rs"]
mod housekeeping_tests;
