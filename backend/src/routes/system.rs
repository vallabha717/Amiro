//! `GET /api/system`: version, deployment topology and host resource usage
//! for the General page.
//!
//! Reads `/proc`, `df` and the process environment only, so it adds no
//! dependencies. Values that the host cannot report (non-Linux, restricted
//! `/proc`) come back as `null` and the UI shows "Unavailable".
//!
//! Update support for the General page's one-click update:
//!
//! * `GET /api/system/update` (admin): compares the running version with
//!   the latest GitHub release and reports whether an update is available.
//!   Network/API failures are reported as `checkFailed`, never as errors,
//!   so the General page keeps working offline.
//! * `POST /api/system/update` (admin): replays `amiro update` detached --
//!   downloads the release `install.sh` to a temp file and executes it as
//!   `bash <file> -s -- [--version <v>]` with the version passed as a
//!   single argv element after strict validation. The server restarts
//!   itself; the response returns first.
//!
//! Updates only make sense for `install.sh`-managed servers
//! (`local-server` / `vm-remote`). The desktop build has no auto-update
//! feed, so the UI offers the release download link instead of the button.

use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::{ApiError, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/system", get(get_system))
        .route("/api/system/update", get(get_update).post(post_update))
}

const MB: f64 = 1024.0 * 1024.0;

fn cpu_times() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().next()?;
    let n: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    if n.len() < 5 {
        return None;
    }
    let idle = n[3] + n[4];
    Some((n.iter().sum(), idle))
}

async fn cpu_percent() -> Option<f64> {
    let (t1, i1) = cpu_times()?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let (t2, i2) = cpu_times()?;
    let total = t2.saturating_sub(t1);
    if total == 0 {
        return None;
    }
    let busy = total.saturating_sub(i2.saturating_sub(i1));
    Some(((busy as f64 / total as f64) * 1000.0).round() / 10.0)
}

fn memory() -> Option<Value> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb = |key: &str| -> Option<f64> {
        info.lines()
            .find(|l| l.starts_with(key))?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()
    };
    let total = kb("MemTotal:")? * 1024.0 / MB;
    let avail = kb("MemAvailable:")? * 1024.0 / MB;
    Some(json!({ "totalMb": total.round(), "usedMb": (total - avail).round() }))
}

fn disk(path: &std::path::Path) -> Option<Value> {
    let out = std::process::Command::new("df")
        .arg("-Pk")
        .arg(path)
        .output()
        .ok()?;
    let text = String::from_utf8(out.stdout).ok()?;
    let cols: Vec<&str> = text.lines().nth(1)?.split_whitespace().collect();
    let total: f64 = cols.get(1)?.parse().ok()?;
    let used: f64 = cols.get(2)?.parse().ok()?;
    Some(json!({
        "totalMb": (total * 1024.0 / MB).round(),
        "usedMb": (used * 1024.0 / MB).round(),
    }))
}

// ---------------------------------------------------------------------------
// Deployment topology (server/VM vs desktop vs local dev)
// ---------------------------------------------------------------------------

/// The bind host this backend is listening on (`AMIRO_HOST`, default
/// `127.0.0.1`). `0.0.0.0` / `::` mean "every interface", i.e. a VM/remote
/// server install.
fn bind_host() -> String {
    std::env::var("AMIRO_HOST").unwrap_or_else(|_| "127.0.0.1".into())
}

/// The port this backend is listening on (`AMIRO_PORT`, default 8787).
fn bind_port() -> u16 {
    std::env::var("AMIRO_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8787)
}

/// `true` when the bind host accepts connections from off-box clients:
/// `0.0.0.0`, `::`, or any non-loopback IP the operator named.
fn is_remote_bind(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return false;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => !ip.is_loopback(),
        Ok(IpAddr::V6(ip)) => !ip.is_loopback(),
        // A hostname we cannot resolve here is treated as remote-facing so a
        // VM install behind a DNS name still reports vm-remote.
        Err(_) => true,
    }
}

/// Enumerate this machine's non-loopback IPv4 addresses so the General page
/// can print the exact `http://<ip>:<port>` URL to open from a phone/laptop.
/// `hostname -I` on Linux, the `getifaddrs` interface list on macOS, and a
/// best-effort UDP-connect trick elsewhere; empty when none can be found.
fn lan_ipv4_addresses() -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    // Linux: `hostname -I` prints every interface address, space-separated.
    if let Ok(output) = std::process::Command::new("hostname").arg("-I").output() {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                for field in text.split_whitespace() {
                    if let Ok(IpAddr::V4(ip)) = field.parse::<IpAddr>() {
                        if !ip.is_loopback() {
                            let candidate = ip.to_string();
                            if !found.contains(&candidate) {
                                found.push(candidate);
                            }
                        }
                    }
                }
            }
        }
    }
    if !found.is_empty() {
        return found;
    }
    // macOS / BSD: `ifconfig` names each inet address per interface.
    if let Ok(output) = std::process::Command::new("ifconfig").output() {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                for line in text.lines() {
                    let line = line.trim();
                    let Some(rest) = line.strip_prefix("inet ") else {
                        continue;
                    };
                    let Some(field) = rest.split_whitespace().next() else {
                        continue;
                    };
                    if let Ok(IpAddr::V4(ip)) = field.parse::<IpAddr>() {
                        if !ip.is_loopback() {
                            let candidate = ip.to_string();
                            if !found.contains(&candidate) {
                                found.push(candidate);
                            }
                        }
                    }
                }
            }
        }
    }
    if !found.is_empty() {
        return found;
    }
    // Portable last resort: a UDP "connect" to a public address makes the OS
    // pick the local route (and sends no packet), then we read the chosen IP.
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                if let IpAddr::V4(ip) = addr.ip() {
                    if !ip.is_loopback() {
                        found.push(ip.to_string());
                    }
                }
            }
        }
    }
    found
}

