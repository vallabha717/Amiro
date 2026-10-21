//! The agent team: the main agent plus agents the owner adds, each with its
//! own folder and one permanent channel thread per user.
//!
//! - The main agent (`id: "main"`) is the existing agent. Its name and look come
//!   from the Personality page identity; its folder is `state.workspace`.
//! - Every other agent lives in `~/.amiro/agents/<id>/`, outside the main
//!   workspace. The runtime loads its persona files from there because the
//!   backend sets `AMIRO_AGENTS_ROOT` (see `runtime.rs` and the runtime's
//!   `agent_home.rs`).
//! - A channel is an ordinary thread entry with `agentId` and `channel: true`,
//!   so the chat pipeline streams and replays it like any other thread.
//!
//! A folder per agent is not a security boundary: the runtime's tools run as
//! the Amiro user. See `docs/multi-agent-team/02-design.md`.
//!
//! - `GET    /api/agents`              main first, then by creation time
//! - `POST   /api/agents`              owner: create
//! - `GET    /api/agents/{id}`
//! - `PATCH  /api/agents/{id}`         owner: edit (not `main`)
//! - `DELETE /api/agents/{id}`         owner: delete (not `main`)
//! - `GET    /api/agents/{id}/threads` the caller's threads with that agent
//! - `GET    /api/agents/{id}/files`   read-only listing of its folder

use std::path::{Path, PathBuf};

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use crate::agent::{
    accent_palette, alpha_lower, build_identity_md, get_agent_identity, is_blocked_workspace_path,
    normalize_sliders, normalize_traits,
};
use crate::state::{now_iso, read_json, write_json, ApiError, AppState, AuthUser};
use crate::threads::{read_threads, write_threads};

/// The id of the agent that already existed before the team.
pub const MAIN_AGENT_ID: &str = "main";

const MAX_NAME_CHARS: usize = 32;
const MAX_ROLE_CHARS: usize = 80;
const MAX_INSTRUCTIONS_CHARS: usize = 4000;
const MAX_FILES: usize = 500;
const MAX_FILE_DEPTH: usize = 4;

/// Parent of the team agents' folders. Exported to the runtime as
/// `AMIRO_AGENTS_ROOT`.
pub fn agents_root(state: &AppState) -> PathBuf {
    state.home.join("agents")
}

fn registry_path(state: &AppState) -> PathBuf {
    state.home.join("store").join("agents.json")
}

/// Ids are server-generated 32-hex uuids; anything else never reaches a path.
fn valid_agent_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "agent not found".into())
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(Value::as_str) == Some("admin") {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::FORBIDDEN,
            "Only the owner can change the team.".into(),
        ))
    }
}

fn user_id(user: &AuthUser) -> String {
    user.0.get("id").and_then(Value::as_str).unwrap_or("").to_string()
}

async fn read_registry(state: &AppState) -> Result<Value, ApiError> {
    let mut doc = read_json(&registry_path(state), json!({})).await?;
    if !doc.is_object() {
        doc = json!({});
    }
    if !doc["agents"].is_array() {
        doc["agents"] = json!([]);
    }
    if !doc["channels"].is_object() {
        doc["channels"] = json!({});
    }
    Ok(doc)
}

fn find_record<'a>(registry: &'a Value, id: &str) -> Option<&'a Value> {
    registry["agents"]
        .as_array()?
        .iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(id))
}

