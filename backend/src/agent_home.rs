//! The agent's home: the owner's workspace root.
//!
//! The runtime loads `$AMIRO_AGENT_HOME/{IDENTITY,SOUL,USER,NOW,BOOTSTRAP}.md`
//! into the system prompt every turn. Ownership of those files:
//!
//! - `IDENTITY.md` is generated from the Personality page (see `agent.rs`).
//! - `SOUL.md`, `USER.md`, `NOW.md`, `HEARTBEAT.md` are seeded once from the
//!   templates in `agent-home/` and are then owned by the agent and the user.
//!   Seeding never overwrites an existing file.
//! - `BOOTSTRAP.md` is seeded once, on a genuinely fresh install only.
//!
//! Small durable state (bootstrap flag, heartbeat settings) lives in
//! `~/.amiro/store/agent-home.json`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::state::{read_json, write_json, ApiError, AppState};

pub const SOUL_TEMPLATE: &str = include_str!("../../agent-home/SOUL.md");
pub const USER_TEMPLATE: &str = include_str!("../../agent-home/USER.md");
pub const NOW_TEMPLATE: &str = include_str!("../../agent-home/NOW.md");
pub const HEARTBEAT_TEMPLATE: &str = include_str!("../../agent-home/HEARTBEAT.md");
pub const BOOTSTRAP_TEMPLATE: &str = include_str!("../../agent-home/BOOTSTRAP.md");

pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

/// Serializes read-modify-write of `agent-home.json`. Separate from
/// `AppState::store` so heartbeat/seeding never nest inside the thread store lock.
pub fn file_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub fn state_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("agent-home.json")
}

/// Read the state file (caller holds [`file_lock`] for read-modify-write).
pub async fn load_state(state: &AppState) -> Result<Value, ApiError> {
    let doc = read_json(&state_path(state), json!({})).await?;
    Ok(if doc.is_object() { doc } else { json!({}) })
}

pub async fn save_state(state: &AppState, doc: &Value) -> Result<(), ApiError> {
    write_json(&state_path(state), doc).await
}

/// Strip lines beginning with `_ ` (comments for the agent, never prompted).
pub fn strip_comment_lines(text: &str) -> String {
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| !(line.starts_with("_ ") || line.trim_end() == "_"))
        .collect();
    kept.join("\n").trim().to_string()
}

pub fn fill_placeholders(template: &str, name: &str, email: &str, timezone: &str) -> String {
    template
        .replace("{{user_name}}", name)
        .replace("{{user_email}}", email)
        .replace("{{user_timezone}}", timezone)
}

/// The single owner: first admin, else first user.
pub async fn owner_user(state: &AppState) -> Option<Value> {
    let doc = read_json(&state.home.join("users.json"), json!({"users": []}))
        .await
        .ok()?;
    let users = doc.get("users")?.as_array()?;
    users
        .iter()
        .find(|u| u.get("role").and_then(Value::as_str) == Some("admin"))
        .or_else(|| users.first())
        .cloned()
}

pub fn owner_display_name(owner: &Value) -> String {
    let name = owner.get("name").and_then(Value::as_str).unwrap_or("").trim();
    if !name.is_empty() {
        return name.to_string();
    }
    let email = owner.get("email").and_then(Value::as_str).unwrap_or("");
    email.split('@').next().unwrap_or("").trim().to_string()
}

