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
//! * **Source checkout** (`method: "source"`): the backend runs from
//!   `<checkout>/backend/target/<profile>/`. It follows its branch on
//!   `origin` instead of releases: every commit there is an update.
//!   `scripts/amiro-server.sh update <commit>` fast-forwards the checkout,
//!   rebuilds the web UI, backend and runtime, and restarts the systemd
//!   service or background process. `build.rs` records the commit each
//!   build came from, so the restarted server knows whether it worked.
//! * **Containers and other builds** (`method: "manual"`): no updater next
//!   to the binary; the UI says how to update by hand.
//!
//! A background task checks GitHub every few hours (`autoCheck`, on by
//! default), posts one Bell notification per new version, and, when the
//! owner turned `autoInstall` on, installs it while nothing is running.

use std::path::{Path, PathBuf};
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

/// The source checkout this server runs from: `AMIRO_SOURCE_DIR`, else the
/// repository around `backend/target/<profile>/amiro-backend`. It must be a
/// git checkout that has `scripts/amiro-server.sh`.
pub fn source_checkout() -> Option<PathBuf> {
    let root = match std::env::var("AMIRO_SOURCE_DIR") {
        Ok(raw) if !raw.trim().is_empty() => PathBuf::from(raw.trim()),
        _ => {
            let exe = std::env::current_exe().ok()?;
            let target = exe.parent()?.parent()?;
            let backend = target.parent()?;
            if target.file_name()? != "target" || backend.file_name()? != "backend" {
                return None;
            }
            backend.parent()?.to_path_buf()
        }
    };
    (root.is_absolute() && root.join(".git").exists() && root.join("scripts/amiro-server.sh").is_file())
        .then_some(root)
}

/// What updates a source checkout: `AMIRO_SOURCE_UPDATE_COMMAND` (tests),
/// else its `scripts/amiro-server.sh`.
fn source_update_command(root: &Path) -> PathBuf {
    std::env::var("AMIRO_SOURCE_UPDATE_COMMAND")
        .ok()
        .map(|raw| PathBuf::from(raw.trim()))
        .filter(|path| path.is_absolute() && path.is_file())
        .unwrap_or_else(|| root.join("scripts/amiro-server.sh"))
}

/// `installer`, `desktop`, `source` or `manual` (see the module docs).
pub fn update_method() -> &'static str {
    let desktop = std::env::var("AMIRO_DESKTOP")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if desktop {
        "desktop"
    } else if updater_command().is_some() {
        "installer"
    } else if source_checkout().is_some() {
        "source"
    } else {
        "manual"
    }
}

/// The commit this backend was built from (`build.rs`);
/// `AMIRO_RUNNING_COMMIT` stands in for it in tests. `None` when it was not
/// built in a git checkout.
pub fn running_commit() -> Option<String> {
    let raw = std::env::var("AMIRO_RUNNING_COMMIT").unwrap_or_else(|_| env!("AMIRO_BUILD_COMMIT").to_string());
    let commit = raw.trim();
    is_commit(commit).then(|| commit.to_string())
}

/// A full or abbreviated commit id (hex only, so it is safe as an argument).
fn is_commit(raw: &str) -> bool {
    (7..=40).contains(&raw.len()) && raw.chars().all(|c| c.is_ascii_hexdigit())
}

