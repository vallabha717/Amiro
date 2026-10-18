//! `GET /api/system`: version, deployment topology and host resource usage
//! for the General page.
//!
//! Reads `/proc`, `df` and the process environment only, so it adds no
//! dependencies. Values that the host cannot report (non-Linux, restricted
//! `/proc`) come back as `null` and the UI shows "Unavailable".

use std::net::IpAddr;
use std::time::Duration;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::{ApiError, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/system", get(get_system))
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
