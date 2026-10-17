use axum::extract::Query;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

use crate::state::{ApiError, AppState, AuthUser};

const DEFAULT_ROOTS: &[&str] = &["/root", "/home", "/srv", "/opt", "/var/www", "/tmp"];

const DENY_PREFIXES: &[&str] = &[
    "/root/.jcode",
    "/root/.config/jcode",
    "/root/.amiro-preview",
    "/root/.ssh",
    "/root/.aws",
    "/root/.gnupg",
    "/etc/letsencrypt",
    "/etc/ssl/private",
    "/root/.secrets",
];

pub fn resolve_browse_roots() -> Vec<String> {
    let mut roots = Vec::new();
    if let Ok(raw) = std::env::var("AMIRO_BROWSE_ROOTS") {
        if !raw.trim().is_empty() {
            for part in raw.split([':', ',']) {
                let p = part.trim();
                if !p.is_empty() && Path::new(p).is_absolute() {
                    let canon = std::fs::canonicalize(p)
                        .map(|c| c.to_string_lossy().to_string())
                        .unwrap_or_else(|_| p.to_string());
                    if !roots.contains(&canon) {
                        roots.push(canon);
                    }
                }
            }
        }
    }
    if roots.is_empty() {
        for &r in DEFAULT_ROOTS {
            let canon = std::fs::canonicalize(r)
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or_else(|_| r.to_string());
            if !roots.contains(&canon) {
                roots.push(canon);
            }
        }
    }
    roots
}

pub fn is_denied(abs_path: &Path) -> bool {
    let path_str = abs_path.to_string_lossy();
    for &prefix in DENY_PREFIXES {
        if path_str == prefix || path_str.starts_with(&format!("{prefix}/")) {
            return true;
        }
    }
    false
}

pub fn is_inside_roots(abs_path: &Path, roots: &[String]) -> bool {
    let path_str = abs_path.to_string_lossy();
    for r in roots {
        if path_str == *r || path_str.starts_with(&format!("{r}/")) {
            return true;
        }
    }
    false
}

#[derive(Debug, Deserialize, Default)]
struct PathQuery {
    path: Option<String>,
}

async fn get_fs_roots(_user: AuthUser) -> Json<Value> {
    let roots = resolve_browse_roots();
    Json(json!({ "roots": roots }))
}

