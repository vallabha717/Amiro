// backend/src/routes/agent_workspace.rs -- the agent's own workspace browser.
//
// Root is `state.workspace` (~/.amiro/workspace), the directory the agent uses as
// its working directory in chats. Rules enforced for every path:
//   - relative only, normalized, no `..`, realpath-contained in the root
//     (symlink escapes rejected);
//   - dot-segments are hidden unless `showHidden=1`, and are never writable;
//   - the top-level `users/` directory is internal (never listed/read/written);
//   - names from the shared secret blocklist (.env, .git, node_modules, ...) are
//     never listed or read.
// Reads need a session; writes need the admin (owner) role.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Query};
use axum::http::header::{
    CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_SECURITY_POLICY, CONTENT_TYPE,
};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent::{is_blocked_workspace_path, sanitize_user_id};
use crate::routes::agents::AgentState;
use crate::state::{ApiError, AppState, AuthUser};

const MAX_INLINE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 5 * 1024 * 1024;
const SNIFF_BYTES: usize = 8192;
const PERSONA_FILES: [&str; 2] = ["IDENTITY.md", "SOUL.md"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Read,
    Write,
}

fn err(status: StatusCode, msg: &str) -> ApiError {
    ApiError(status, msg.to_string())
}

fn forbidden(msg: &str) -> ApiError {
    err(StatusCode::FORBIDDEN, msg)
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(forbidden("admin required"));
    }
    Ok(())
}

struct Resolved {
    /// Absolute, symlink-resolved path (for `follow_last=false`, the parent is
    /// resolved and the final component is left as-is).
    abs: PathBuf,
    /// Normalized root-relative posix path ("" for the root).
    rel: String,
}

fn is_dot(seg: &str) -> bool {
    seg.starts_with('.')
}

fn check_rel_segments(segs: &[&str], access: Access, show_hidden: bool) -> Result<(), ApiError> {
    if let Some(first) = segs.first() {
        if first.eq_ignore_ascii_case("users") {
            return Err(forbidden("this folder is internal"));
        }
    }
    if segs.iter().any(|s| is_dot(s)) {
        if access == Access::Write {
            return Err(forbidden("hidden files are not writable"));
        }
        if !show_hidden {
            return Err(forbidden("hidden files are not shown"));
        }
    }
    if is_blocked_workspace_path(&segs.join("/")) {
        return Err(forbidden("access to sensitive file is not allowed"));
    }
    Ok(())
}

/// Resolve `rel` inside `root`. With `follow_last == false` a trailing symlink is
/// not followed (rename/delete act on the link itself).
fn resolve(
    root: &Path,
    rel: &str,
    access: Access,
    show_hidden: bool,
    follow_last: bool,
) -> Result<Resolved, ApiError> {
    if rel.contains('\0') {
        return Err(err(StatusCode::BAD_REQUEST, "invalid path"));
    }
    let norm = rel.replace('\\', "/");
    if norm.starts_with('/') || (norm.len() >= 2 && norm.as_bytes()[1] == b':') {
        return Err(forbidden("absolute paths are not allowed"));
    }
    let mut segs: Vec<&str> = Vec::new();
    for s in norm.split('/') {
        match s {
            "" | "." => {}
            ".." => return Err(forbidden("path traversal is not allowed")),
            other => segs.push(other),
        }
    }
    check_rel_segments(&segs, access, show_hidden)?;

    let real_root = std::fs::canonicalize(root)
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "workspace is unavailable"))?;
    let mut target = real_root.clone();
    for s in &segs {
        target.push(s);
    }
    let rel_clean = segs.join("/");
    if segs.is_empty() {
        return Ok(Resolved { abs: real_root, rel: rel_clean });
    }

    let real_target = if follow_last {
        resolve_existing_prefix(&target)?
    } else {
        let parent = target.parent().unwrap_or(&real_root);
        let name = target.file_name().unwrap_or_default().to_os_string();
        resolve_existing_prefix(parent)?.join(name)
    };
    if !real_target.starts_with(&real_root) {
        return Err(forbidden("path traversal via symlink is not allowed"));
    }
    // Re-check the resolved location (a symlink may point at users/ or a blocked name).
    let real_rel = real_target
        .strip_prefix(&real_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let real_segs: Vec<&str> = real_rel.split('/').filter(|s| !s.is_empty()).collect();
    if follow_last {
        // Hidden-ness of the real target only matters for writes.
        check_rel_segments(&real_segs, access, show_hidden || access == Access::Read)?;
    }
    Ok(Resolved { abs: real_target, rel: rel_clean })
}

