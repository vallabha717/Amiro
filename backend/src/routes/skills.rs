use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::routes::fsbrowse::{is_denied, is_inside_roots, resolve_browse_roots};
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

pub const SKILL_NAME_MAX_LENGTH: usize = 64;

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn user_id_of(user: &AuthUser) -> String {
    user.0
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn store_path(state: &AppState, key: &str) -> PathBuf {
    state.home.join("store").join(key)
}

pub fn is_valid_skill_name(name: &str) -> bool {
    if name.is_empty() || name.len() > SKILL_NAME_MAX_LENGTH {
        return false;
    }
    // Must match ^[a-z0-9]+(-[a-z0-9]+)*$
    let parts: Vec<&str> = name.split('-').collect();
    for part in parts {
        if part.is_empty() {
            return false;
        }
        if !part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return false;
        }
    }
    true
}

fn is_safe_lookup_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.chars().any(|c| c.is_ascii_control() || c == '/' || c == '\\')
}

fn tools_exposed() -> bool {
    // Single source of truth for the tool policy lives in `runtime`.
    crate::runtime::expose_tools()
}

fn skill_generation_enabled() -> bool {
    std::env::var("AMIRO_ENABLE_SKILL_GENERATION").map(|v| v == "1").unwrap_or(false)
}

fn describe_capability(body: &str, disable_model_inv: bool, name: &str, tools_on: bool) -> (bool, bool, String) {
    let body_trim = body.trim();
    if body_trim.is_empty() {
        return (
            false,
            false,
            "This SKILL.md has no instructions in its body, so there is nothing to deliver to a turn.".to_string(),
        );
    }
    if disable_model_inv {
        return (
            false,
            false,
            "This SKILL.md sets disable-model-invocation, so the model is not allowed to use it.".to_string(),
        );
    }
    if !is_valid_skill_name(&name.to_lowercase()) {
        return (
            false,
            false,
            format!("\"{name}\" is not a valid skill name, so a chat mention cannot resolve it. Only lowercase letters, digits and single hyphens work."),
        );
    }
    if !tools_on {
        return (
            true,
            false,
            "Mentioning this skill adds its SKILL.md to the turn, but this server runs with tools off, so the skill can be read, not executed.".to_string(),
        );
    }
    (
        true,
        true,
        "Mentioning this skill adds its SKILL.md to the turn and this server exposes tools, so the model can act on it.".to_string(),
    )
}

#[allow(dead_code)]
struct ParsedSkill {
    name: String,
    description: String,
    body: String,
    license: Option<String>,
    disable_model_invocation: bool,
    allowed_tools: Vec<String>,
}

fn parse_skill_markdown(raw: &str, fallback_name: &str) -> ParsedSkill {
    let mut name = fallback_name.to_string();
    let mut description = String::new();
    let mut body = raw.to_string();
    let mut license = None;
    let mut disable_model_invocation = false;
    let mut allowed_tools = Vec::new();

    if let Some(rest) = raw.strip_prefix("---\n").or_else(|| raw.strip_prefix("---\r\n")) {
        if let Some(idx) = rest.find("\n---") {
            let front = &rest[..idx];
            let after = &rest[idx + 4..];
            body = after.trim_start_matches(['\r', '\n']).trim().to_string();

            for line in front.lines() {
                let line = line.trim();
                if let Some((k, v)) = line.split_once(':') {
                    let key = k.trim().to_lowercase().replace('_', "-");
                    let val = v.trim().trim_matches(['\'', '"']).trim();
                    match key.as_str() {
                        "name" if !val.is_empty() => name = val.to_string(),
                        "description" if !val.is_empty() => description = val.to_string(),
                        "license" if !val.is_empty() => license = Some(val.to_string()),
                        "disable-model-invocation" => disable_model_invocation = val == "true",
                        "allowed-tools" => {
                            allowed_tools = val
                                .split(',')
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect();
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    if description.is_empty() && !body.is_empty() {
        for line in body.lines() {
            let l = line.trim();
            if !l.is_empty() && !l.starts_with('#') && !l.starts_with("```") {
                description = l.chars().take(240).collect();
                break;
            }
        }
    }

    ParsedSkill {
        name,
        description,
        body,
        license,
        disable_model_invocation,
        allowed_tools,
    }
}

fn user_store_key(user_id: &str) -> String {
    let safe: String = user_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if safe.is_empty() {
        "skills/unknown.json".to_string()
    } else {
        format!("skills/{safe}.json")
    }
}

#[derive(Debug, Deserialize, Default)]
struct SkillsQuery {
    project: Option<String>,
}

fn assert_usable_project_dir(raw: &str) -> Result<PathBuf, ApiError> {
    if raw.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "path is required".to_string()));
    }
    let p = Path::new(raw);
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
    let meta = std::fs::metadata(&real).map_err(|_| {
        ApiError(StatusCode::BAD_REQUEST, "path does not exist".to_string())
    })?;
    if !meta.is_dir() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "path is not a directory".to_string()));
    }
    Ok(real)
}