/// Ids of every team agent other than main.
pub async fn team_agent_ids(state: &AppState) -> Vec<String> {
    let Ok(registry) = read_registry(state).await else {
        return Vec::new();
    };
    registry["agents"]
        .as_array()
        .map(|agents| {
            agents
                .iter()
                .filter_map(|a| a.get("id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The working folder for a chat with `agent_id`. `Ok(None)` for the main
/// agent (the caller keeps its usual folder); 404 for an unknown agent.
pub async fn working_dir_for(state: &AppState, agent_id: &str) -> Result<Option<PathBuf>, ApiError> {
    if agent_id.is_empty() || agent_id == MAIN_AGENT_ID {
        return Ok(None);
    }
    if !valid_agent_id(agent_id) {
        return Err(not_found());
    }
    let registry = read_registry(state).await?;
    if find_record(&registry, agent_id).is_none() {
        return Err(not_found());
    }
    let dir = agents_root(state).join(agent_id);
    tokio::fs::create_dir_all(&dir).await?;
    Ok(Some(dir))
}

fn clean_text(raw: Option<&Value>, max: usize) -> String {
    raw.and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(max)
        .collect()
}

/// Validated `{name, role, instructions, traits}` from a create/edit body.
/// `partial` keeps fields the body omits (PATCH).
fn agent_fields(body: &Value, existing: Option<&Value>) -> Result<Map<String, Value>, ApiError> {
    let mut out = Map::new();
    let pick = |key: &str| body.get(key).or_else(|| existing.and_then(|e| e.get(key)));
    let name_raw = pick("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if name_raw.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Give the agent a name.".into()));
    }
    if name_raw.chars().count() > MAX_NAME_CHARS {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("The name can be at most {MAX_NAME_CHARS} characters."),
        ));
    }
    out.insert("name".into(), json!(name_raw));
    out.insert("role".into(), json!(clean_text(pick("role"), MAX_ROLE_CHARS)));
    out.insert(
        "instructions".into(),
        json!(clean_text(pick("instructions"), MAX_INSTRUCTIONS_CHARS)),
    );
    out.insert(
        "traits".into(),
        normalize_traits(pick("traits").unwrap_or(&Value::Null)),
    );
    Ok(out)
}

fn handle_for(name: &str) -> String {
    let base = alpha_lower(name);
    if base.is_empty() {
        "@agent".into()
    } else {
        format!("@{}", base.chars().take(30).collect::<String>())
    }
}

/// `IDENTITY.md` for a team agent: the shared identity format plus its role
/// and the owner's instructions.
fn team_identity_md(record: &Value) -> String {
    let name = record["name"].as_str().unwrap_or("Agent");
    let role = record["role"].as_str().unwrap_or("");
    let instructions = record["instructions"].as_str().unwrap_or("").trim();
    let mut md = build_identity_md(
        name,
        &handle_for(name),
        if role.is_empty() { "A member of the owner's Amiro team" } else { role },
        "",
        &normalize_sliders(&Value::Null),
    )
    .replace(
        "Generated from the Personality page. Edit it there",
        "Generated from this agent's page in Team. Edit it there",
    );
    md.push_str(
        "\nYou are one agent on the owner's Amiro team. Your working folder is your own; \
         other agents have theirs. Stay in your folder unless the owner asks otherwise.\n",
    );
    if !instructions.is_empty() {
        md.push_str(&format!("\n## Role and instructions\n\n{instructions}\n"));
    }
    md
}

/// Write `IDENTITY.md` (always) and seed the other home files (once).
async fn write_home(state: &AppState, dir: &Path, record: &Value) -> Result<(), ApiError> {
    tokio::fs::create_dir_all(dir).await?;
    let identity_path = dir.join("IDENTITY.md");
    if let Ok(meta) = tokio::fs::symlink_metadata(&identity_path).await {
        if meta.file_type().is_symlink() {
            tokio::fs::remove_file(&identity_path).await?;
        }
    }
    tokio::fs::write(&identity_path, team_identity_md(record)).await?;

    let owner = crate::agent_home::owner_user(state).await;
    let name = owner
        .as_ref()
        .map(crate::agent_home::owner_display_name)
        .unwrap_or_default();
    let email = owner
        .as_ref()
        .and_then(|o| o.get("email"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let timezone = crate::agent_home::owner_timezone(state, owner.as_ref(), &json!({})).await;
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        crate::agent_home::seed_files(&dir, &name, &email, &timezone, false);
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(())
}

/// The caller's channel thread for `agent_id`, created when missing. Takes the
/// store lock; callers must not hold it.
async fn ensure_channel(
    state: &AppState,
    agent_id: &str,
    title: &str,
    working_dir: &Path,
    uid: &str,
) -> Result<String, ApiError> {
    if uid.is_empty() {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "sign in again".into()));
    }
    let _guard = state.store.lock().await;
    let mut registry = read_registry(state).await?;
    let mut threads = read_threads(state).await?;
    if !threads.is_object() {
        threads = json!({});
    }
    if let Some(existing) = registry["channels"][agent_id][uid].as_str() {
        let owned = threads
            .get(existing)
            .map(|entry| crate::threads::entry_owned(entry, uid))
            .unwrap_or(false);
        if owned {
            return Ok(existing.to_string());
        }
    }
    let thread_id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    threads[&thread_id] = json!({
        "userId": uid,
        "title": title,
        "titleSource": "manual",
        "createdAt": now,
        "lastMessageAt": now,
        "archived": false,
        "agentId": agent_id,
        "channel": true,
        "workingDir": working_dir.to_string_lossy(),
    });
    if !registry["channels"][agent_id].is_object() {
        registry["channels"][agent_id] = json!({});
    }
    registry["channels"][agent_id][uid] = json!(thread_id);
    write_threads(state, &threads).await?;
    write_json(&registry_path(state), &registry).await?;
    Ok(thread_id)
}

async fn main_agent(state: &AppState, uid: &str) -> Result<Value, ApiError> {
    let identity = get_agent_identity(state, Some(uid)).await?;
    let name = identity["name"].as_str().unwrap_or("Amiro").to_string();
    let channel = ensure_channel(state, MAIN_AGENT_ID, &name, &state.workspace, uid).await?;
    Ok(json!({
        "id": MAIN_AGENT_ID,
        "name": name,
        "role": identity["tagline"],
        "instructions": "",
        "traits": identity["traits"],
        "accentHex": identity["accentHex"],
        "customImageUrl": identity["customImageUrl"],
        "isMain": true,
        "channelThreadId": channel,
        "workspaceDir": state.workspace.to_string_lossy(),
        "createdAt": Value::Null,
        "updatedAt": identity["updatedAt"],
    }))
}

async fn team_agent(state: &AppState, record: &Value, uid: &str) -> Result<Value, ApiError> {
    let id = record["id"].as_str().unwrap_or("");
    let name = record["name"].as_str().unwrap_or("Agent");
    let dir = agents_root(state).join(id);
    tokio::fs::create_dir_all(&dir).await?;
    let channel = ensure_channel(state, id, name, &dir, uid).await?;
    let color = record["traits"]["color"].as_str().unwrap_or("orange");
    Ok(json!({
        "id": id,
        "name": name,
        "role": record["role"],
        "instructions": record["instructions"],
        "traits": record["traits"],
        "accentHex": accent_palette(color).unwrap_or("#E9642F"),
        "customImageUrl": Value::Null,
        "isMain": false,
        "channelThreadId": channel,
        "workspaceDir": dir.to_string_lossy(),
        "createdAt": record["createdAt"],
        "updatedAt": record["updatedAt"],
    }))
}

async fn agent_json(state: &AppState, id: &str, uid: &str) -> Result<Value, ApiError> {
    if id == MAIN_AGENT_ID {
        return main_agent(state, uid).await;
    }
    if !valid_agent_id(id) {
        return Err(not_found());
    }
    let registry = read_registry(state).await?;
    let record = find_record(&registry, id).cloned().ok_or_else(not_found)?;
    team_agent(state, &record, uid).await
}

async fn list_agents(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let mut out = vec![main_agent(&state, &uid).await?];
    let registry = read_registry(&state).await?;
    let mut records = registry["agents"].as_array().cloned().unwrap_or_default();
    records.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
    for record in records {
        out.push(team_agent(&state, &record, &uid).await?);
    }
    Ok(Json(json!({ "agents": out })))
}

async fn create_agent(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_admin(&user)?;
    let uid = user_id(&user);
    let mut record = agent_fields(&body, None)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let now = now_iso();
    record.insert("id".into(), json!(id));
    record.insert("createdAt".into(), json!(now));
    record.insert("updatedAt".into(), json!(now));
    let record = Value::Object(record);

    write_home(&state, &agents_root(&state).join(&id), &record).await?;
    {
        let _guard = state.store.lock().await;
        let mut registry = read_registry(&state).await?;
        if let Some(agents) = registry["agents"].as_array_mut() {
            agents.push(record.clone());
        }
        write_json(&registry_path(&state), &registry).await?;
    }
    let agent = team_agent(&state, &record, &uid).await?;
    Ok((StatusCode::CREATED, Json(agent)))
}

async fn get_agent(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(agent_json(&state, &id, &user_id(&user)).await?))
}

