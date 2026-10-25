//! Self-update: release checks, the update job and the background checker.
//!
//! How each build updates itself:
//!
//! * **Server** (`install.sh` install, `method: "installer"`): runs the
//!   installed `amiro update <version>` next to `amiro-backend`. That script
//!   downloads the release, checks its SHA-256, swaps
//!   `~/.amiro/app/current` and restarts the server the way it was started
//!   (systemd/launchd service or the background process). The job is
//!   tracked in `store/update-state.json` and its output in
//!   `update/update.log`, so the result survives the restart: the new
//!   process marks the job `succeeded` when it runs the target version and
//!   `failed` when it does not.
//! * **Desktop app** (`method: "desktop"`): the Tauri shell updates itself
//!   (signed updater, `clients/desktop`); the server inside it is a sidecar
//!   and is replaced with the app.
//! * **Source checkouts, containers** (`method: "manual"`): no updater next
//!   to the binary; the UI says how to update by hand.
//!
//! A background task checks GitHub every few hours (`autoCheck`, on by
//! default), posts one Bell notification per new version, and, when the
//! owner turned `autoInstall` on, installs it while nothing is running.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};

use crate::state::{now_iso, read_json, write_json, ApiError, AppState};

/// Fresh check results are reused for this long unless a refresh is forced.
const CHECK_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// Release notes longer than this are cut (the full notes are one click away).
const NOTES_MAX_CHARS: usize = 4000;
/// Lines of installer output kept with a failed job.
const LOG_TAIL_LINES: usize = 40;

/// The version of this running server.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// `owner/name` of the GitHub repository releases come from (`AMIRO_REPO`).
pub fn repo_slug() -> String {
    std::env::var("AMIRO_REPO")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "vallabha717/Amiro".to_string())
}

/// Base URL of the GitHub REST API (`AMIRO_UPDATE_API_BASE`, for tests and
/// mirrors).
fn api_base() -> String {
    std::env::var("AMIRO_UPDATE_API_BASE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "https://api.github.com".to_string())
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// "v1.26.0" -> (1, 26, 0, None). Strict character allowlist for prerelease
/// so dot-segments and slashes can never traverse a release URL.
pub fn parse_version(raw: &str) -> Option<(u64, u64, u64, Option<String>)> {
    let stripped = raw.trim().strip_prefix(['v', 'V']).unwrap_or(raw.trim());
    let (core, prerelease) = match stripped.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => {
            if !pre.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
                || pre.contains("..")
                || pre.starts_with('.')
                || pre.ends_with('.')
            {
                return None;
            }
            (core, Some(pre.to_string()))
        }
        _ => (stripped, None),
    };
    let mut parts = core.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next()?.parse().ok()?;
    let patch: u64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch, prerelease))
}

/// -1 / 0 / 1. A prerelease is older than the same release; unparseable
/// input compares as 0 (never newer, never older).
pub fn compare_versions(a: &str, b: &str) -> i8 {
    let (pa, pb) = match (parse_version(a), parse_version(b)) {
        (Some(pa), Some(pb)) => (pa, pb),
        _ => return 0,
    };
    for (x, y) in [(pa.0, pb.0), (pa.1, pb.1), (pa.2, pb.2)] {
        if x != y {
            return if x < y { -1 } else { 1 };
        }
    }
    match (&pa.3, &pb.3) {
        (None, None) => 0,
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(x), Some(y)) => match x.cmp(y) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        },
    }
}

/// The same version written with or without the leading `v`.
fn same_version(a: &str, b: &str) -> bool {
    parse_version(a).is_some() && parse_version(a) == parse_version(b)
}

// ---------------------------------------------------------------------------
// How this build updates
// ---------------------------------------------------------------------------

/// The `amiro` management script that updates this server: the
/// `AMIRO_UPDATE_COMMAND` override, else the `amiro` installed next to
/// `amiro-backend` by `install.sh`. `None` for desktop, source and container
/// builds.
pub fn updater_command() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("AMIRO_UPDATE_COMMAND") {
        let path = PathBuf::from(raw.trim());
        return (path.is_absolute() && path.is_file()).then_some(path);
    }
    // install.sh puts `amiro` beside `amiro-backend`; a source checkout's
    // target/ directory and the desktop app never have one.
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let script = dir.join("amiro");
    script.is_file().then_some(script)
}