struct DiscoveredSkill {
    name: String,
    description: String,
    body: String,
    resources: Vec<String>,
    license: Option<String>,
    disable_model_invocation: bool,
    allowed_tools: Vec<String>,
    scope: String,
    source: String,
    writable: bool,
    readonly: bool,
    path: String,
    updated_at: String,
}

fn discover_skills(
    state: &AppState,
    project_dir: Option<&Path>,
) -> (HashMap<String, DiscoveredSkill>, Vec<Value>) {
    let mut discovered = HashMap::new();
    let mut diagnostics = Vec::new();

    let repo_root = project_dir.unwrap_or(&state.workspace);
    let codex_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/root"))
        .join(".codex");

    let roots = [
        (state.runtime_home.join("skills"), "user", ".amiro"),
        (repo_root.join(".amiro").join("skills"), "project", ".amiro"),
        (repo_root.join(".jcode").join("skills"), "project", ".amiro"),
        (repo_root.join(".agents").join("skills"), "project", ".agents"),
        (codex_home.join("skills"), "user", ".codex"),
    ];

    for (root_dir, scope, source) in roots {
        let root_canon = match std::fs::canonicalize(&root_dir) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let read_dir = match std::fs::read_dir(&root_canon) {
            Ok(rd) => rd,
            Err(_) => continue,
        };

        for entry in read_dir.flatten() {
            let ent_name = entry.file_name().to_string_lossy().to_string();
            if ent_name.starts_with('.') || ent_name.starts_with('_') {
                continue;
            }

            let skill_dir = root_canon.join(&ent_name);
            let skill_md = skill_dir.join("SKILL.md");

            let skill_md_canon = match std::fs::canonicalize(&skill_md) {
                Ok(c) => c,
                Err(_) => continue,
            };

            // Containment check
            if !skill_md_canon.starts_with(&root_canon) {
                diagnostics.push(json!({
                    "path": skill_md.to_string_lossy(),
                    "skill": ent_name,
                    "severity": "error",
                    "message": format!("SKILL.md resolves outside its skills root. Refusing to read it."),
                }));
                continue;
            }

            let raw = match std::fs::read_to_string(&skill_md_canon) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let parsed = parse_skill_markdown(&raw, &ent_name);
            let key = ent_name.to_lowercase();
            if discovered.contains_key(&key) {
                continue;
            }

            let mut resources = Vec::new();
            if let Ok(sub) = std::fs::read_dir(&skill_dir) {
                for r in sub.flatten() {
                    let r_name = r.file_name().to_string_lossy().to_string();
                    if r_name != "SKILL.md" && !r_name.starts_with('.') {
                        resources.push(r_name);
                    }
                }
            }

            let updated_at = match std::fs::metadata(&skill_md_canon) {
                Ok(m) => m
                    .modified()
                    .ok()
                    .map(|t| {
                        let dt: chrono::DateTime<Utc> = t.into();
                        dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    })
                    .unwrap_or_else(now_iso),
                Err(_) => now_iso(),
            };

            discovered.insert(
                key,
                DiscoveredSkill {
                    name: ent_name,
                    description: parsed.description,
                    body: if parsed.body.is_empty() { raw } else { parsed.body },
                    resources,
                    license: parsed.license,
                    disable_model_invocation: parsed.disable_model_invocation,
                    allowed_tools: parsed.allowed_tools,
                    scope: scope.to_string(),
                    source: source.to_string(),
                    writable: false,
                    readonly: true,
                    path: skill_md.to_string_lossy().to_string(),
                    updated_at,
                },
            );
        }
    }

    (discovered, diagnostics)
}

fn present_summary(skill: &DiscoveredSkill, tools_on: bool) -> Value {
    let (deliverable, invokable, invokable_reason) =
        describe_capability(&skill.body, skill.disable_model_invocation, &skill.name, tools_on);

    json!({
        "name": skill.name,
        "description": skill.description,
        "scope": skill.scope,
        "source": skill.source,
        "writable": skill.writable,
        "readonly": skill.readonly,
        "disableModelInvocation": skill.disable_model_invocation,
        "allowedTools": skill.allowed_tools,
        "deliverable": deliverable,
        "invokable": invokable,
        "invokableReason": invokable_reason,
        "path": skill.path,
        "license": skill.license,
        "updatedAt": skill.updated_at,
    })
}

