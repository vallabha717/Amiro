//! What the chat composer's `/` and `@` menus need from the backend.
//!
//! - `POST /api/composer/command` runs one of the embedded runtime's own
//!   commands (jcode's `/compact`, `/context`, `/info`, `/memory`, …) for the
//!   chat's runtime session and returns its rendering. Never a model turn.
//! - `GET /api/composer/files` finds files for `@` under the chat's working
//!   folder: through the runtime's `find_files` once the chat has a session,
//!   and with the same walk (same skips, same case-insensitive path match)
//!   for a new chat that has none yet.

use std::path::{Path, PathBuf};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use amiro_sdk::RuntimeCommand;

use crate::runtime;
use crate::state::{ApiError, AppState, AuthUser};
use crate::threads;

/// One `/` command the composer offers, backed by the runtime.
struct Command {
    name: &'static str,
    /// `true`: about this conversation, so it needs the chat's own session.
    session: bool,
    action: Action,
}

#[derive(Clone, Copy)]
enum Action {
    Compact,
    Run(RuntimeCommand),
}

/// The runtime commands that work from a chat without a model turn. Commands
/// that need the terminal (editors, auth, server reloads) or a developer
/// repository (`/commit`, `/merge`) are left to jcode's own TUI.
const COMMANDS: &[Command] = &[
    Command { name: "compact", session: true, action: Action::Compact },
    Command { name: "context", session: true, action: Action::Run(RuntimeCommand::Context) },
    Command { name: "info", session: true, action: Action::Run(RuntimeCommand::Info) },
    Command { name: "cache", session: true, action: Action::Run(RuntimeCommand::Cache) },
    Command { name: "memory", session: false, action: Action::Run(RuntimeCommand::Memory) },
    Command { name: "skills", session: false, action: Action::Run(RuntimeCommand::Skills) },
    Command { name: "agents", session: false, action: Action::Run(RuntimeCommand::Agents) },
    Command { name: "swarm", session: true, action: Action::Run(RuntimeCommand::Swarm) },
    Command { name: "mcp", session: false, action: Action::Run(RuntimeCommand::McpStatus) },
    Command {
        name: "refresh-model-list",
        session: false,
        action: Action::Run(RuntimeCommand::RefreshModelList),
    },
];

/// Folders the runtime's own file walk skips.
const SKIPPED_DIRS: [&str; 4] = [".git", "node_modules", "target", ".next"];
const MAX_WALK_FILES: usize = 20_000;
const MAX_WALK_ENTRIES: usize = 50_000;
const MAX_RESULTS: u32 = 50;

fn uid_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

/// The runtime answers a refused command with its reason behind a wire code
/// (`invalid_request: Cannot compact: …`). That is an answer, not an outage:
/// show the reason alone, as a 400. Anything else (the runtime unreachable)
/// is passed through unchanged.
pub fn runtime_refusal(error: ApiError) -> ApiError {
    let message = error.1.trim();
    if let Some((code, reason)) = message.split_once(": ") {
        let is_code = !code.is_empty() && code.chars().all(|c| c.is_ascii_lowercase() || c == '_');
        if is_code && matches!(code, "invalid_request" | "session_busy" | "busy" | "unsupported") {
            return ApiError(StatusCode::BAD_REQUEST, reason.trim().to_string());
        }
    }
    error
}

/// The chat's thread record, if it exists and belongs to the caller.
async fn owned_thread(state: &AppState, uid: &str, thread_id: Option<&str>) -> Result<Option<Value>, ApiError> {
    let Some(id) = thread_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    Ok(threads::get_entry(state, id)
        .await?
        .filter(|entry| threads::entry_owned(entry, uid)))
}

/// The runtime a chat runs on: a team agent's own, or the main one.
async fn chat_state(state: &AppState, thread: Option<&Value>) -> Result<AppState, ApiError> {
    match thread.and_then(|t| t.get("agentId")).and_then(Value::as_str) {
        Some(agent) if !agent.is_empty() => crate::routes::agents::scoped_state(state, agent).await,
        _ => Ok(state.clone()),
    }
}