fn main_is_fixed() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "The main agent is edited on its Personality page.".into(),
    )
}

async fn patch_agent(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    if id == MAIN_AGENT_ID {
        return Err(main_is_fixed());
    }
    if !valid_agent_id(&id) {
        return Err(not_found());
    }
    let updated = {
        let _guard = state.store.lock().await;
        let mut registry = read_registry(&state).await?;
        let agents = registry["agents"].as_array_mut().ok_or_else(not_found)?;
        let slot = agents
            .iter_mut()
            .find(|a| a.get("id").and_then(Value::as_str) == Some(id.as_str()))
            .ok_or_else(not_found)?;
        let fields = agent_fields(&body, Some(slot))?;
        for (key, value) in fields {
            slot[&key] = value;
        }
        slot["updatedAt"] = json!(now_iso());
        let updated = slot.clone();
        write_json(&registry_path(&state), &registry).await?;
        updated
    };
    write_home(&state, &agents_root(&state).join(&id), &updated).await?;
    Ok(Json(team_agent(&state, &updated, &user_id(&user)).await?))
}

async fn delete_agent(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(id): UrlPath<String>,
) -> Result<StatusCode, ApiError> {
    require_admin(&user)?;
    if id == MAIN_AGENT_ID {
        return Err(main_is_fixed());
    }
    if !valid_agent_id(&id) {
        return Err(not_found());
    }
    let sessions: Vec<String> = {
        let _guard = state.store.lock().await;
        let mut registry = read_registry(&state).await?;
        let before = registry["agents"].as_array().map(Vec::len).unwrap_or(0);
        if let Some(agents) = registry["agents"].as_array_mut() {
            agents.retain(|a| a.get("id").and_then(Value::as_str) != Some(id.as_str()));
        }
        if registry["agents"].as_array().map(Vec::len).unwrap_or(0) == before {
            return Err(not_found());
        }
        if let Some(channels) = registry["channels"].as_object_mut() {
            channels.remove(&id);
        }
        let mut threads = read_threads(&state).await?;
        let mut sessions = Vec::new();
        if let Some(map) = threads.as_object_mut() {
            map.retain(|_, entry| {
                let belongs = entry.get("agentId").and_then(Value::as_str) == Some(id.as_str());
                if belongs {
                    if let Some(sid) = entry.get("sessionId").and_then(Value::as_str) {
                        sessions.push(sid.to_string());
                    }
                }
                !belongs
            });
        }
        write_threads(&state, &threads).await?;
        write_json(&registry_path(&state), &registry).await?;
        sessions
    };
    for sid in sessions {
        let _ = crate::runtime::archive_session(&state, &sid).await;
    }
    // The folder is kept, never read again: deleting an agent must not destroy
    // the files it made.
    let dir = agents_root(&state).join(&id);
    if tokio::fs::try_exists(&dir).await.unwrap_or(false) {
        let archive = state.home.join("agents-archive");
        tokio::fs::create_dir_all(&archive).await?;
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
        tokio::fs::rename(&dir, archive.join(format!("{id}-{stamp}"))).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn agent_threads(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id(&user);
    let agent = agent_json(&state, &id, &uid).await?;
    let channel = agent["channelThreadId"].as_str().unwrap_or("").to_string();
    let threads = read_threads(&state).await?;
    let mut list: Vec<Value> = threads
        .as_object()
        .map(|map| {
            map.iter()
                .filter(|(_, e)| crate::threads::entry_owned(e, &uid))
                .filter(|(_, e)| {
                    let agent_id = e.get("agentId").and_then(Value::as_str).unwrap_or(MAIN_AGENT_ID);
                    agent_id == id
                })
                .filter(|(_, e)| !e.get("archived").and_then(Value::as_bool).unwrap_or(false))
                .map(|(tid, e)| {
                    json!({
                        "id": tid,
                        "title": e.get("title").and_then(Value::as_str).unwrap_or("New Chat"),
                        "channel": e.get("channel").and_then(Value::as_bool).unwrap_or(false),
                        "createdAt": e.get("createdAt"),
                        "lastMessageAt": e.get("lastMessageAt").or_else(|| e.get("createdAt")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| {
        let key = |v: &Value| (v["id"].as_str() != Some(channel.as_str()), std::cmp::Reverse(v["lastMessageAt"].as_str().unwrap_or("").to_string()));
        key(a).cmp(&key(b))
    });
    Ok(Json(json!({ "threads": list })))
}

/// Read-only file listing of a folder: relative paths, hidden and secret
/// names skipped, symlinks not followed, bounded in depth and count.
fn list_files(root: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if out.len() >= MAX_FILES {
                return out;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if is_blocked_workspace_path(&rel) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                out.push(json!({"path": rel, "kind": "dir"}));
                if depth + 1 < MAX_FILE_DEPTH {
                    stack.push((path, depth + 1));
                }
            } else if meta.is_file() {
                out.push(json!({"path": rel, "kind": "file", "size": meta.len()}));
            }
        }
    }
    out.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    out
}

async fn agent_files(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    let agent = agent_json(&state, &id, &user_id(&user)).await?;
    let root = PathBuf::from(agent["workspaceDir"].as_str().unwrap_or_default());
    let files = tokio::task::spawn_blocking(move || list_files(&root))
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "files": files })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/agents", get(list_agents).post(create_agent))
        .route(
            "/api/agents/{id}",
            get(get_agent).patch(patch_agent).delete(delete_agent),
        )
        .route("/api/agents/{id}/threads", get(agent_threads))
        .route("/api/agents/{id}/files", get(agent_files))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_ids_are_hex_uuids_only() {
        assert!(valid_agent_id(&uuid::Uuid::new_v4().simple().to_string()));
        assert!(!valid_agent_id("main"));
        assert!(!valid_agent_id("../../etc/passwd"));
        assert!(!valid_agent_id(&"A".repeat(32)));
        assert!(!valid_agent_id(""));
    }

    #[test]
    fn identity_includes_role_and_instructions() {
        let record = json!({"name": "Scout", "role": "Researcher", "instructions": "Cite sources."});
        let md = team_identity_md(&record);
        assert!(md.contains("**Name:** Scout"));
        assert!(md.contains("**Handle:** @scout"));
        assert!(md.contains("**Tagline:** Researcher"));
        assert!(md.contains("## Role and instructions\n\nCite sources."));
        assert!(md.contains("this agent's page in Team"));
    }

    #[test]
    fn fields_validate_name_and_keep_existing_on_patch() {
        assert_eq!(agent_fields(&json!({}), None).unwrap_err().0, StatusCode::BAD_REQUEST);
        let long = "x".repeat(MAX_NAME_CHARS + 1);
        assert_eq!(
            agent_fields(&json!({"name": long}), None).unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        let existing = json!({"name": "Scout", "role": "Researcher", "instructions": "a"});
        let fields = agent_fields(&json!({"role": "Writer"}), Some(&existing)).unwrap();
        assert_eq!(fields["name"], "Scout");
        assert_eq!(fields["role"], "Writer");
        assert_eq!(fields["traits"]["bodyShape"], "blob");
    }
}