async fn get_fs_browse(
    _user: AuthUser,
    Query(query): Query<PathQuery>,
) -> Result<Json<Value>, ApiError> {
    let raw_path = query.path.unwrap_or_default().trim().to_string();
    if raw_path.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "path is required".to_string()));
    }
    let p = Path::new(&raw_path);
    if !p.is_absolute() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "path must be absolute".to_string()));
    }

    let roots = resolve_browse_roots();

    if is_denied(p) {
        return Err(ApiError(StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    let real = std::fs::canonicalize(p).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ApiError(StatusCode::BAD_REQUEST, "path does not exist".to_string()),
        _ => ApiError(StatusCode::FORBIDDEN, "access denied".to_string()),
    })?;

    if is_denied(&real) {
        return Err(ApiError(StatusCode::FORBIDDEN, "access denied".to_string()));
    }
    if !is_inside_roots(&real, &roots) {
        return Err(ApiError(StatusCode::FORBIDDEN, "path is outside allowed roots".to_string()));
    }

    let metadata = std::fs::metadata(&real).map_err(|_| {
        ApiError(StatusCode::BAD_REQUEST, "path does not exist".to_string())
    })?;
    if !metadata.is_dir() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "path is not a directory".to_string()));
    }

    let read_dir = std::fs::read_dir(&real).map_err(|_| {
        ApiError(StatusCode::FORBIDDEN, "unable to read directory".to_string())
    })?;

    const MAX_ENTRIES: usize = 500;
    let mut names = Vec::new();
    for entry in read_dir.flatten() {
        names.push(entry.file_name().to_string_lossy().to_string());
    }

    let truncated = names.len() > MAX_ENTRIES;
    if truncated {
        names.truncate(MAX_ENTRIES);
    }

    let mut entries = Vec::new();
    for name in names {
        let full = real.join(&name);
        if is_denied(&full) {
            continue;
        }

        let mut kind = "file";
        let is_symlink = match std::fs::symlink_metadata(&full) {
            Ok(sm) => {
                if sm.is_dir() {
                    kind = "dir";
                    false
                } else {
                    sm.file_type().is_symlink()
                }
            }
            Err(_) => false,
        };

        if is_symlink {
            if let Ok(target) = std::fs::canonicalize(&full) {
                if is_denied(&target) || !is_inside_roots(&target, &roots) {
                    continue; // Skip symlinks pointing outside allowed roots
                }
                if let Ok(tm) = std::fs::metadata(&target) {
                    if tm.is_dir() {
                        kind = "dir";
                    }
                }
            }
        }

        let mut is_git_repo = false;
        if kind == "dir" {
            let git_dir = full.join(".git");
            if git_dir.exists() {
                is_git_repo = true;
            }
        }

        entries.push(json!({
            "name": name,
            "path": full.to_string_lossy(),
            "kind": kind,
            "isGitRepo": is_git_repo,
        }));
    }

    // Sort: directories first, then alphabetical case-insensitive
    entries.sort_by(|a, b| {
        let a_kind = a.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let b_kind = b.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        if a_kind != b_kind {
            if a_kind == "dir" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        } else {
            let a_name = a.get("name").and_then(|n| n.as_str()).unwrap_or("").to_lowercase();
            let b_name = b.get("name").and_then(|n| n.as_str()).unwrap_or("").to_lowercase();
            a_name.cmp(&b_name)
        }
    });

    let parent = real.parent().map(|p| p.to_string_lossy().to_string());

    Ok(Json(json!({
        "path": real.to_string_lossy(),
        "parent": parent,
        "roots": roots,
        "entries": entries,
        "truncated": truncated,
    })))
}

async fn get_fs_stat(
    _user: AuthUser,
    Query(query): Query<PathQuery>,
) -> Result<Json<Value>, ApiError> {
    let raw_path = query.path.unwrap_or_default().trim().to_string();
    if raw_path.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "path is required".to_string()));
    }
    let p = Path::new(&raw_path);
    if !p.is_absolute() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "path must be absolute".to_string()));
    }

    let roots = resolve_browse_roots();
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| raw_path.clone());

    if is_denied(p) {
        return Ok(Json(json!({
            "path": raw_path,
            "name": name,
            "kind": "unknown",
            "exists": false,
            "usable": false,
            "denied": true,
        })));
    }

    let real = match std::fs::canonicalize(p) {
        Ok(r) => r,
        Err(_) => {
            return Ok(Json(json!({
                "path": raw_path,
                "name": name,
                "kind": "unknown",
                "exists": false,
                "usable": false,
                "denied": false,
            })));
        }
    };

    if is_denied(&real) {
        return Ok(Json(json!({
            "path": real.to_string_lossy(),
            "name": name,
            "kind": "unknown",
            "exists": true,
            "usable": false,
            "denied": true,
        })));
    }

    if !is_inside_roots(&real, &roots) {
        return Ok(Json(json!({
            "path": real.to_string_lossy(),
            "name": name,
            "kind": "unknown",
            "exists": true,
            "usable": false,
            "denied": false,
            "outsideRoots": true,
        })));
    }

    let metadata = match std::fs::metadata(&real) {
        Ok(m) => m,
        Err(_) => {
            return Ok(Json(json!({
                "path": real.to_string_lossy(),
                "name": name,
                "kind": "unknown",
                "exists": false,
                "usable": false,
                "denied": false,
            })));
        }
    };

    let kind = if metadata.is_dir() {
        "dir"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    let usable = metadata.is_dir();

    Ok(Json(json!({
        "path": real.to_string_lossy(),
        "name": name,
        "kind": kind,
        "exists": true,
        "usable": usable,
        "denied": false,
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/fs/roots", get(get_fs_roots))
        .route("/api/fs/browse", get(get_fs_browse))
        .route("/api/fs/stat", get(get_fs_stat))
}