fn session_of(thread: Option<&Value>) -> Option<String> {
    thread
        .and_then(|t| t.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandBody {
    command: String,
    thread_id: Option<String>,
}

/// POST /api/composer/command
async fn run_command(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CommandBody>,
) -> Result<Json<Value>, ApiError> {
    let name = body.command.trim().trim_start_matches('/').to_ascii_lowercase();
    let command = COMMANDS
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| bad_request(format!("/{name} is not a command Amiro can run from chat")))?;
    let uid = uid_of(&user);
    let thread = owned_thread(&state, &uid, body.thread_id.as_deref()).await?;
    let runtime_state = chat_state(&state, thread.as_ref()).await?;
    let session = session_of(thread.as_ref());

    let (message, data) = match (command.action, session) {
        (Action::Compact, Some(session)) => (
            runtime::compact(&runtime_state, &session).await.map_err(runtime_refusal)?,
            Value::Null,
        ),
        (Action::Run(cmd), Some(session)) => runtime::run_command(&runtime_state, &session, cmd)
            .await
            .map_err(runtime_refusal)?,
        (_, None) if command.session => {
            return Err(bad_request(format!(
                "/{name} is about this conversation, and it has not started yet. Send a message first."
            )));
        }
        (Action::Run(cmd), None) => runtime::run_command_any(&runtime_state, cmd)
            .await
            .map_err(runtime_refusal)?
            .ok_or_else(|| {
                bad_request(format!(
                    "No conversation is free to answer /{name} right now. Send a message first, or try again when the agent is idle."
                ))
            })?,
        (Action::Compact, None) => unreachable!("compact is a session command"),
    };
    Ok(Json(json!({ "command": name, "message": message, "data": data })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesQuery {
    q: Option<String>,
    thread_id: Option<String>,
    project_directory: Option<String>,
    limit: Option<u32>,
}

/// The folder `@` searches: the chat's own working folder when it has one,
/// else the folder picked in the composer, else the workspace.
async fn files_root(
    state: &AppState,
    thread: Option<&Value>,
    project_directory: Option<&str>,
) -> Result<PathBuf, ApiError> {
    if let Some(agent) = thread.and_then(|t| t.get("agentId")).and_then(Value::as_str).filter(|a| !a.is_empty()) {
        if let Some(dir) = crate::routes::agents::working_dir_for(state, agent).await? {
            return Ok(dir);
        }
    }
    if let Some(dir) = project_directory.map(str::trim).filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(crate::chat::validate_working_dir(dir)?));
    }
    if let Some(dir) = thread.and_then(|t| t.get("workingDir")).and_then(Value::as_str).filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    Ok(state.workspace.clone())
}

/// The runtime's walk (`walk_files` in the harness API server): sorted,
/// bounded, skipping VCS and build folders and never following symlinks.
fn walk_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut scanned = 0usize;
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            scanned += 1;
            if scanned > MAX_WALK_ENTRIES {
                return files;
            }
            let name = entry.file_name();
            if SKIPPED_DIRS.iter().any(|skip| name.to_str() == Some(skip)) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                if let Ok(relative) = entry.path().strip_prefix(root) {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
                if files.len() >= MAX_WALK_FILES {
                    return files;
                }
            }
        }
    }
    files
}

/// Best matches first: a file name that starts with the query, then one that
/// contains it, then any path that contains it; shorter paths break ties.
pub fn rank_files(paths: Vec<String>, query: &str, limit: usize) -> Vec<String> {
    let needle = query.trim().to_ascii_lowercase();
    let mut scored: Vec<(u8, String)> = paths
        .into_iter()
        .filter_map(|path| {
            let lower = path.to_ascii_lowercase();
            let name = lower.rsplit('/').next().unwrap_or(&lower).to_string();
            let score = if needle.is_empty() || name.starts_with(&needle) {
                0
            } else if name.contains(&needle) {
                1
            } else if lower.contains(&needle) {
                2
            } else {
                return None;
            };
            Some((score, path))
        })
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.len().cmp(&b.1.len())).then(a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, p)| p).collect()
}