fn short_commit(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Whether two commit ids, full or abbreviated, name the same commit.
fn same_commit(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && (a.starts_with(b) || b.starts_with(a))
}

/// The systemd unit and scope running this server, from `/proc/self/cgroup`,
/// so the update script restarts the service instead of a stray process.
fn systemd_unit() -> Option<(String, &'static str)> {
    parse_systemd_unit(&std::fs::read_to_string("/proc/self/cgroup").ok()?)
}

fn parse_systemd_unit(cgroup: &str) -> Option<(String, &'static str)> {
    let path = cgroup.lines().find_map(|line| line.strip_prefix("0::"))?;
    let unit = path.rsplit('/').next()?;
    if !unit.ends_with(".service") || unit.starts_with("user@") {
        return None;
    }
    let scope = if path.contains("/user@") { "user" } else { "system" };
    Some((unit.to_string(), scope))
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

fn source_check_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("update-source-check.json")
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
// Source checkout check
// ---------------------------------------------------------------------------

/// Commits listed on the General page (the count covers all of them).
const SOURCE_COMMITS_SHOWN: usize = 20;

/// Run `git -C <root> <args>`; trimmed stdout, or what went wrong.
async fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let run = tokio::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .output();
    let out = tokio::time::timeout(Duration::from_secs(60), run)
        .await
        .map_err(|_| format!("git {} took too long", args[0]))?
        .map_err(|e| format!("could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() { format!("git {} failed", args[0]) } else { stderr })
    }
}

/// Fetch the checkout's branch from `origin` and compare it with the
/// commit this server runs.
async fn inspect_source(root: &Path, running: Option<&str>) -> Result<Value, String> {
    let branch = git(root, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .map_err(|_| "This checkout is not on a branch, so there is nothing to follow.".to_string())?;
    git(root, &["fetch", "--quiet", "origin", &branch]).await?;
    let upstream = format!("origin/{branch}");
    let latest = git(root, &["rev-parse", &upstream]).await?;
    let base = match running {
        Some(commit) => commit.to_string(),
        None => git(root, &["rev-parse", "HEAD"]).await?,
    };
    let range = format!("{base}..{upstream}");
    let behind: u64 = git(root, &["rev-list", "--count", &range]).await?.parse().unwrap_or(0);
    let limit = format!("-n{SOURCE_COMMITS_SHOWN}");
    let log = git(root, &["log", &limit, "--format=%h%x1f%s%x1f%cI", &range]).await?;
    let commits: Vec<Value> = log
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            Some(json!({"sha": parts.next()?, "subject": parts.next()?, "date": parts.next()?}))
        })
        .collect();
    let dirty = !git(root, &["status", "--porcelain", "--untracked-files=no"]).await?.is_empty();
    Ok(json!({
        "branch": branch,
        "latest": short_commit(&latest),
        "latestFull": latest,
        "behind": behind,
        "commits": commits,
        "dirty": dirty,
        "checkFailed": false,
        "error": null,
    }))
}

/// Where a source checkout stands against its branch on `origin`, cached
/// for [`CHECK_CACHE_TTL`] unless `force`. Never fails: a problem comes back
/// as `checkFailed` with the `error`.
pub async fn source_check(state: &AppState, root: &Path, force: bool) -> Value {
    let path = source_check_path(state);
    let running = running_commit();
    let running_short = running.as_deref().map(short_commit);
    let cached = read_json(&path, Value::Null).await.unwrap_or(Value::Null);
    let fresh_enough = cached.get("running").and_then(|v| v.as_str()) == running_short.as_deref()
        && !cached.get("checkFailed").and_then(|v| v.as_bool()).unwrap_or(true)
        && cached
            .get("checkedAt")
            .and_then(|v| v.as_str())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| {
                (chrono::Utc::now() - t.with_timezone(&chrono::Utc))
                    .to_std()
                    .is_ok_and(|age| age < CHECK_CACHE_TTL)
            });
    if !force && fresh_enough {
        return cached;
    }
    let mut result = match inspect_source(root, running.as_deref()).await {
        Ok(found) => found,
        Err(error) => {
            tracing::info!(%error, "source update check failed");
            json!({"behind": 0, "commits": [], "dirty": false, "checkFailed": true, "error": error})
        }
    };
    result["running"] = json!(running_short);
    result["checkedAt"] = json!(now_iso());
    let _guard = file_lock().lock().await;
    let _ = write_json(&path, &result).await;
    result
}