/// `installer`, `desktop` or `manual` (see the module docs).
pub fn update_method() -> &'static str {
    let desktop = std::env::var("AMIRO_DESKTOP")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if desktop {
        "desktop"
    } else if updater_command().is_some() {
        "installer"
    } else {
        "manual"
    }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

fn settings_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("update-settings.json")
}

fn job_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("update-state.json")
}

fn check_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("update-check.json")
}

fn log_path(state: &AppState) -> PathBuf {
    state.home.join("update").join("update.log")
}

/// Serialises read-modify-write of the update files (separate from the
/// general store lock: the background task must not wait on chat writes).
fn file_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// The owner's update preferences.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    /// Check GitHub for new releases in the background.
    pub auto_check: bool,
    /// Install new releases by themselves while nothing is running
    /// (servers only).
    pub auto_install: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_check: true,
            auto_install: false,
        }
    }
}

impl Settings {
    fn to_json(self) -> Value {
        json!({"autoCheck": self.auto_check, "autoInstall": self.auto_install})
    }
}

/// Read the saved preferences (defaults when none are saved).
pub async fn load_settings(state: &AppState) -> Settings {
    let doc = read_json(&settings_path(state), json!({}))
        .await
        .unwrap_or_else(|_| json!({}));
    let defaults = Settings::default();
    Settings {
        auto_check: doc
            .get("autoCheck")
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.auto_check),
        auto_install: doc
            .get("autoInstall")
            .and_then(|v| v.as_bool())
            .unwrap_or(defaults.auto_install),
    }
}

/// Apply a partial update (`autoCheck` / `autoInstall` booleans) and save.
pub async fn save_settings(state: &AppState, patch: &Value) -> Result<Settings, ApiError> {
    let _guard = file_lock().lock().await;
    let mut settings = load_settings(state).await;
    for (key, slot) in [
        ("autoCheck", &mut settings.auto_check),
        ("autoInstall", &mut settings.auto_install),
    ] {
        match patch.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::Bool(b)) => *slot = *b,
            Some(_) => {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    format!("{key} must be true or false"),
                ))
            }
        }
    }
    write_json(&settings_path(state), &settings.to_json()).await?;
    Ok(settings)
}

// ---------------------------------------------------------------------------
// Release check
// ---------------------------------------------------------------------------

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("amiro-update-check")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn truncate_notes(body: &str) -> String {
    if body.chars().count() <= NOTES_MAX_CHARS {
        return body.to_string();
    }
    let mut cut: String = body.chars().take(NOTES_MAX_CHARS).collect();
    cut.push_str("\n\n…");
    cut
}