/// GET /api/composer/files?q=&threadId=&projectDirectory=&limit=
async fn find_files(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<FilesQuery>,
) -> Result<Json<Value>, ApiError> {
    let uid = uid_of(&user);
    let q = query.q.unwrap_or_default();
    let limit = query.limit.unwrap_or(20).clamp(1, MAX_RESULTS) as usize;
    let thread = owned_thread(&state, &uid, query.thread_id.as_deref()).await?;
    let root = files_root(&state, thread.as_ref(), query.project_directory.as_deref()).await?;

    // Through the runtime when the chat has a session in this folder.
    let runtime_state = chat_state(&state, thread.as_ref()).await?;
    let same_folder = query.project_directory.as_deref().map(str::trim).filter(|d| !d.is_empty()).is_none();
    if let (Some(session), true) = (session_of(thread.as_ref()), same_folder) {
        if let Ok(paths) = runtime::find_files(&runtime_state, &session, &q, MAX_WALK_FILES as u32).await {
            return Ok(Json(json!({
                "root": root.to_string_lossy(),
                "files": rank_files(paths, &q, limit),
                "source": "runtime",
            })));
        }
    }
    let walk_root = root.clone();
    let paths = tokio::task::spawn_blocking(move || walk_files(&walk_root))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("file search failed: {e}")))?;
    Ok(Json(json!({
        "root": root.to_string_lossy(),
        "files": rank_files(paths, &q, limit),
        "source": "walk",
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/composer/command", post(run_command))
        .route("/api/composer/files", get(find_files))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_rank_before_paths() {
        let paths = vec![
            "docs/readme-old/notes.md".to_string(),
            "src/readme.ts".to_string(),
            "README.md".to_string(),
            "lib/my-readme.txt".to_string(),
        ];
        assert_eq!(
            rank_files(paths, "readme", 10),
            ["README.md", "src/readme.ts", "lib/my-readme.txt", "docs/readme-old/notes.md"]
        );
    }

    #[test]
    fn an_empty_query_lists_short_paths_first_and_respects_the_limit() {
        let paths = vec!["a/b/c.txt".to_string(), "z.txt".to_string(), "m/n.txt".to_string()];
        assert_eq!(rank_files(paths, "", 2), ["z.txt", "m/n.txt"]);
    }

    #[test]
    fn the_walk_skips_vcs_and_build_folders() {
        let root = std::env::temp_dir().join(format!("amiro-composer-walk-{}", uuid::Uuid::new_v4()));
        for dir in ["src", ".git", "node_modules/pkg", "target/debug"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in ["src/main.rs", ".git/HEAD", "node_modules/pkg/i.js", "target/debug/x", "Cargo.toml"] {
            std::fs::write(root.join(file), "x").unwrap();
        }
        let mut files = walk_files(&root);
        files.sort();
        assert_eq!(files, ["Cargo.toml", "src/main.rs"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_runtime_refusal_reads_as_its_reason() {
        let refused = runtime_refusal(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_request: Cannot compact: not enough messages".into(),
        ));
        assert_eq!(refused.0, StatusCode::BAD_REQUEST);
        assert_eq!(refused.1, "Cannot compact: not enough messages");
        let outage = runtime_refusal(ApiError(StatusCode::SERVICE_UNAVAILABLE, "socket closed".into()));
        assert_eq!(outage.0, StatusCode::SERVICE_UNAVAILABLE);
        let prose = runtime_refusal(ApiError(StatusCode::SERVICE_UNAVAILABLE, "Note: try later".into()));
        assert_eq!(prose.1, "Note: try later");
    }

    #[test]
    fn every_command_is_unique() {
        let mut names: Vec<_> = COMMANDS.iter().map(|c| c.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), COMMANDS.len());
    }
}