fn present_detail(skill: &DiscoveredSkill, tools_on: bool) -> Value {
    let mut sum = present_summary(skill, tools_on);
    if let Some(obj) = sum.as_object_mut() {
        obj.insert("body".to_string(), json!(skill.body));
        obj.insert("resources".to_string(), json!(skill.resources));
    }
    sum
}

async fn get_merged_skills(
    state: &AppState,
    user_id: &str,
    project_dir: Option<&Path>,
) -> Result<(HashMap<String, DiscoveredSkill>, Vec<Value>), ApiError> {
    let (fs_skills, diagnostics) = discover_skills(state, project_dir);

    let store_key = user_store_key(user_id);
    let store_file = store_path(state, &store_key);
    let user_store = read_json(&store_file, json!({})).await.unwrap_or(json!({}));

    let mut merged = HashMap::new();

    // User's own skills are writable and take precedence
    if let Some(map) = user_store.as_object() {
        for (k, v) in map {
            let name = v.get("name").and_then(|n| n.as_str()).unwrap_or(k);
            let desc = v.get("description").and_then(|d| d.as_str()).unwrap_or("");
            let body = v.get("body").and_then(|b| b.as_str()).unwrap_or("");
            let resources = v
                .get("resources")
                .and_then(|r| r.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            let scope = v.get("scope").and_then(|s| s.as_str()).unwrap_or("user");
            let source = v.get("source").and_then(|s| s.as_str()).unwrap_or(".amiro");
            let path = v
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or(&format!("~/.amiro/skills/{name}/SKILL.md"))
                .to_string();
            let updated_at = v
                .get("updatedAt")
                .and_then(|u| u.as_str())
                .unwrap_or(&now_iso())
                .to_string();

            merged.insert(
                k.to_lowercase(),
                DiscoveredSkill {
                    name: name.to_string(),
                    description: desc.to_string(),
                    body: body.to_string(),
                    resources,
                    license: None,
                    disable_model_invocation: false,
                    allowed_tools: Vec::new(),
                    scope: scope.to_string(),
                    source: source.to_string(),
                    writable: true,
                    readonly: false,
                    path,
                    updated_at,
                },
            );
        }
    }

    // Merge discovered filesystem skills
    for (k, s) in fs_skills {
        merged.entry(k).or_insert(s);
    }

    Ok((merged, diagnostics))
}

async fn mirror_skill(state: &AppState, name: &str, skill: &DiscoveredSkill) -> Option<String> {
    if !is_valid_skill_name(name) {
        return Some(format!("Invalid skill name: not mirrored to workspace"));
    }
    let root = state.workspace.join("skills");
    let skill_dir = root.join(name);
    if let Err(e) = tokio::fs::create_dir_all(&skill_dir).await {
        return Some(e.to_string());
    }
    let target = skill_dir.join("SKILL.md");
    let content = if !skill.description.is_empty() {
        format!("---\nname: {}\ndescription: {}\n---\n\n{}", skill.name, skill.description, skill.body)
    } else {
        skill.body.clone()
    };
    if let Err(e) = tokio::fs::write(&target, content).await {
        return Some(e.to_string());
    }
    None
}

async fn list_skills(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<SkillsQuery>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let project_dir = if let Some(p) = query.project.as_deref().filter(|s| !s.is_empty()) {
        Some(assert_usable_project_dir(p)?)
    } else {
        None
    };

    let tools_on = tools_exposed();
    let (merged, diagnostics) = get_merged_skills(&state, &uid, project_dir.as_deref()).await?;

    let items: Vec<Value> = merged.values().map(|s| present_summary(s, tools_on)).collect();
    Ok(Json(json!({
        "items": items,
        "diagnostics": diagnostics,
        "truncated": false,
    })))
}

async fn get_skill_detail(
    State(state): State<AppState>,
    user: AuthUser,
    AxumPath(name): AxumPath<String>,
    Query(query): Query<SkillsQuery>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    if !is_safe_lookup_name(&name) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid skill name".to_string()));
    }

    let project_dir = if let Some(p) = query.project.as_deref().filter(|s| !s.is_empty()) {
        Some(assert_usable_project_dir(p)?)
    } else {
        None
    };

    let tools_on = tools_exposed();
    let (merged, _) = get_merged_skills(&state, &uid, project_dir.as_deref()).await?;
    let skill = merged
        .get(&name.to_lowercase())
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "skill not found".to_string()))?;

    Ok(Json(present_detail(skill, tools_on)))
}