/// Canonicalize the longest existing prefix of `p`, then re-append the rest.
fn resolve_existing_prefix(p: &Path) -> Result<PathBuf, ApiError> {
    let mut existing = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(real) => {
                let mut out = real;
                for s in rest.iter().rev() {
                    out.push(s);
                }
                return Ok(out);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                match (existing.file_name(), existing.parent()) {
                    (Some(name), Some(parent)) => {
                        rest.push(name.to_os_string());
                        existing = parent.to_path_buf();
                    }
                    _ => return Err(err(StatusCode::NOT_FOUND, "not found")),
                }
            }
            Err(_) => return Err(forbidden("path is not accessible")),
        }
    }
}

fn iso(t: std::io::Result<std::time::SystemTime>) -> Value {
    match t {
        Ok(t) => Value::String(chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()),
        Err(_) => Value::Null,
    }
}

fn not_found_or(e: std::io::Error) -> ApiError {
    ApiError::from(e)
}

// ---------------------------------------------------------------------------
// Core operations (synchronous, unit-tested)
// ---------------------------------------------------------------------------

fn list_tree(root: &Path, rel: &str, show_hidden: bool) -> Result<Value, ApiError> {
    let r = resolve(root, rel, Access::Read, show_hidden, true)?;
    let md = std::fs::metadata(&r.abs).map_err(not_found_or)?;
    if !md.is_dir() {
        return Err(err(StatusCode::BAD_REQUEST, "path is not a directory"));
    }
    let real_root = std::fs::canonicalize(root)?;
    let mut entries: Vec<(bool, String, Value)> = Vec::new();
    for ent in std::fs::read_dir(&r.abs)?.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let hidden = is_dot(&name);
        if hidden && !show_hidden {
            continue;
        }
        if r.rel.is_empty() && name.eq_ignore_ascii_case("users") {
            continue;
        }
        if is_blocked_workspace_path(&name) {
            continue;
        }
        let child_abs = ent.path();
        // Follow symlinks but drop anything that escapes the root or is unreadable.
        let Ok(real_child) = std::fs::canonicalize(&child_abs) else { continue };
        if !real_child.starts_with(&real_root) {
            continue;
        }
        let Ok(cmd) = std::fs::metadata(&real_child) else { continue };
        let is_dir = cmd.is_dir();
        let child_rel = if r.rel.is_empty() { name.clone() } else { format!("{}/{}", r.rel, name) };
        entries.push((
            is_dir,
            name.to_lowercase(),
            json!({
                "name": name,
                "path": child_rel,
                "type": if is_dir { "dir" } else { "file" },
                "size": if is_dir { 0 } else { cmd.len() },
                "modifiedAt": iso(cmd.modified()),
                "hidden": hidden,
            }),
        ));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    Ok(json!({
        "path": r.rel,
        "entries": entries.into_iter().map(|e| e.2).collect::<Vec<_>>(),
    }))
}

fn sniff_binary(path: &Path) -> std::io::Result<bool> {
    let mut buf = vec![0u8; SNIFF_BYTES];
    let mut f = std::fs::File::open(path)?;
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    if buf.contains(&0) {
        return Ok(true);
    }
    match std::str::from_utf8(&buf) {
        Ok(_) => Ok(false),
        // A multibyte char may be cut at the sniff boundary.
        Err(e) => Ok(!(e.error_len().is_none() && n == SNIFF_BYTES)),
    }
}