/// Ask GitHub for the latest release. `Ok` with `noReleases` when the
/// repository has none; `Err` only for network/API failures.
async fn fetch_latest(repo: &str) -> Result<Value, String> {
    let url = format!("{}/repos/{repo}/releases/latest", api_base());
    let resp = http_client()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == StatusCode::NOT_FOUND {
        return Ok(json!({
            "latest": null,
            "releaseUrl": format!("https://github.com/{repo}/releases"),
            "publishedAt": null,
            "notes": null,
            "noReleases": true,
        }));
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub API responded {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let latest = body
        .get("tag_name")
        .and_then(|t| t.as_str())
        .filter(|t| parse_version(t).is_some())
        .ok_or_else(|| "the latest release has no usable version tag".to_string())?;
    Ok(json!({
        "latest": latest,
        "releaseUrl": body
            .get("html_url")
            .and_then(|u| u.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://github.com/{repo}/releases/latest")),
        "publishedAt": body.get("published_at").cloned().unwrap_or(Value::Null),
        "notes": body.get("body").and_then(|b| b.as_str()).map(truncate_notes),
        "noReleases": false,
    }))
}

/// The latest-release check, cached for [`CHECK_CACHE_TTL`] unless `force`.
/// Never fails: a network/API problem comes back as `checkFailed: true` so
/// the General page keeps working offline.
pub async fn check(state: &AppState, force: bool) -> Value {
    let repo = repo_slug();
    let current = current_version();
    let path = check_path(state);
    let cached = read_json(&path, Value::Null).await.unwrap_or(Value::Null);
    let fresh_enough = cached.get("repo").and_then(|v| v.as_str()) == Some(repo.as_str())
        && cached.get("current").and_then(|v| v.as_str()) == Some(current)
        && cached
            .get("checkedAt")
            .and_then(|v| v.as_str())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| {
                (chrono::Utc::now() - t.with_timezone(&chrono::Utc))
                    .to_std()
                    .is_ok_and(|age| age < CHECK_CACHE_TTL)
            });
    if !force && fresh_enough && !cached.get("checkFailed").and_then(|v| v.as_bool()).unwrap_or(false) {
        return cached;
    }
    let mut result = match fetch_latest(&repo).await {
        Ok(found) => found,
        Err(error) => {
            tracing::info!(%error, "update check failed");
            json!({
                "latest": cached.get("latest").cloned().unwrap_or(Value::Null),
                "releaseUrl": format!("https://github.com/{repo}/releases"),
                "publishedAt": cached.get("publishedAt").cloned().unwrap_or(Value::Null),
                "notes": cached.get("notes").cloned().unwrap_or(Value::Null),
                "noReleases": false,
                "checkFailed": true,
            })
        }
    };
    let latest = result.get("latest").and_then(|v| v.as_str()).map(str::to_string);
    result["repo"] = json!(repo);
    result["current"] = json!(current);
    result["checkedAt"] = json!(now_iso());
    result["updateAvailable"] =
        json!(latest.as_deref().is_some_and(|l| compare_versions(current, l) < 0));
    if result.get("checkFailed").is_none() {
        result["checkFailed"] = json!(false);
    }
    let _guard = file_lock().lock().await;
    let _ = write_json(&path, &result).await;
    result
}

// ---------------------------------------------------------------------------
// The update job
// ---------------------------------------------------------------------------

/// The last (or running) update job, `{"state": "idle"}` when there is none.
pub async fn load_job(state: &AppState) -> Value {
    read_json(&job_path(state), json!({"state": "idle"}))
        .await
        .unwrap_or_else(|_| json!({"state": "idle"}))
}

async fn save_job(state: &AppState, job: &Value) {
    let _guard = file_lock().lock().await;
    if let Err(error) = write_json(&job_path(state), job).await {
        tracing::warn!(error = %error.1, "could not save the update job state");
    }
}

fn job_running(job: &Value) -> bool {
    matches!(
        job.get("state").and_then(|v| v.as_str()),
        Some("installing") | Some("restarting")
    )
}

/// The last `n` lines of the installer output, with ANSI colour codes
/// removed so the UI can show it as plain text.
async fn log_tail(state: &AppState, n: usize) -> String {
    let raw = tokio::fs::read_to_string(log_path(state))
        .await
        .unwrap_or_default();
    let clean: String = strip_ansi(&raw);
    let lines: Vec<&str> = clean.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Whether a chat turn or a schedule run is in progress (auto-install waits).
pub fn busy() -> bool {
    crate::thread_activity::any_running() || crate::schedules::any_in_flight()
}

/// Start updating this server to `version` (the latest release when
/// `None`). `trigger` is `manual` or `auto`. Returns the new job.
pub async fn start(state: &AppState, version: Option<String>, trigger: &str) -> Result<Value, ApiError> {
    let Some(command) = updater_command().filter(|_| update_method() == "installer") else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            match update_method() {
                "desktop" => "The desktop app updates itself: use Update in the app.".to_string(),
                _ => "This server was not installed with install.sh, so it cannot update itself. Update it the way you installed it (for a source checkout: git pull, then rebuild).".to_string(),
            },
        ));
    };
    let target = match version {
        Some(v) => {
            let v = v.trim().to_string();
            if parse_version(&v).is_none() {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    format!("refusing to update to unparseable version: {v}"),
                ));
            }
            v
        }
        None => {
            let found = check(state, true).await;
            match found.get("latest").and_then(|v| v.as_str()) {
                Some(latest) if !found["checkFailed"].as_bool().unwrap_or(false) => latest.to_string(),
                _ => {
                    return Err(ApiError(
                        StatusCode::BAD_GATEWAY,
                        "Could not find the latest release on GitHub. Check the internet connection and try again.".to_string(),
                    ))
                }
            }
        }
    };
    let target = if target.starts_with(['v', 'V']) { target } else { format!("v{target}") };
    if same_version(&target, current_version()) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!("Amiro is already on {target}."),
        ));
    }
    if job_running(&load_job(state).await) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "An update is already running.".to_string(),
        ));
    }

    let log = log_path(state);
    if let Some(dir) = log.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let out = std::fs::File::create(&log)?;
    let err = out.try_clone()?;

    let mut cmd = tokio::process::Command::new(&command);
    // argv only, no shell; the version is one validated element.
    cmd.arg("update").arg(&target);
    // `amiro` finds its home and config the same way the server did.
    cmd.env("AMIRO_HOME", &state.home);
    // Detached: the update restarts this server, so it must outlive it. A
    // fresh process group keeps shutdown signals away from it.
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(out))
        .stderr(std::process::Stdio::from(err))
        .spawn()
        .map_err(|e| {
            ApiError(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not start the update: {e}"),
            )
        })?;

    let job = json!({
        "state": "installing",
        "from": format!("v{}", current_version()),
        "target": target,
        "trigger": trigger,
        "startedAt": now_iso(),
        "finishedAt": null,
        "error": null,
        "log": null,
        "pid": child.id(),
    });
    save_job(state, &job).await;
    tracing::info!(target = %job["target"], trigger, "update started");

    // Watch the updater. When it fails before restarting us, record why.
    // When it succeeds, the restart normally ends this process first; if it
    // does not (Amiro was not running under `amiro`), say a restart is due.
    let watcher_state = state.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        let mut job = load_job(&watcher_state).await;
        if !job_running(&job) {
            return;
        }
        let tail = log_tail(&watcher_state, LOG_TAIL_LINES).await;
        match status {
            Ok(code) if code.success() => {
                job["state"] = json!("restarting");
                job["log"] = json!(tail);
            }
            Ok(code) => {
                job["state"] = json!("failed");
                job["finishedAt"] = json!(now_iso());
                job["error"] = json!(format!(
                    "The updater stopped with exit code {}. Amiro is still on v{}.",
                    code.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into()),
                    current_version()
                ));
                job["log"] = json!(tail);
            }
            Err(error) => {
                job["state"] = json!("failed");
                job["finishedAt"] = json!(now_iso());
                job["error"] = json!(format!("Lost track of the updater: {error}"));
                job["log"] = json!(tail);
            }
        }
        save_job(&watcher_state, &job).await;
    });
    Ok(job)
}