async fn create_skill(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let name = body
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if name.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "skill name is required".to_string()));
    }
    if !is_valid_skill_name(&name) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "skill name must be lowercase letters, digits and single hyphens (max 64 characters)".to_string(),
        ));
    }

    let now = now_iso();
    let desc = body.get("description").and_then(|d| d.as_str()).unwrap_or("").trim().to_string();
    let skill_body = body.get("body").and_then(|b| b.as_str()).unwrap_or("").trim().to_string();
    let resources = body
        .get("resources")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let store_key = user_store_key(&uid);
    let store_file = store_path(&state, &store_key);
    {
        let _lock = state.store.lock().await;
        let mut user_store = read_json(&store_file, json!({})).await?;

        if user_store.get(&name).is_some() {
            return Err(ApiError(
                StatusCode::CONFLICT,
                format!("skill {name} already exists"),
            ));
        }

        let record = json!({
            "name": name,
            "description": desc,
            "body": skill_body,
            "resources": resources,
            "scope": "user",
            "source": ".amiro",
            "writable": true,
            "readonly": false,
            "path": format!("~/.amiro/skills/{name}/SKILL.md"),
            "createdAt": now,
            "updatedAt": now,
        });

        if let Some(map) = user_store.as_object_mut() {
            map.insert(name.clone(), record);
        } else {
            let mut map = serde_json::Map::new();
            map.insert(name.clone(), record);
            user_store = Value::Object(map);
        }
        write_json(&store_file, &user_store).await?;
    }

    let discovered = DiscoveredSkill {
        name: name.clone(),
        description: desc,
        body: skill_body,
        resources,
        license: None,
        disable_model_invocation: false,
        allowed_tools: Vec::new(),
        scope: "user".to_string(),
        source: ".amiro".to_string(),
        writable: true,
        readonly: false,
        path: format!("~/.amiro/skills/{name}/SKILL.md"),
        updated_at: now,
    };

    let warn = mirror_skill(&state, &name, &discovered).await;
    let mut warnings = Vec::new();
    if let Some(w) = warn {
        warnings.push(w);
    }

    Ok(Json(json!({
        "skill": present_detail(&discovered, tools_exposed()),
        "warnings": warnings,
    })))
}

async fn update_skill(
    State(state): State<AppState>,
    user: AuthUser,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let name = name.to_lowercase();
    if !is_valid_skill_name(&name) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "skill name must be lowercase letters, digits and single hyphens (max 64 characters)".to_string(),
        ));
    }

    let store_key = user_store_key(&uid);
    let store_file = store_path(&state, &store_key);
    let updated_record = {
        let _lock = state.store.lock().await;
        let mut user_store = read_json(&store_file, json!({})).await?;

        let map = match user_store.as_object_mut() {
            Some(m) => m,
            None => {
                return Err(ApiError(StatusCode::NOT_FOUND, "skill not found".to_string()));
            }
        };

        let entry = match map.get_mut(&name) {
            Some(e) => e,
            None => {
                let (merged, _) = get_merged_skills(&state, &uid, None).await?;
                if merged.contains_key(&name) {
                    return Err(ApiError(StatusCode::CONFLICT, "skill is read-only".to_string()));
                }
                return Err(ApiError(StatusCode::NOT_FOUND, "skill not found".to_string()));
            }
        };

        if let Some(d) = body.get("description") {
            entry["description"] = json!(d.as_str().unwrap_or("").trim());
        }
        if let Some(b) = body.get("body") {
            entry["body"] = json!(b.as_str().unwrap_or("").trim());
        }
        if let Some(r) = body.get("resources") {
            entry["resources"] = r.clone();
        }
        entry["updatedAt"] = json!(now_iso());

        let rec = entry.clone();
        write_json(&store_file, &user_store).await?;
        rec
    };

    let discovered = DiscoveredSkill {
        name: name.clone(),
        description: updated_record.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
        body: updated_record.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string(),
        resources: updated_record.get("resources").and_then(|r| r.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
        license: None,
        disable_model_invocation: false,
        allowed_tools: Vec::new(),
        scope: "user".to_string(),
        source: ".amiro".to_string(),
        writable: true,
        readonly: false,
        path: format!("~/.amiro/skills/{name}/SKILL.md"),
        updated_at: updated_record.get("updatedAt").and_then(|u| u.as_str()).unwrap_or(&now_iso()).to_string(),
    };

    let warn = mirror_skill(&state, &name, &discovered).await;
    let mut warnings = Vec::new();
    if let Some(w) = warn {
        warnings.push(w);
    }

    Ok(Json(json!({
        "skill": present_detail(&discovered, tools_exposed()),
        "warnings": warnings,
    })))
}