fn mime_of(path: &Path) -> String {
    let guess = mime_guess::from_path(path).first();
    match guess {
        Some(m) => m.essence_str().to_string(),
        None => "application/octet-stream".to_string(),
    }
}

fn read_file(root: &Path, rel: &str, show_hidden: bool) -> Result<Value, ApiError> {
    let r = resolve(root, rel, Access::Read, show_hidden, true)?;
    let md = std::fs::metadata(&r.abs).map_err(not_found_or)?;
    if md.is_dir() {
        return Err(err(StatusCode::BAD_REQUEST, "path is a directory"));
    }
    let name = r.rel.rsplit('/').next().unwrap_or("").to_string();
    let mime = mime_of(&r.abs);
    let is_image = mime.starts_with("image/") && mime != "image/svg+xml";
    let is_binary = is_image || sniff_binary(&r.abs)?;
    let too_large = md.len() > MAX_INLINE_BYTES;
    let content = if is_binary || too_large {
        Value::Null
    } else {
        let bytes = std::fs::read(&r.abs)?;
        Value::String(String::from_utf8_lossy(&bytes).to_string())
    };
    Ok(json!({
        "path": r.rel,
        "name": name,
        "size": md.len(),
        "mimeType": if is_binary || mime != "application/octet-stream" { mime } else { "text/plain".to_string() },
        "modifiedAt": iso(md.modified()),
        "isBinary": is_binary,
        "tooLarge": too_large && !is_binary,
        "content": content,
    }))
}

fn write_file(root: &Path, rel: &str, bytes: &[u8]) -> Result<Value, ApiError> {
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(err(StatusCode::PAYLOAD_TOO_LARGE, "file exceeds the 5 MB limit"));
    }
    let r = resolve(root, rel, Access::Write, false, true)?;
    if r.rel.is_empty() {
        return Err(err(StatusCode::CONFLICT, "path is a directory"));
    }
    if r.abs.is_dir() {
        return Err(err(StatusCode::CONFLICT, "path is a directory"));
    }
    if let Some(parent) = r.abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| err(StatusCode::CONFLICT, "cannot create parent folder"))?;
    }
    std::fs::write(&r.abs, bytes)?;
    let md = std::fs::metadata(&r.abs)?;
    Ok(json!({ "path": r.rel, "size": md.len(), "modifiedAt": iso(md.modified()) }))
}

fn make_dir(root: &Path, rel: &str) -> Result<Value, ApiError> {
    let r = resolve(root, rel, Access::Write, false, true)?;
    if r.rel.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "path is required"));
    }
    if r.abs.exists() && !r.abs.is_dir() {
        return Err(err(StatusCode::CONFLICT, "a file with that name already exists"));
    }
    std::fs::create_dir_all(&r.abs)
        .map_err(|_| err(StatusCode::CONFLICT, "cannot create folder"))?;
    Ok(json!({ "path": r.rel }))
}

fn rename_path(root: &Path, from: &str, to: &str) -> Result<Value, ApiError> {
    let src = resolve(root, from, Access::Write, false, false)?;
    let dst = resolve(root, to, Access::Write, false, false)?;
    if src.rel.is_empty() || dst.rel.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "the workspace root cannot be renamed"));
    }
    if std::fs::symlink_metadata(&src.abs).is_err() {
        return Err(err(StatusCode::NOT_FOUND, "source not found"));
    }
    if std::fs::symlink_metadata(&dst.abs).is_ok() {
        return Err(err(StatusCode::CONFLICT, "destination already exists"));
    }
    if dst.rel.starts_with(&format!("{}/", src.rel)) {
        return Err(err(StatusCode::BAD_REQUEST, "cannot move a folder into itself"));
    }
    if let Some(parent) = dst.abs.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| err(StatusCode::CONFLICT, "cannot create destination folder"))?;
    }
    std::fs::rename(&src.abs, &dst.abs)?;
    Ok(json!({ "from": src.rel, "to": dst.rel }))
}