/// Run at startup: a job left `installing`/`restarting` by the previous
/// process is settled here. Running the target version means it worked.
pub async fn reconcile_on_start(state: &AppState) {
    let mut job = load_job(state).await;
    if !job_running(&job) {
        return;
    }
    let target = job.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ok = same_version(&target, current_version());
    job["finishedAt"] = json!(now_iso());
    job["log"] = json!(log_tail(state, LOG_TAIL_LINES).await);
    if ok {
        job["state"] = json!("succeeded");
        job["error"] = Value::Null;
    } else {
        job["state"] = json!("failed");
        job["error"] = json!(format!(
            "The server restarted on v{} instead of {target}. The previous version stays installed; see the log below.",
            current_version()
        ));
    }
    save_job(state, &job).await;
    if ok {
        notify_owner(
            state,
            "system.update_installed",
            &format!("Amiro updated to {target}"),
            "The server restarted on the new version.",
            &format!("update-installed:{target}"),
        )
        .await;
    }
}

// ---------------------------------------------------------------------------
// Status for the General page
// ---------------------------------------------------------------------------

/// Everything the General page shows: versions, the check, how this build
/// updates, the owner's settings and the last job.
pub async fn status(state: &AppState, force: bool) -> Value {
    let mut out = check(state, force).await;
    let method = update_method();
    out["method"] = json!(method);
    out["canSelfUpdate"] = json!(method == "installer");
    out["settings"] = load_settings(state).await.to_json();
    out["job"] = load_job(state).await;
    out
}

// ---------------------------------------------------------------------------
// Background checker
// ---------------------------------------------------------------------------

async fn notify_owner(state: &AppState, event: &str, title: &str, body: &str, dedupe: &str) {
    let Some(owner) = crate::agent_home::owner_user(state).await else {
        return;
    };
    let Some(owner_id) = owner.get("id").and_then(|v| v.as_str()) else {
        return;
    };
    let _ = crate::notify::emit_signal(
        state,
        owner_id,
        &json!({
            "sourceChannel": "watcher",
            "sourceContextId": "amiro-updates",
            "sourceEventName": event,
            "title": title,
            "body": body,
            "urgency": "normal",
            "dedupeKey": dedupe,
            "attentionHints": {
                "requiresAction": false,
                "isAsyncBackground": true,
                "visibleInSourceNow": false,
            },
            "routingIntent": "single_channel",
        }),
    )
    .await;
}

