//! `GET /api/system`: version and host resource usage for the General page.
//!
//! Reads `/proc` and `df` only, so it adds no dependencies. Values that the
//! host cannot report (non-Linux, restricted /proc) come back as `null` and
//! the UI shows "Unavailable".

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

async fn get_system(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let cpu = cpu_percent().await;
    let cores = std::thread::available_parallelism().map(|n| n.get()).ok();
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "cpu": { "percent": cpu, "cores": cores },
        "memory": memory(),
        "disk": disk(&state.home),
    })))
}