fn delete_path(root: &Path, rel: &str) -> Result<Value, ApiError> {
    let r = resolve(root, rel, Access::Write, false, false)?;
    if r.rel.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "the workspace root cannot be deleted"));
    }
    let md = std::fs::symlink_metadata(&r.abs).map_err(not_found_or)?;
    if md.is_dir() {
        std::fs::remove_dir_all(&r.abs)?;
    } else {
        std::fs::remove_file(&r.abs)?;
    }
    Ok(json!({ "path": r.rel }))
}

fn persona_files(workspace: &Path, user_id: &str) -> Vec<Value> {
    let Some(uid) = sanitize_user_id(Some(user_id)) else { return Vec::new() };
    let Ok(real_ws) = std::fs::canonicalize(workspace) else { return Vec::new() };
    let dir = workspace.join("users").join(uid);
    let mut out = Vec::new();
    for name in PERSONA_FILES {
        let Ok(real) = std::fs::canonicalize(dir.join(name)) else { continue };
        if !real.starts_with(&real_ws) {
            continue;
        }
        let Ok(md) = std::fs::metadata(&real) else { continue };
        if !md.is_file() || md.len() > MAX_INLINE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&real) else { continue };
        out.push(json!({
            "name": name,
            "content": String::from_utf8_lossy(&bytes),
            "size": md.len(),
            "modifiedAt": iso(md.modified()),
        }));
    }
    out
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type Params = Query<HashMap<String, String>>;

fn flag(params: &HashMap<String, String>, key: &str) -> bool {
    matches!(params.get(key).map(String::as_str), Some("1" | "true"))
}

fn param(params: &HashMap<String, String>, key: &str) -> String {
    params.get(key).cloned().unwrap_or_default()
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "workspace task failed"))?
}

async fn get_tree(
    AgentState(state): AgentState,
    _user: AuthUser,
    Query(p): Params,
) -> Result<Json<Value>, ApiError> {
    let (root, path, hidden) = (state.workspace.clone(), param(&p, "path"), flag(&p, "showHidden"));
    Ok(Json(blocking(move || list_tree(&root, &path, hidden)).await?))
}

async fn get_file(
    AgentState(state): AgentState,
    _user: AuthUser,
    Query(p): Params,
) -> Result<Json<Value>, ApiError> {
    let (root, path, hidden) = (state.workspace.clone(), param(&p, "path"), flag(&p, "showHidden"));
    Ok(Json(blocking(move || read_file(&root, &path, hidden)).await?))
}

fn header_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' && c != ';' { c } else { '_' })
        .collect()
}

async fn get_file_raw(
    AgentState(state): AgentState,
    _user: AuthUser,
    Query(p): Params,
) -> Result<Response, ApiError> {
    let (root, path, hidden) = (state.workspace.clone(), param(&p, "path"), flag(&p, "showHidden"));
    let download = flag(&p, "download");
    let (bytes, mime, name) = blocking(move || {
        let r = resolve(&root, &path, Access::Read, hidden, true)?;
        let md = std::fs::metadata(&r.abs).map_err(not_found_or)?;
        if md.is_dir() {
            return Err(err(StatusCode::BAD_REQUEST, "path is a directory"));
        }
        let bytes = std::fs::read(&r.abs)?;
        let name = r.rel.rsplit('/').next().unwrap_or("file").to_string();
        Ok((bytes, mime_of(&r.abs), name))
    })
    .await?;
    let inline = !download && mime.starts_with("image/");
    let disposition = format!(
        "{}; filename=\"{}\"",
        if inline { "inline" } else { "attachment" },
        header_filename(&name)
    );
    let mut resp = Response::new(Body::from(bytes.clone()));
    let h = resp.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(CONTENT_LENGTH, HeaderValue::from(bytes.len()));
    h.insert(CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).unwrap_or(HeaderValue::from_static("attachment")));
    h.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    Ok(resp.into_response())
}