fn source_behind(found: &Value) -> u64 {
    if found["checkFailed"].as_bool().unwrap_or(true) {
        0
    } else {
        found["behind"].as_u64().unwrap_or(0)
    }
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
    if update_method() == "source" {
        return start_source(state, version, trigger).await;
    }
    let Some(command) = updater_command().filter(|_| update_method() == "installer") else {
        return Err(ApiError(
            StatusCode::CONFLICT,
            match update_method() {
                "desktop" => "The desktop app updates itself: use Update in the app.".to_string(),
                _ => "This server was not installed with install.sh or run from a source checkout, so it cannot update itself. Update it the way you installed it.".to_string(),
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
    let job = json!({
        "state": "installing",
        "from": format!("v{}", current_version()),
        "target": target,
        "trigger": trigger,
    });
    // argv only, no shell; the version is one validated element.
    run_job(state, &command, &["update", &target], job, &[]).await
}

/// Update a source checkout to `commit` (the branch's latest when `None`).
async fn start_source(state: &AppState, commit: Option<String>, trigger: &str) -> Result<Value, ApiError> {
    let root = source_checkout().ok_or_else(|| {
        ApiError(StatusCode::CONFLICT, "This server is not running from a source checkout.".to_string())
    })?;
    let requested = commit.map(|c| c.trim().to_string());
    if let Some(c) = &requested {
        if !is_commit(c) {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                format!("refusing to update to something that is not a commit: {c}"),
            ));
        }
    }
    let found = source_check(state, &root, true).await;
    if found["checkFailed"].as_bool().unwrap_or(true) {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            format!(
                "Could not check for new changes: {}",
                found["error"].as_str().unwrap_or("unknown error")
            ),
        ));
    }
    let branch = found["branch"].as_str().unwrap_or("main").to_string();
    if found["dirty"].as_bool().unwrap_or(false) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "This checkout has uncommitted changes to tracked files. Commit or discard them, then update.".to_string(),
        ));
    }
    let running = running_commit().unwrap_or_default();
    let target = requested.unwrap_or_else(|| found["latestFull"].as_str().unwrap_or_default().to_string());
    if source_behind(&found) == 0 || same_commit(&running, &target) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            format!("Amiro is already on the latest {branch}."),
        ));
    }
    if job_running(&load_job(state).await) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "An update is already running.".to_string(),
        ));
    }
    let mut env = vec![("AMIRO_BUILD_PROFILE", build_profile())];
    if let Some((unit, scope)) = systemd_unit() {
        env.push(("AMIRO_RESTART_UNIT", unit));
        env.push(("AMIRO_RESTART_SCOPE", scope.to_string()));
    }
    let job = json!({
        "state": "installing",
        "kind": "source",
        "branch": branch,
        "from": if running.is_empty() { "unknown".to_string() } else { short_commit(&running) },
        "target": short_commit(&target),
        "trigger": trigger,
    });
    let command = source_update_command(&root);
    run_job(state, &command, &["update", &target], job, &env).await
}

/// `release` or `debug`: the cargo profile directory this backend runs from.
fn build_profile() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent()?.file_name()?.to_str().map(str::to_string))
        .filter(|name| name == "debug")
        .unwrap_or_else(|| "release".to_string())
}