/// The `deployment` block of `GET /api/system`.
///
/// - `mode`: `"vm-remote"` when the backend binds a non-loopback host (an
///   install reachable from another machine, e.g. `AMIRO_HOST=0.0.0.0` on a
///   VM), `"desktop"` when the Tauri desktop shell set `AMIRO_DESKTOP=1`,
///   otherwise `"local-server"`.
/// - `bindHost` / `port`: the exact `AMIRO_HOST` / `AMIRO_PORT` in effect.
/// - `accessUrls`: `http://localhost:<port>` plus one `http://<ip>:<port>`
///   per detected non-loopback IPv4 address, so the UI can tell the user
///   exactly which URL to open from anywhere.
/// - `desktopBundled`: whether a `runtime`/`amiro-runtime` sidecar sits next
///   to this executable (the packaged desktop/Tauri layout).
pub fn deployment_info() -> Value {
    let host = bind_host();
    let port = bind_port();
    let mode = if std::env::var("AMIRO_DESKTOP")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        "desktop"
    } else if is_remote_bind(&host) {
        "vm-remote"
    } else {
        "local-server"
    };

    let mut access_urls = vec![format!("http://localhost:{port}")];
    for ip in lan_ipv4_addresses() {
        let url = format!("http://{ip}:{port}");
        if !access_urls.contains(&url) {
            access_urls.push(url);
        }
    }

    let desktop_bundled = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
        .map(|dir| {
            ["runtime", "amiro-runtime"].iter().any(|name| {
                dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
                    .is_file()
            })
        })
        .unwrap_or(false);

    json!({
        "mode": mode,
        "bindHost": host,
        "port": port,
        "accessUrls": access_urls,
        "desktopBundled": desktop_bundled,
    })
}

async fn get_system(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let cpu = cpu_percent().await;
    let cores = std::thread::available_parallelism().map(|n| n.get()).ok();
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "deployment": deployment_info(),
        "cpu": { "percent": cpu, "cores": cores },
        "memory": memory(),
        "disk": disk(&state.home),
    })))
}

// ---------------------------------------------------------------------------
// One-click update (General page)
// ---------------------------------------------------------------------------

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(
            axum::http::StatusCode::FORBIDDEN,
            "Forbidden".to_string(),
        ));
    }
    Ok(())
}

fn repo_slug() -> String {
    std::env::var("AMIRO_REPO").unwrap_or_else(|_| "vallabha717/Amiro".to_string())
}

/// "v1.26.0" -> (1, 26, 0, None). Anything else -> None, which compares as
/// "not newer" so a weird tag can never trigger an update prompt.
fn parse_version(raw: &str) -> Option<(u64, u64, u64, Option<String>)> {
    let stripped = raw.trim().strip_prefix(['v', 'V']).unwrap_or(raw.trim());
    let (core, prerelease) = match stripped.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_string())),
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
fn compare_versions(a: &str, b: &str) -> i8 {
    let (pa, pb) = match (parse_version(a), parse_version(b)) {
        (Some(pa), Some(pb)) => (pa, pb),
        _ => return 0,
    };
    for i in 0..3 {
        let (x, y) = match i {
            0 => (pa.0, pb.0),
            1 => (pa.1, pb.1),
            _ => (pa.2, pb.2),
        };
        if x != y {
            return if x < y { -1 } else { 1 };
        }
    }
    match (&pa.3, &pb.3) {
        (None, None) => 0,
        (None, Some(_)) => 1,
        (Some(_), None) => -1,
        (Some(x), Some(y)) => {
            if x == y {
                0
            } else if x < y {
                -1
            } else {
                1
            }
        }
    }
}

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

struct CachedCheck {
    at: Instant,
    repo: String,
    current: String,
    result: Value,
}

static UPDATE_CHECK_CACHE: OnceLock<std::sync::Mutex<Option<CachedCheck>>> =
    OnceLock::new();

fn update_cache() -> &'static std::sync::Mutex<Option<CachedCheck>> {
    UPDATE_CHECK_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

const UPDATE_CHECK_TTL: Duration = Duration::from_secs(10 * 60);