/// Owner timezone: user preference if present, else heartbeat settings, else UTC.
pub async fn owner_timezone(state: &AppState, owner: Option<&Value>, doc: &Value) -> String {
    let valid = |s: &str| s.parse::<chrono_tz::Tz>().is_ok();
    if let Some(uid) = owner.and_then(|o| o.get("id")).and_then(Value::as_str) {
        let prefs = read_json(
            &state.home.join("store").join("user-preferences.json"),
            json!({}),
        )
        .await
        .unwrap_or(json!({}));
        for key in ["timezone", "timeZone"] {
            if let Some(tz) = prefs.get(uid).and_then(|p| p.get(key)).and_then(Value::as_str) {
                if valid(tz) {
                    return tz.to_string();
                }
            }
        }
    }
    if let Some(tz) = doc
        .get("heartbeat")
        .and_then(|h| h.get("timezone"))
        .and_then(Value::as_str)
    {
        if valid(tz) {
            return tz.to_string();
        }
    }
    "UTC".to_string()
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SeedReport {
    pub written: Vec<String>,
    pub bootstrap_seeded: bool,
}

fn exists_no_follow(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Write `content` only if nothing (not even a dangling symlink) is there.
fn write_new(path: &Path, content: &str) -> bool {
    use std::io::Write;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file.write_all(content.as_bytes()).is_ok(),
        Err(_) => false,
    }
}

/// Pure-filesystem seeding. `allow_bootstrap` is true only when BOOTSTRAP.md has
/// never been seeded and the owner has no threads.
pub fn seed_files(
    workspace: &Path,
    name: &str,
    email: &str,
    timezone: &str,
    allow_bootstrap: bool,
) -> SeedReport {
    let mut report = SeedReport::default();
    let _ = std::fs::create_dir_all(workspace);
    let _ = std::fs::create_dir_all(workspace.join("journal"));
    let templates = [
        ("SOUL.md", SOUL_TEMPLATE),
        ("USER.md", USER_TEMPLATE),
        ("NOW.md", NOW_TEMPLATE),
        ("HEARTBEAT.md", HEARTBEAT_TEMPLATE),
    ];
    let pre_existing = ["SOUL.md", "USER.md", "NOW.md"]
        .iter()
        .any(|file| exists_no_follow(&workspace.join(file)));
    for (file, template) in templates {
        let path = workspace.join(file);
        if exists_no_follow(&path) {
            continue;
        }
        if write_new(&path, &fill_placeholders(template, name, email, timezone)) {
            report.written.push(file.to_string());
        }
    }
    if allow_bootstrap && !pre_existing {
        let path = workspace.join("BOOTSTRAP.md");
        if !exists_no_follow(&path)
            && write_new(&path, &fill_placeholders(BOOTSTRAP_TEMPLATE, name, email, timezone))
        {
            report.written.push("BOOTSTRAP.md".to_string());
            report.bootstrap_seeded = true;
        }
    }
    report
}

async fn owner_has_threads(state: &AppState, owner_id: &str) -> bool {
    let doc = crate::threads::read_threads(state).await.unwrap_or(json!({}));
    doc.as_object()
        .map(|map| {
            map.values()
                .any(|entry| crate::threads::entry_owned(entry, owner_id))
        })
        .unwrap_or(false)
}

/// Seed the owner's agent home. Best-effort: never panics; logs failures.
pub async fn seed(state: &AppState) {
    if let Err(error) = seed_inner(state).await {
        tracing::warn!(error = %error.1, "agent home seeding failed");
    }
}

async fn seed_inner(state: &AppState) -> Result<SeedReport, ApiError> {
    let _guard = file_lock().lock().await;
    let mut doc = load_state(state).await?;
    let owner = owner_user(state).await;
    if owner.is_none() {
        // Nobody to greet yet; seed once owner setup completes.
        return Ok(SeedReport::default());
    }
    let name = owner.as_ref().map(owner_display_name).unwrap_or_default();
    let email = owner
        .as_ref()
        .and_then(|o| o.get("email"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let timezone = owner_timezone(state, owner.as_ref(), &doc).await;
    let already = doc.get("bootstrapSeeded").and_then(Value::as_bool).unwrap_or(false);
    let has_threads = match owner.as_ref().and_then(|o| o.get("id")).and_then(Value::as_str) {
        Some(id) => owner_has_threads(state, id).await,
        None => false,
    };
    // Without an owner there is nobody to greet; wait for setup to finish.
    let allow_bootstrap = owner.is_some() && !already && !has_threads;
    let ws = state.workspace.clone();
    let (n, e, t) = (name.clone(), email.clone(), timezone.clone());
    let report = tokio::task::spawn_blocking(move || seed_files(&ws, &n, &e, &t, allow_bootstrap))
        .await
        .map_err(|e| ApiError(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // Record the flag as soon as the decision is made so deleting the file is
    // never undone: either we seeded it, or this install is no longer fresh.
    let should_flag = report.bootstrap_seeded || (owner.is_some() && (has_threads || {
        // Existing agent-owned files mean this is not a fresh install.
        ["SOUL.md", "USER.md", "NOW.md"].iter().any(|f| {
            !report.written.iter().any(|w| w == f) && exists_no_follow(&state.workspace.join(f))
        })
    }));
    if should_flag && !already {
        doc["bootstrapSeeded"] = json!(true);
        save_state(state, &doc).await?;
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// Attachments saved into the agent home
// ---------------------------------------------------------------------------

/// A filesystem-safe base name: no separators, controls, or leading dots.
pub fn safe_attachment_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_string();
    let cleaned: String = cleaned.chars().take(100).collect();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

/// `<date>-<name>`, or `<date>-<stem>-2.<ext>`, `-3`, ... until unused.
pub fn dedupe_attachment_name(dir: &Path, date: &str, name: &str) -> String {
    let first = format!("{date}-{name}");
    if !exists_no_follow(&dir.join(&first)) {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 2..10_000 {
        let candidate = format!("{date}-{stem}-{n}{ext}");
        if !exists_no_follow(&dir.join(&candidate)) {
            return candidate;
        }
    }
    format!("{date}-{}-{stem}{ext}", uuid::Uuid::new_v4())
}

/// Save bytes under `workspace/attachments/`. Returns the workspace-relative
/// path. Skips oversize content; refuses a symlinked `attachments` dir.
pub fn save_attachment_bytes(
    workspace: &Path,
    raw_name: &str,
    bytes: &[u8],
    date: &str,
) -> Option<String> {
    use std::io::Write;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        tracing::info!(name = raw_name, "attachment over 25 MB; not copied to agent home");
        return None;
    }
    let dir = workspace.join("attachments");
    match std::fs::symlink_metadata(&dir) {
        Ok(md) if md.file_type().is_symlink() || !md.is_dir() => return None,
        Ok(_) => {}
        Err(_) => std::fs::create_dir_all(&dir).ok()?,
    }
    let name = safe_attachment_name(raw_name);
    for _ in 0..8 {
        let unique = dedupe_attachment_name(&dir, date, &name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(&unique))
        {
            Ok(mut file) => {
                file.write_all(bytes).ok()?;
                return Some(format!("attachments/{unique}"));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return None,
        }
    }
    None
}

fn storage_token(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let token = path.rsplit_once("/storage/")?.1;
    crate::routes::storage::is_valid_token(token).then(|| token.to_string())
}

/// Best-effort: copy chat file attachments (inline data URLs and uploaded
/// `/storage/<token>` files) into the agent home. Returns saved relative paths.
pub async fn save_chat_attachments(state: &AppState, attachments: Option<&Value>) -> Vec<String> {
    use base64::Engine;
    let mut saved = Vec::new();
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    for attachment in attachments.and_then(Value::as_array).into_iter().flatten() {
        if attachment.get("type").and_then(Value::as_str).unwrap_or("file") != "file" {
            continue;
        }
        let Some(url) = attachment.get("url").and_then(Value::as_str) else { continue };
        let name = attachment
            .get("filename")
            .or_else(|| attachment.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("file")
            .to_string();
        let bytes: Option<Vec<u8>> = if let Some(rest) = url.strip_prefix("data:") {
            rest.split_once(";base64,").and_then(|(_, data)| {
                if data.len() as u64 > MAX_ATTACHMENT_BYTES * 4 / 3 + 8 {
                    return None;
                }
                base64::engine::general_purpose::STANDARD.decode(data).ok()
            })
        } else if let Some(token) = storage_token(url) {
            let path = state.home.join("storage").join(token);
            match tokio::fs::symlink_metadata(&path).await {
                Ok(md) if md.is_file() && md.len() <= MAX_ATTACHMENT_BYTES => {
                    tokio::fs::read(&path).await.ok()
                }
                _ => None,
            }
        } else {
            None
        };
        let Some(bytes) = bytes else { continue };
        let workspace = state.workspace.clone();
        let date = date.clone();
        let result = tokio::task::spawn_blocking(move || {
            save_attachment_bytes(&workspace, &name, &bytes, &date)
        })
        .await;
        match result {
            Ok(Some(path)) => saved.push(path),
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "attachment copy task failed"),
        }
    }
    saved
}

pub fn attachment_reminder(saved: &[String]) -> Option<String> {
    if saved.is_empty() {
        return None;
    }
    Some(
        saved
            .iter()
            .map(|p| format!("The user's attachment is also saved at {p}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("amiro-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn seeding_fills_placeholders_and_never_overwrites() {
        let ws = tmp();
        let report = seed_files(&ws, "Ada", "ada@example.com", "Europe/London", false);
        assert_eq!(report.written.len(), 4);
        let user = std::fs::read_to_string(ws.join("USER.md")).unwrap();
        assert!(user.contains("**Name:** Ada"));
        assert!(user.contains("ada@example.com"));
        assert!(user.contains("Europe/London"));
        assert!(!user.contains("{{"));
        assert!(ws.join("journal").is_dir());
        assert!(!ws.join("notes").exists() && !ws.join("attachments").exists());

        std::fs::write(ws.join("SOUL.md"), "mine").unwrap();
        let again = seed_files(&ws, "Bob", "b@x.y", "UTC", true);
        assert!(again.written.is_empty());
        assert_eq!(std::fs::read_to_string(ws.join("SOUL.md")).unwrap(), "mine");
        assert!(user.contains("Ada"));
        assert!(std::fs::read_to_string(ws.join("USER.md")).unwrap().contains("Ada"));
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn bootstrap_only_on_fresh_install() {
        let ws = tmp();
        let report = seed_files(&ws, "Ada", "a@x.y", "UTC", true);
        assert!(report.bootstrap_seeded);
        assert!(std::fs::read_to_string(ws.join("BOOTSTRAP.md")).unwrap().contains("Greet Ada"));
        let _ = std::fs::remove_dir_all(ws);

        // Existing agent files: not fresh.
        let ws = tmp();
        std::fs::write(ws.join("NOW.md"), "x").unwrap();
        let report = seed_files(&ws, "Ada", "a@x.y", "UTC", true);
        assert!(!report.bootstrap_seeded);
        assert!(!ws.join("BOOTSTRAP.md").exists());
        let _ = std::fs::remove_dir_all(ws);

        // Threads exist / already seeded: caller passes false.
        let ws = tmp();
        assert!(!seed_files(&ws, "Ada", "a@x.y", "UTC", false).bootstrap_seeded);
        assert!(!ws.join("BOOTSTRAP.md").exists());
        let _ = std::fs::remove_dir_all(ws);
    }

    fn test_state(root: &Path) -> AppState {
        AppState {
            home: root.join("home"),
            workspace: root.join("home/workspace"),
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("run/amiro-api.sock"),
            runtime_bin: root.join("amiro-runtime"),
            token: String::new(),
            store: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    #[tokio::test]
    async fn bootstrap_is_recorded_and_not_reseeded_after_delete() {
        let root = tmp();
        let state = test_state(&root);
        std::fs::create_dir_all(&state.home).unwrap();
        std::fs::write(
            state.home.join("users.json"),
            json!({"users":[{"id":"u1","role":"admin","name":"","email":"grace@example.com"}]}).to_string(),
        )
        .unwrap();
        seed(&state).await;
        assert!(state.workspace.join("BOOTSTRAP.md").exists());
        assert!(std::fs::read_to_string(state.workspace.join("USER.md"))
            .unwrap()
            .contains("**Name:** grace"));
        let doc = load_state(&state).await.unwrap();
        assert_eq!(doc["bootstrapSeeded"], true);
        std::fs::remove_file(state.workspace.join("BOOTSTRAP.md")).unwrap();
        seed(&state).await;
        assert!(!state.workspace.join("BOOTSTRAP.md").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn no_bootstrap_when_owner_has_threads() {
        let root = tmp();
        let state = test_state(&root);
        std::fs::create_dir_all(&state.home).unwrap();
        std::fs::write(
            state.home.join("users.json"),
            json!({"users":[{"id":"u1","role":"admin","name":"Ada","email":"a@x.y"}]}).to_string(),
        )
        .unwrap();
        std::fs::write(
            state.home.join("threads.json"),
            json!({"t1":{"userId":"u1","sessionId":"s"}}).to_string(),
        )
        .unwrap();
        seed(&state).await;
        assert!(state.workspace.join("SOUL.md").exists());
        assert!(!state.workspace.join("BOOTSTRAP.md").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn comment_lines_are_stripped() {
        let out = strip_comment_lines("_ note\n# Title\n\n- [ ] item\n_ another\n");
        assert_eq!(out, "# Title\n\n- [ ] item");
    }

    #[test]
    fn attachment_names_are_safe_and_deduped() {
        assert_eq!(safe_attachment_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_attachment_name(".hidden"), "hidden");
        assert_eq!(safe_attachment_name("a:b?.txt"), "a_b_.txt");
        assert_eq!(safe_attachment_name(""), "file");
        let ws = tmp();
        let a = save_attachment_bytes(&ws, "report.pdf", b"1", "2026-01-02").unwrap();
        let b = save_attachment_bytes(&ws, "report.pdf", b"2", "2026-01-02").unwrap();
        let c = save_attachment_bytes(&ws, "report.pdf", b"3", "2026-01-02").unwrap();
        assert_eq!(a, "attachments/2026-01-02-report.pdf");
        assert_eq!(b, "attachments/2026-01-02-report-2.pdf");
        assert_eq!(c, "attachments/2026-01-02-report-3.pdf");
        assert_eq!(std::fs::read(ws.join(&a)).unwrap(), b"1");
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn symlinked_attachments_dir_is_refused() {
        let ws = tmp();
        let outside = tmp();
        std::os::unix::fs::symlink(&outside, ws.join("attachments")).unwrap();
        assert!(save_attachment_bytes(&ws, "x.txt", b"x", "2026-01-02").is_none());
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(ws);
        let _ = std::fs::remove_dir_all(outside);
    }
}