fn interval_from_env(name: &str, default: Duration) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .map(Duration::from_secs)
        .unwrap_or(default)
}

/// One pass of the background checker. Returns whether an automatic install
/// is waiting for Amiro to go idle (so the next pass comes sooner).
pub async fn tick(state: &AppState) -> bool {
    let settings = load_settings(state).await;
    if !settings.auto_check && !settings.auto_install {
        return false;
    }
    let found = check(state, true).await;
    if !found["updateAvailable"].as_bool().unwrap_or(false) {
        return false;
    }
    let Some(latest) = found["latest"].as_str().map(str::to_string) else {
        return false;
    };
    notify_owner(
        state,
        "system.update_available",
        &format!("Amiro {latest} is available"),
        &format!(
            "You are on v{}. Open Admin → General to see what's new and update.",
            current_version()
        ),
        &format!("update-available:{latest}"),
    )
    .await;
    if !(settings.auto_install && update_method() == "installer") {
        return false;
    }
    let job = load_job(state).await;
    if job_running(&job) {
        return false;
    }
    // Don't retry an automatic install of a version that already failed;
    // the owner sees the failure in General and can retry by hand.
    if job["state"] == "failed" && job["target"].as_str().is_some_and(|t| same_version(t, &latest)) {
        return false;
    }
    if busy() {
        return true;
    }
    if let Err(error) = start(state, Some(latest), "auto").await {
        tracing::warn!(error = %error.1, "automatic update did not start");
    }
    false
}

/// Settle the previous job, then check for releases in the background:
/// shortly after start, then every `AMIRO_UPDATE_CHECK_INTERVAL` seconds
/// (6 hours by default), or every few minutes while an automatic install
/// waits for Amiro to go idle.
pub fn spawn_update_checker(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        reconcile_on_start(&state).await;
        if std::env::var("AMIRO_NO_UPDATE_CHECK").is_ok_and(|v| v == "1") {
            return;
        }
        let interval = interval_from_env("AMIRO_UPDATE_CHECK_INTERVAL", Duration::from_secs(6 * 60 * 60));
        let retry = Duration::from_secs(5 * 60).min(interval);
        tokio::time::sleep(interval_from_env("AMIRO_UPDATE_FIRST_CHECK_DELAY", Duration::from_secs(60))).await;
        loop {
            let waiting = tick(&state).await;
            tokio::time::sleep(if waiting { retry } else { interval }).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_v_prefixed_versions() {
        assert_eq!(parse_version("v1.26.0"), Some((1, 26, 0, None)));
        assert_eq!(
            parse_version("1.26.0-rc.1"),
            Some((1, 26, 0, Some("rc.1".to_string())))
        );
        assert_eq!(parse_version("dev"), None);
        assert_eq!(parse_version("1.26"), None);
        assert_eq!(parse_version("1.26.0.1"), None);
        assert_eq!(parse_version("1.26.0-../x"), None);
    }

    #[test]
    fn newer_releases_compare_greater() {
        assert_eq!(compare_versions("1.26.0", "v1.27.0"), -1);
        assert_eq!(compare_versions("v1.27.0", "1.26.0"), 1);
        assert_eq!(compare_versions("1.26.0", "1.26.0"), 0);
        assert_eq!(compare_versions("1.26.0-rc.1", "1.26.0"), -1);
        assert_eq!(compare_versions("1.26.0", "1.26.0-rc.1"), 1);
        assert_eq!(compare_versions("dev", "1.26.0"), 0);
        assert_eq!(compare_versions("1.26.0", "dev"), 0);
    }

    #[test]
    fn same_version_ignores_the_v() {
        assert!(same_version("v1.27.0", "1.27.0"));
        assert!(!same_version("v1.27.0", "1.27.1"));
        assert!(!same_version("dev", "dev"));
    }

    #[test]
    fn strips_colour_codes_from_installer_output() {
        assert_eq!(strip_ansi("\u{1b}[32m✓\u{1b}[0m done\r"), "✓ done");
    }

    #[test]
    fn long_notes_are_cut() {
        let long = "x".repeat(NOTES_MAX_CHARS + 10);
        assert!(truncate_notes(&long).ends_with('…'));
        assert_eq!(truncate_notes("short"), "short");
    }
}