async fn get_update(
    State(_state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    let repo = repo_slug();

    if let Ok(guard) = update_cache().lock() {
        if let Some(hit) = guard.as_ref() {
            if hit.repo == repo
                && hit.current == current
                && hit.at.elapsed() < UPDATE_CHECK_TTL
            {
                return Ok(Json(hit.result.clone()));
            }
        }
    }

    let result = match check_github_release(&repo, &current).await {
        Ok(v) => v,
        Err(_) => json!({
            "current": current,
            "latest": null,
            "updateAvailable": false,
            "releaseUrl": format!("https://github.com/{repo}/releases"),
            "publishedAt": null,
            "checkFailed": true,
            "noReleases": false,
        }),
    };

    if let Ok(mut guard) = update_cache().lock() {
        *guard = Some(CachedCheck {
            at: Instant::now(),
            repo,
            current,
            result: result.clone(),
        });
    }
    Ok(Json(result))
}

async fn check_github_release(repo: &str, current: &str) -> Result<Value, String> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let resp = http_client()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == axum::http::StatusCode::NOT_FOUND {
        return Ok(json!({
            "current": current,
            "latest": null,
            "updateAvailable": false,
            "releaseUrl": format!("https://github.com/{repo}/releases"),
            "publishedAt": null,
            "checkFailed": false,
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
        .ok_or_else(|| "release has no tag_name".to_string())?;
    Ok(json!({
        "current": current,
        "latest": latest,
        "updateAvailable": compare_versions(current, latest) < 0,
        "releaseUrl": body.get("html_url").and_then(|u| u.as_str()).unwrap_or(&format!("https://github.com/{repo}/releases/latest")),
        "publishedAt": body.get("published_at").cloned().unwrap_or(Value::Null),
        "checkFailed": false,
        "noReleases": false,
    }))
}

#[derive(serde::Deserialize)]
struct UpdateRequest {
    version: Option<String>,
}

async fn post_update(
    State(_state): State<AppState>,
    user: AuthUser,
    body: Option<Json<UpdateRequest>>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let version = body.and_then(|b| b.0.version).map(|v| v.trim().to_string());
    if let Some(ref v) = version {
        if parse_version(v).is_none() {
            return Err(ApiError(
                axum::http::StatusCode::BAD_REQUEST,
                format!("refusing to update to unparseable version: {v}"),
            ));
        }
    }

    // Download install.sh first (fail fast on network errors), then run it
    // detached so this response returns before the restart kills us.
    // `bash` is argv-executed -- no shell string anywhere -- and the version
    // travels as a single validated argv element.
    let repo = repo_slug();
    let url = match &version {
        Some(v) => format!("https://github.com/{repo}/releases/download/{v}/install.sh"),
        None => format!("https://github.com/{repo}/releases/latest/download/install.sh"),
    };
    let script = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("could not download installer: {e}")))?
        .error_for_status()
        .map_err(|e| ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("could not download installer: {e}")))?
        .text()
        .await
        .map_err(|e| ApiError(axum::http::StatusCode::BAD_GATEWAY, format!("could not download installer: {e}")))?;
    if !script.starts_with("#!/usr/bin/env bash") {
        return Err(ApiError(
            axum::http::StatusCode::BAD_GATEWAY,
            "downloaded installer failed the sanity check".to_string(),
        ));
    }
    let dir = std::env::temp_dir().join(format!("amiro-update-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| ApiError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let script_path = dir.join("install.sh");
    std::fs::write(&script_path, script).map_err(|e| ApiError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).map_err(|e| ApiError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).map_err(|e| ApiError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg(&script_path).arg("-s").arg("--");
    if let Some(ref v) = version {
        cmd.arg("--version").arg(v);
    }
    // Detached: the installer restarts the server, so it must outlive us.
    // A fresh process group (std-only, no libc) keeps server shutdown
    // signals from reaching the installer. stdio is dropped.
    #[cfg(unix)]
    {
        // tokio::process::Command::process_group is an inherent method
        // (no trait import needed). On platforms without it, tokio exposes
        // the std trait under tokio::process.
        cmd.process_group(0);
    }
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| ApiError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, format!("could not start update: {e}")))?;
    Ok(Json(json!({
        "started": true,
        "version": version.unwrap_or_else(|| "latest".to_string()),
        "pid": child.id(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_v_prefixed_versions() {
        assert_eq!(
            parse_version("v1.26.0"),
            Some((1, 26, 0, None))
        );
        assert_eq!(
            parse_version("1.26.0-rc.1"),
            Some((1, 26, 0, Some("rc.1".to_string())))
        );
        assert_eq!(parse_version("dev"), None);
        assert_eq!(parse_version("1.26"), None);
        assert_eq!(parse_version("1.26.0.1"), None);
    }

    #[test]
    fn newer_releases_compare_greater() {
        assert_eq!(compare_versions("1.26.0", "v1.27.0"), -1);
        assert_eq!(compare_versions("v1.27.0", "1.26.0"), 1);
        assert_eq!(compare_versions("1.26.0", "1.26.0"), 0);
        assert_eq!(compare_versions("1.26.0-rc.1", "1.26.0"), -1);
        assert_eq!(compare_versions("1.26.0", "1.26.0-rc.1"), 1);
        // Unparseable input never claims newer or older.
        assert_eq!(compare_versions("dev", "1.26.0"), 0);
        assert_eq!(compare_versions("1.26.0", "dev"), 0);
    }
}