#[derive(Deserialize)]
struct WriteBody {
    path: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    encoding: Option<String>,
}

async fn post_write(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<WriteBody>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let bytes = match body.encoding.as_deref() {
        None | Some("utf8") | Some("utf-8") => body.content.into_bytes(),
        Some("base64") => base64::engine::general_purpose::STANDARD
            .decode(body.content.as_bytes())
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid base64 content"))?,
        Some(_) => return Err(err(StatusCode::BAD_REQUEST, "unsupported encoding")),
    };
    let (root, path) = (state.workspace.clone(), body.path);
    Ok(Json(blocking(move || write_file(&root, &path, &bytes)).await?))
}

#[derive(Deserialize)]
struct PathBody {
    path: String,
}

#[derive(Deserialize)]
struct RenameBody {
    from: String,
    to: String,
}

async fn post_mkdir(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<PathBody>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let root = state.workspace.clone();
    Ok(Json(blocking(move || make_dir(&root, &body.path)).await?))
}

async fn post_rename(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<RenameBody>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let root = state.workspace.clone();
    Ok(Json(blocking(move || rename_path(&root, &body.from, &body.to)).await?))
}

async fn post_delete(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<PathBody>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let root = state.workspace.clone();
    Ok(Json(blocking(move || delete_path(&root, &body.path)).await?))
}