async fn delete_skill(
    State(state): State<AppState>,
    user: AuthUser,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    let name = name.to_lowercase();
    if !is_valid_skill_name(&name) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "skill name must be lowercase letters, digits and single hyphens (max 64 characters)".to_string(),
        ));
    }

    let store_key = user_store_key(&uid);
    let store_file = store_path(&state, &store_key);
    {
        let _lock = state.store.lock().await;
        let mut user_store = read_json(&store_file, json!({})).await?;

        let map = match user_store.as_object_mut() {
            Some(m) => m,
            None => {
                return Err(ApiError(StatusCode::NOT_FOUND, "skill not found".to_string()));
            }
        };

        if map.remove(&name).is_none() {
            let (merged, _) = get_merged_skills(&state, &uid, None).await?;
            if merged.contains_key(&name) {
                return Err(ApiError(StatusCode::CONFLICT, "skill is read-only".to_string()));
            }
            return Err(ApiError(StatusCode::NOT_FOUND, "skill not found".to_string()));
        }
        write_json(&store_file, &user_store).await?;
    }

    let mirror_dir = state.workspace.join("skills").join(&name);
    let _ = tokio::fs::remove_dir_all(&mirror_dir).await;

    Ok(Json(json!({ "success": true, "warnings": [] })))
}

async fn duplicate_skill(
    State(state): State<AppState>,
    user: AuthUser,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let uid = user_id_of(&user);
    if !is_safe_lookup_name(&name) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid skill name".to_string()));
    }

    let (merged, _) = get_merged_skills(&state, &uid, None).await?;
    let skill = merged
        .get(&name.to_lowercase())
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "skill not found".to_string()))?;

    let base: String = skill
        .name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let base = base.trim_matches('-').to_string();
    let stem = if is_valid_skill_name(&base) { base } else { "skill".to_string() };

    let mut copy_name = format!("{stem}-copy");
    let mut counter = 1;
    while merged.contains_key(&copy_name) {
        counter += 1;
        copy_name = format!("{stem}-copy-{counter}");
    }

    let now = now_iso();
    let store_key = user_store_key(&uid);
    let store_file = store_path(&state, &store_key);
    {
        let _lock = state.store.lock().await;
        let mut user_store = read_json(&store_file, json!({})).await?;

        let record = json!({
            "name": copy_name,
            "description": skill.description,
            "body": skill.body,
            "resources": skill.resources,
            "scope": "user",
            "source": ".amiro",
            "writable": true,
            "readonly": false,
            "path": format!("~/.amiro/skills/{copy_name}/SKILL.md"),
            "createdAt": now,
            "updatedAt": now,
        });

        if let Some(map) = user_store.as_object_mut() {
            map.insert(copy_name.clone(), record);
        }
        write_json(&store_file, &user_store).await?;
    }

    let dup_skill = DiscoveredSkill {
        name: copy_name.clone(),
        description: skill.description.clone(),
        body: skill.body.clone(),
        resources: skill.resources.clone(),
        license: None,
        disable_model_invocation: false,
        allowed_tools: Vec::new(),
        scope: "user".to_string(),
        source: ".amiro".to_string(),
        writable: true,
        readonly: false,
        path: format!("~/.amiro/skills/{copy_name}/SKILL.md"),
        updated_at: now,
    };

    let warn = mirror_skill(&state, &copy_name, &dup_skill).await;
    let mut warnings = Vec::new();
    if let Some(w) = warn {
        warnings.push(w);
    }

    Ok(Json(json!({
        "skill": present_detail(&dup_skill, tools_exposed()),
        "warnings": warnings,
    })))
}

async fn generate_skill(
    _user: AuthUser,
    Json(_body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !skill_generation_enabled() {
        return Err(ApiError(
            StatusCode::NOT_IMPLEMENTED,
            "Model-drafted skills are not enabled in this deployment".to_string(),
        ));
    }
    // If enabled in deployment, return 501 unless runtime prompt execution is configured
    Err(ApiError(
        StatusCode::NOT_IMPLEMENTED,
        "Model-drafted skills generation requires interactive model runtime".to_string(),
    ))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/skills", get(list_skills).post(create_skill))
        .route(
            "/api/skills/items/{name}",
            get(get_skill_detail).put(update_skill).delete(delete_skill),
        )
        .route(
            "/api/skills/items/{name}/duplicate",
            post(duplicate_skill),
        )
        .route("/api/skills/generate", post(generate_skill))
}