/// Start `command args…` detached, record `job` as running, and watch it:
/// a failure before the restart is saved with the output's tail.
async fn run_job(
    state: &AppState,
    command: &Path,
    args: &[&str],
    mut job: Value,
    env: &[(&str, String)],
) -> Result<Value, ApiError> {
    let log = log_path(state);
    if let Some(dir) = log.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let out = std::fs::File::create(&log)?;
    let err = out.try_clone()?;

    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args);
    // The updater finds its home and config the same way the server did.
    cmd.env("AMIRO_HOME", &state.home);
    for (key, value) in env {
        cmd.env(key, value);
    }
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

    job["startedAt"] = json!(now_iso());
    job["finishedAt"] = Value::Null;
    job["error"] = Value::Null;
    job["log"] = Value::Null;
    job["pid"] = json!(child.id());
    save_job(state, &job).await;
    tracing::info!(target = %job["target"], trigger = %job["trigger"], "update started");

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
                    "The updater stopped with exit code {}. Amiro is still on {}.",
                    code.code().map(|c| c.to_string()).unwrap_or_else(|| "unknown".into()),
                    job["from"].as_str().unwrap_or("its current version")
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
    let source = job["kind"] == "source";
    let running = if source {
        running_commit().map(|c| short_commit(&c)).unwrap_or_else(|| "an unknown commit".to_string())
    } else {
        format!("v{}", current_version())
    };
    let ok = if source {
        running_commit().is_some_and(|c| same_commit(&c, &target))
    } else {
        same_version(&target, current_version())
    };
    job["finishedAt"] = json!(now_iso());
    job["log"] = json!(log_tail(state, LOG_TAIL_LINES).await);
    if ok {
        job["state"] = json!("succeeded");
        job["error"] = Value::Null;
    } else {
        job["state"] = json!("failed");
        job["error"] = json!(format!(
            "The server restarted on {running} instead of {target}. The previous version stays installed; see the log below."
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
    out["canSelfUpdate"] = json!(method == "installer" || method == "source");
    if let Some(root) = source_checkout().filter(|_| method == "source") {
        let found = source_check(state, &root, force).await;
        out["updateAvailable"] = json!(source_behind(&found) > 0);
        out["source"] = found;
    }
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
    if update_method() == "source" {
        return tick_source(state, settings).await;
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

/// [`tick`] for a source checkout: new commits on its branch are the update.
async fn tick_source(state: &AppState, settings: Settings) -> bool {
    let Some(root) = source_checkout() else {
        return false;
    };
    let found = source_check(state, &root, true).await;
    let behind = source_behind(&found);
    let Some(latest) = found["latest"].as_str().filter(|_| behind > 0).map(str::to_string) else {
        return false;
    };
    let branch = found["branch"].as_str().unwrap_or("main");
    notify_owner(
        state,
        "system.update_available",
        &format!(
            "{behind} new change{} on {branch}",
            if behind == 1 { "" } else { "s" }
        ),
        "Open Admin → General to see what changed and update this server.",
        &format!("update-available:{latest}"),
    )
    .await;
    if !settings.auto_install || found["dirty"].as_bool().unwrap_or(false) {
        return false;
    }
    let job = load_job(state).await;
    if job_running(&job) {
        return false;
    }
    if job["state"] == "failed" && job["target"].as_str().is_some_and(|t| same_commit(t, &latest)) {
        return false;
    }
    if busy() {
        return true;
    }
    if let Err(error) = start_source(state, None, "auto").await {
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
    fn finds_the_systemd_service_that_runs_this_server() {
        assert_eq!(
            parse_systemd_unit("0::/system.slice/amiro.service\n"),
            Some(("amiro.service".to_string(), "system"))
        );
        assert_eq!(
            parse_systemd_unit("0::/user.slice/user-0.slice/user@0.service/app.slice/amiro.service"),
            Some(("amiro.service".to_string(), "user"))
        );
        // A terminal session or the user manager itself is not a service to restart.
        assert_eq!(parse_systemd_unit("0::/user.slice/user-0.slice/session-3.scope"), None);
        assert_eq!(parse_systemd_unit("0::/user.slice/user-0.slice/user@0.service"), None);
    }

    #[test]
    fn commits_are_hex_and_match_when_abbreviated() {
        assert!(is_commit("9ecb917"));
        assert!(is_commit("9ecb91775f114fbcb5ffac115cc76f9c2c0065a3"));
        assert!(!is_commit("main"));
        assert!(!is_commit("9ecb9"));
        assert!(!is_commit("--upload-pack=x"));
        assert!(same_commit("9ecb91775f114fbcb5ffac115cc76f9c2c0065a3", "9ecb917"));
        assert!(!same_commit("9ecb917", "091e80b"));
        assert!(!same_commit("", "091e80b"));
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