async fn get_agent_files(
    AgentState(state): AgentState,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let uid = user.0.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ws = state.workspace.clone();
    let files = blocking(move || Ok(persona_files(&ws, &uid))).await?;
    Ok(Json(Value::Array(files)))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/workspace/tree", get(get_tree))
        .route("/api/workspace/file", get(get_file))
        .route("/api/workspace/file/raw", get(get_file_raw))
        .route("/api/workspace/agent-files", get(get_agent_files))
        .route(
            "/api/workspace/write",
            post(post_write).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/api/workspace/mkdir", post(post_mkdir))
        .route("/api/workspace/rename", post(post_rename))
        .route("/api/workspace/delete", post(post_delete))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    fn temp_state() -> (AppState, PathBuf) {
        let root = std::env::temp_dir().join(format!("amiro-aw-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let workspace = home.join("workspace");
        let runtime_home = root.join("runtime");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&runtime_home).unwrap();
        let state = AppState {
            home,
            runtime_home,
            runtime_socket: root.join("runtime.sock"),
            workspace,
            runtime_bin: root.join("amiro"),
            token: "test-token".to_string(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        };
        (state, root)
    }

    fn status<T>(r: Result<T, ApiError>) -> StatusCode {
        match r {
            Ok(_) => StatusCode::OK,
            Err(e) => e.0,
        }
    }

    fn names(v: &Value) -> Vec<String> {
        v["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn rejects_traversal_and_absolute() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        assert_eq!(status(list_tree(ws, "../", false)), StatusCode::FORBIDDEN);
        assert_eq!(status(read_file(ws, "a/../../x", false)), StatusCode::FORBIDDEN);
        assert_eq!(status(read_file(ws, "/etc/passwd", false)), StatusCode::FORBIDDEN);
        assert_eq!(status(write_file(ws, "../evil.txt", b"x")), StatusCode::FORBIDDEN);
        assert!(!tmp.join("home/evil.txt").exists());
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), ws.join("file-link")).unwrap();
        assert_eq!(status(read_file(ws, "link/secret.txt", false)), StatusCode::FORBIDDEN);
        assert_eq!(status(read_file(ws, "file-link", false)), StatusCode::FORBIDDEN);
        assert_eq!(status(write_file(ws, "link/new.txt", b"x")), StatusCode::FORBIDDEN);
        assert!(!outside.join("new.txt").exists());
        // Escaping links are not listed.
        std::fs::write(ws.join("ok.txt"), "ok").unwrap();
        assert_eq!(names(&list_tree(ws, "", false).unwrap()), vec!["ok.txt"]);
        // Deleting the link removes only the link.
        delete_path(ws, "link").unwrap();
        assert!(outside.join("secret.txt").exists());
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_users_dir_is_rejected() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        std::fs::create_dir_all(ws.join("users/u1")).unwrap();
        std::fs::write(ws.join("users/u1/SOUL.md"), "x").unwrap();
        std::os::unix::fs::symlink(ws.join("users"), ws.join("sneaky")).unwrap();
        assert_eq!(status(read_file(ws, "sneaky/u1/SOUL.md", false)), StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn hidden_and_users_protection() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        std::fs::create_dir_all(ws.join("users/u1")).unwrap();
        std::fs::write(ws.join("users/u1/SOUL.md"), "x").unwrap();
        std::fs::write(ws.join(".dot"), "d").unwrap();
        std::fs::write(ws.join("a.txt"), "a").unwrap();
        let t = list_tree(ws, "", false).unwrap();
        assert_eq!(names(&t), vec!["a.txt"]);
        let t = list_tree(ws, "", true).unwrap();
        assert_eq!(names(&t), vec![".dot", "a.txt"]);
        assert_eq!(t["entries"][0]["hidden"], json!(true));
        assert_eq!(status(read_file(ws, ".dot", false)), StatusCode::FORBIDDEN);
        assert_eq!(status(read_file(ws, ".dot", true)), StatusCode::OK);
        assert_eq!(status(write_file(ws, ".dot", b"x")), StatusCode::FORBIDDEN);
        assert_eq!(status(write_file(ws, "d/.hidden", b"x")), StatusCode::FORBIDDEN);
        assert_eq!(status(delete_path(ws, ".dot")), StatusCode::FORBIDDEN);
        // users/ is internal in every mode.
        assert_eq!(status(list_tree(ws, "users", true)), StatusCode::FORBIDDEN);
        assert_eq!(status(read_file(ws, "users/u1/SOUL.md", true)), StatusCode::FORBIDDEN);
        assert_eq!(status(write_file(ws, "users/x.txt", b"x")), StatusCode::FORBIDDEN);
        assert_eq!(status(rename_path(ws, "a.txt", "users/a.txt")), StatusCode::FORBIDDEN);
        // A nested `users` folder is an ordinary folder.
        assert_eq!(status(write_file(ws, "notes/users/a.txt", b"x")), StatusCode::OK);
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn blocked_names_never_listed_or_read() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        std::fs::write(ws.join("credentials.json"), "{}").unwrap();
        std::fs::write(ws.join("server.pem"), "k").unwrap();
        std::fs::create_dir_all(ws.join("node_modules")).unwrap();
        std::fs::write(ws.join("fine.md"), "ok").unwrap();
        assert_eq!(names(&list_tree(ws, "", true).unwrap()), vec!["fine.md"]);
        assert_eq!(status(read_file(ws, "credentials.json", true)), StatusCode::FORBIDDEN);
        assert_eq!(status(read_file(ws, "server.pem", true)), StatusCode::FORBIDDEN);
        assert_eq!(status(write_file(ws, "node_modules/x.js", b"x")), StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn tree_sorts_dirs_first_and_reads_text_binary() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        std::fs::create_dir_all(ws.join("zdir")).unwrap();
        std::fs::write(ws.join("b.md"), "# hi").unwrap();
        std::fs::write(ws.join("A.txt"), "a").unwrap();
        std::fs::write(ws.join("pic.png"), [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        assert_eq!(names(&list_tree(ws, "", false).unwrap()), vec!["zdir", "A.txt", "b.md", "pic.png"]);
        let f = read_file(ws, "b.md", false).unwrap();
        assert_eq!(f["content"], json!("# hi"));
        assert_eq!(f["isBinary"], json!(false));
        assert_eq!(f["mimeType"], json!("text/markdown"));
        let p = read_file(ws, "pic.png", false).unwrap();
        assert_eq!(p["isBinary"], json!(true));
        assert!(p["content"].is_null());
        assert_eq!(p["mimeType"], json!("image/png"));
        assert_eq!(status(read_file(ws, "zdir", false)), StatusCode::BAD_REQUEST);
        assert_eq!(status(read_file(ws, "missing.txt", false)), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn write_mkdir_rename_delete_happy_paths() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        let w = write_file(ws, "notes/deep/a.md", b"hello").unwrap();
        assert_eq!(w["size"], json!(5));
        assert_eq!(std::fs::read_to_string(ws.join("notes/deep/a.md")).unwrap(), "hello");
        assert_eq!(status(write_file(ws, "notes", b"x")), StatusCode::CONFLICT);
        make_dir(ws, "empty/dir").unwrap();
        assert!(ws.join("empty/dir").is_dir());
        assert_eq!(status(make_dir(ws, "notes/deep/a.md")), StatusCode::CONFLICT);
        rename_path(ws, "notes/deep/a.md", "notes/b.md").unwrap();
        assert!(ws.join("notes/b.md").exists() && !ws.join("notes/deep/a.md").exists());
        write_file(ws, "c.md", b"c").unwrap();
        assert_eq!(status(rename_path(ws, "c.md", "notes/b.md")), StatusCode::CONFLICT);
        assert_eq!(status(rename_path(ws, "", "x")), StatusCode::BAD_REQUEST);
        assert_eq!(status(rename_path(ws, "notes", "notes/inner")), StatusCode::BAD_REQUEST);
        assert_eq!(status(rename_path(ws, "nope", "x")), StatusCode::NOT_FOUND);
        delete_path(ws, "notes").unwrap();
        assert!(!ws.join("notes").exists());
        assert_eq!(status(delete_path(ws, "")), StatusCode::BAD_REQUEST);
        assert_eq!(status(delete_path(ws, "notes")), StatusCode::NOT_FOUND);
        assert!(ws.exists());
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn write_size_cap() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        let big = vec![b'a'; MAX_WRITE_BYTES + 1];
        assert_eq!(status(write_file(ws, "big.txt", &big)), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!ws.join("big.txt").exists());
        assert_eq!(status(write_file(ws, "ok.txt", &big[..MAX_WRITE_BYTES])), StatusCode::OK);
        // Files above the inline cap return no content.
        let large = vec![b'a'; (MAX_INLINE_BYTES + 1) as usize];
        write_file(ws, "large.txt", &large).unwrap();
        let f = read_file(ws, "large.txt", false).unwrap();
        assert!(f["content"].is_null());
        assert_eq!(f["tooLarge"], json!(true));
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn persona_files_are_per_user_and_read_only_listing() {
        let (st, tmp) = temp_state();
        let ws = &st.workspace;
        std::fs::create_dir_all(ws.join("users/u1")).unwrap();
        std::fs::write(ws.join("users/u1/IDENTITY.md"), "id").unwrap();
        std::fs::write(ws.join("users/u1/SOUL.md"), "soul").unwrap();
        std::fs::write(ws.join("users/u1/prompt-overlay.md"), "x").unwrap();
        let files = persona_files(ws, "u1");
        let n: Vec<_> = files.iter().map(|f| f["name"].as_str().unwrap()).collect();
        assert_eq!(n, vec!["IDENTITY.md", "SOUL.md"]);
        assert!(persona_files(ws, "other").is_empty());
        assert!(persona_files(ws, "../u1").len() <= 2); // sanitized, not traversed
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn require_admin_checks_role() {
        assert!(require_admin(&AuthUser(json!({"role":"admin"}))).is_ok());
        assert_eq!(status(require_admin(&AuthUser(json!({"role":"user"})))), StatusCode::FORBIDDEN);
    }
}
