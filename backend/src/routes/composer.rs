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
    let message = readable(&name, &message, &data);
    Ok(Json(json!({ "command": name, "message": message, "data": data })))
}

// ---------------------------------------------------------------------------
// Readable answers. Most runtime commands answer with structured data and a
// "rendering" that is the same data as pretty JSON (jcode's TUI draws its own
// views from the data). The composer shows a short summary instead; the full
// data still travels in `data`.
// ---------------------------------------------------------------------------

fn num(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().map(|f| f as u64))
}

/// 1048576 → "1,048,576".
fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn tokens(value: &Value) -> Option<String> {
    num(value).map(|n| format!("{} tokens", thousands(n)))
}

fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Bool(b) => Some(if *b { "on" } else { "off" }.to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn lines(rows: Vec<(&str, Option<String>)>) -> String {
    rows.into_iter()
        .filter_map(|(label, value)| value.map(|v| format!("{label}: {v}")))
        .collect::<Vec<_>>()
        .join("\n")
}

fn count(value: &Value) -> Option<String> {
    value.as_array().map(|a| a.len().to_string())
}

/// Top-level scalars as `key: value`, collections as their size.
fn generic(data: &Value) -> Option<String> {
    let object = data.as_object()?;
    let rows: Vec<String> = object
        .iter()
        .filter_map(|(key, value)| {
            let label = key.replace('_', " ");
            match value {
                Value::Array(items) => Some(format!("{label}: {} item(s)", items.len())),
                Value::Object(map) if map.is_empty() => None,
                Value::Object(map) => Some(format!("{label}: {} field(s)", map.len())),
                other => text_of(other).map(|v| format!("{label}: {v}")),
            }
        })
        .collect();
    (!rows.is_empty()).then(|| rows.join("\n"))
}

/// What the composer shows for one command's answer.
pub fn readable(command: &str, message: &str, data: &Value) -> String {
    let is_json_dump = serde_json::from_str::<Value>(message.trim())
        .map(|v| v.is_object() || v.is_array())
        .unwrap_or(false);
    if !is_json_dump && !message.trim().is_empty() {
        return message.to_string();
    }
    let summary = match command {
        "context" => {
            let prompt_chars = ["static", "dynamic"]
                .iter()
                .filter_map(|k| data["system_prompt"][k].as_str())
                .map(str::len)
                .sum::<usize>();
            Some(lines(vec![
                ("Context window", tokens(&data["context_window"])),
                ("Messages in context", count(&data["messages"])),
                ("Tools offered", count(&data["current_tools"]).or_else(|| count(&data["locked_tool_names"]))),
                ("Tools locked for this session", text_of(&data["tools_locked"])),
                (
                    "System prompt",
                    (prompt_chars > 0).then(|| format!("about {} tokens", thousands((prompt_chars / 4) as u64))),
                ),
                ("Working folder", text_of(&data["working_dir"])),
            ]))
        }
        "info" => Some(lines(vec![
            ("Provider", text_of(&data["provider"])),
            ("Model", text_of(&data["model"])),
            ("Reasoning effort", text_of(&data["reasoning_effort"])),
            ("Context window", tokens(&data["context_window"])),
            ("Last turn in", tokens(&data["last_usage"]["input_tokens"])),
            ("Last turn out", tokens(&data["last_usage"]["output_tokens"])),
            ("Session total in", tokens(&data["token_usage_totals"]["input_tokens"])),
            ("Session total out", tokens(&data["token_usage_totals"]["output_tokens"])),
            ("Memory", text_of(&data["memory_enabled"])),
            ("Swarm", text_of(&data["swarm_enabled"])),
            ("Working folder", text_of(&data["working_dir"])),
        ])),
        "cache" => Some(lines(vec![
            ("Provider", text_of(&data["provider"])),
            ("Anthropic cache lifetime", text_of(&data["anthropic_cache_ttl"])),
            ("Last turn read from cache", tokens(&data["last_usage"]["cache_read_input_tokens"])),
            ("Last turn written to cache", tokens(&data["last_usage"]["cache_creation_input_tokens"])),
            ("Session read from cache", tokens(&data["token_usage_totals"]["cache_read_input_tokens"])),
            ("Session written to cache", tokens(&data["token_usage_totals"]["cache_creation_input_tokens"])),
        ])),
        "mcp" => data["servers"].as_array().map(|servers| {
            if servers.is_empty() {
                return "No MCP servers are configured.".to_string();
            }
            servers
                .iter()
                .map(|server| {
                    let name = server["name"].as_str().unwrap_or("?");
                    let tools = count(&server["tools"])
                        .or_else(|| num(&server["tools"]).map(|n| n.to_string()))
                        .unwrap_or_else(|| "0".into());
                    if server["connected"].as_bool().unwrap_or(false) {
                        format!("{name}: connected, {tools} tool(s)")
                    } else {
                        let why = server["error"].as_str().unwrap_or("not connected");
                        format!("{name}: {why}")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        "swarm" => {
            let members = data["members"].as_array().cloned().unwrap_or_default();
            let mut out = lines(vec![("Swarm", text_of(&data["enabled"])), ("Agents", Some(members.len().to_string()))]);
            for member in members {
                let name = text_of(&member["name"]).or_else(|| text_of(&member["session_id"])).unwrap_or_default();
                let status = text_of(&member["status"]).unwrap_or_default();
                out.push_str(&format!("\n- {name} {status}"));
            }
            Some(out)
        }
        "agents" => {
            let mut rows = vec![format!("Scope: {}", data["scope"].as_str().unwrap_or("session"))];
            for role in ["swarm", "memory", "review", "judge", "ambient"] {
                let model = text_of(&data["overrides"][role])
                    .map(|m| format!("{m} (this session)"))
                    .or_else(|| text_of(&data["defaults"][role]))
                    .unwrap_or_else(|| "same as the chat model".into());
                rows.push(format!("{role}: {model}"));
            }
            Some(rows.join("\n"))
        }
        _ => None,
    };
    summary
        .filter(|s| !s.trim().is_empty())
        .or_else(|| generic(data))
        .unwrap_or_else(|| message.to_string())
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
/// Returns files and the folders met on the way, relative to `root`.
fn walk(root: &Path) -> (Vec<String>, Vec<String>) {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut scanned = 0usize;
    let relative = |path: &Path| {
        path.strip_prefix(root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .filter(|p| !p.is_empty())
    };
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            scanned += 1;
            if scanned > MAX_WALK_ENTRIES {
                return (files, dirs);
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
                dirs.extend(relative(&entry.path()));
                pending.push(entry.path());
            } else if kind.is_file() {
                files.extend(relative(&entry.path()));
                if files.len() >= MAX_WALK_FILES {
                    return (files, dirs);
                }
            }
        }
    }
    (files, dirs)
}

/// What `@` can insert: a file, or a folder.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum EntryKind {
    Folder,
    File,
}

/// Best matches first: a name that starts with the query, then one that
/// contains it, then any path that contains it. At the same rank folders come
/// before files, then shorter paths. Folders are the ones given plus every
/// parent of a file, so the runtime's file-only search still yields folders.
pub fn rank_entries(
    files: Vec<String>,
    dirs: Vec<String>,
    query: &str,
    limit: usize,
) -> Vec<(String, EntryKind)> {
    let needle = query.trim().to_ascii_lowercase();
    let mut folders: std::collections::BTreeSet<String> = dirs.into_iter().collect();
    for file in &files {
        let mut path = file.as_str();
        while let Some((parent, _)) = path.rsplit_once('/') {
            folders.insert(parent.to_string());
            path = parent;
        }
    }
    let score = |path: &str| -> Option<u8> {
        let lower = path.to_ascii_lowercase();
        let name = lower.rsplit('/').next().unwrap_or(&lower);
        if needle.is_empty() || name.starts_with(&needle) {
            Some(0)
        } else if name.contains(&needle) {
            Some(1)
        } else if lower.contains(&needle) {
            Some(2)
        } else {
            None
        }
    };
    let mut scored: Vec<(u8, EntryKind, String)> = folders
        .into_iter()
        .filter_map(|p| score(&p).map(|s| (s, EntryKind::Folder, p)))
        .chain(files.into_iter().filter_map(|p| score(&p).map(|s| (s, EntryKind::File, p))))
        .collect();
    scored.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.len().cmp(&b.2.len()))
            .then(a.2.cmp(&b.2))
    });
    scored.into_iter().take(limit).map(|(_, kind, path)| (path, kind)).collect()
}

fn entries_json(entries: Vec<(String, EntryKind)>) -> Value {
    Value::Array(
        entries
            .into_iter()
            .map(|(path, kind)| {
                json!({
                    "path": path,
                    "kind": if kind == EntryKind::Folder { "folder" } else { "file" },
                })
            })
            .collect(),
    )
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
                "entries": entries_json(rank_entries(paths, Vec::new(), &q, limit)),
                "source": "runtime",
            })));
        }
    }
    let walk_root = root.clone();
    let (files, dirs) = tokio::task::spawn_blocking(move || walk(&walk_root))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("file search failed: {e}")))?;
    Ok(Json(json!({
        "root": root.to_string_lossy(),
        "entries": entries_json(rank_entries(files, dirs, &q, limit)),
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

    fn paths(entries: &[(String, EntryKind)]) -> Vec<&str> {
        entries.iter().map(|(p, _)| p.as_str()).collect()
    }

    #[test]
    fn names_rank_before_paths_and_folders_before_files() {
        let files = vec![
            "docs/readme-old/notes.md".to_string(),
            "src/readme.ts".to_string(),
            "README.md".to_string(),
            "lib/my-readme.txt".to_string(),
        ];
        let ranked = rank_entries(files, Vec::new(), "readme", 10);
        assert_eq!(
            paths(&ranked),
            ["docs/readme-old", "README.md", "src/readme.ts", "lib/my-readme.txt", "docs/readme-old/notes.md"]
        );
        assert_eq!(ranked[0].1, EntryKind::Folder);
    }

    #[test]
    fn parents_of_files_are_folders_and_empty_folders_count_too() {
        let ranked = rank_entries(
            vec!["src/components/button.tsx".to_string()],
            vec!["empty-dir".to_string()],
            "",
            10,
        );
        assert_eq!(
            ranked,
            [
                ("src".to_string(), EntryKind::Folder),
                ("empty-dir".to_string(), EntryKind::Folder),
                ("src/components".to_string(), EntryKind::Folder),
                ("src/components/button.tsx".to_string(), EntryKind::File),
            ]
        );
        assert_eq!(rank_entries(vec!["a/b.txt".into()], Vec::new(), "", 1).len(), 1);
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
        let (mut files, dirs) = walk(&root);
        files.sort();
        assert_eq!(files, ["Cargo.toml", "src/main.rs"]);
        assert_eq!(dirs, ["src"]);
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
    fn json_answers_become_short_summaries() {
        let data = json!({
            "context_window": 1048576,
            "messages": [1, 2, 3],
            "current_tools": [{}, {}],
            "tools_locked": false,
            "system_prompt": {"static": "x".repeat(4000), "dynamic": ""},
            "working_dir": "/w",
        });
        let dump = serde_json::to_string_pretty(&data).unwrap();
        let text = readable("context", &dump, &data);
        assert!(text.contains("Context window: 1,048,576 tokens"), "{text}");
        assert!(text.contains("Messages in context: 3"));
        assert!(text.contains("Tools offered: 2"));
        assert!(text.contains("System prompt: about 1,000 tokens"));
        assert!(!text.contains('{'), "no JSON left: {text}");

        let mcp = json!({"servers": [
            {"name": "github", "connected": true, "tools": [{}, {}]},
            {"name": "jira", "connected": false, "error": "401 from server"},
        ]});
        let text = readable("mcp", &serde_json::to_string(&mcp).unwrap(), &mcp);
        assert_eq!(text, "github: connected, 2 tool(s)\njira: 401 from server");
    }

    #[test]
    fn text_answers_pass_through_and_unknown_data_gets_a_generic_view() {
        assert_eq!(readable("skills", "3 skills loaded", &json!({})), "3 skills loaded");
        let data = json!({"enabled": true, "pipeline_active": false, "activity": {"a": 1}});
        let text = readable("memory", &data.to_string(), &data);
        assert!(text.contains("enabled: on") && text.contains("pipeline active: off"), "{text}");
    }

    #[test]
    fn every_command_is_unique() {
        let mut names: Vec<_> = COMMANDS.iter().map(|c| c.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), COMMANDS.len());
    }
}
