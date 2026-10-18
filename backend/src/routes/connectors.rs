//! Unified Connectors API.
//!
//! One surface over the runtime's MCP config (`$AMIRO_RUNTIME_HOME/mcp.json`),
//! covering both the Composio-managed server and user-defined ("custom") MCP
//! servers. Secrets never live in `mcp.json`: a secret header/env value is
//! stored in the credential vault as service `mcp.<slug>`, field `<field>`, and
//! the file carries only a `${AMIRO_CRED_MCP_<SLUG>_<FIELD>}` placeholder that
//! the runtime resolves (from `credential-env.json`, kept in sync by the
//! credential store). The list of secrets a server needs is therefore derived
//! from the placeholders in its entry; there is no separate metadata file.
//!
//! Responses never carry header or env *values*, only their names.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use crate::credentials;
use crate::runtime::McpReloadOutcome;
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

const COMPOSIO: &str = "composio";
const MAX_SLUG_LEN: usize = 40;
const STATUS_TTL: Duration = Duration::from_secs(5);
const LEGACY_FILE: &str = "mcp-servers.json";
const LEGACY_MIGRATED_FILE: &str = "mcp-servers.migrated.json";

fn bad(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(Value::as_str) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "admin required".to_string()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// mcp.json access (shared with composio.rs)
// ---------------------------------------------------------------------------

/// The runtime's MCP config file.
pub fn mcp_config_path(state: &AppState) -> std::path::PathBuf {
    state.runtime_home.join("mcp.json")
}

fn servers_key_for(object: &Map<String, Value>, name: Option<&str>) -> &'static str {
    let has = |key: &str| {
        object.get(key).and_then(Value::as_object).is_some_and(|servers| {
            name.is_none_or(|name| servers.contains_key(name))
        })
    };
    if has("servers") {
        "servers"
    } else if has("mcpServers") {
        "mcpServers"
    } else if object.contains_key("servers") || !object.contains_key("mcpServers") {
        "servers"
    } else {
        "mcpServers"
    }
}

/// Read-modify-write the servers map, preserving every other entry and every
/// unknown top-level key. `name` picks which of `servers`/`mcpServers` to edit
/// when a file has both. Written atomically (0600) only when something
/// changed. Returns the closure's result and whether the file was rewritten.
pub async fn mutate_mcp_servers<R>(
    state: &AppState,
    name: Option<&str>,
    edit: impl FnOnce(&mut Map<String, Value>) -> R,
) -> Result<(R, bool), ApiError> {
    let path = mcp_config_path(state);
    let _lock = state.store.lock().await;
    let mut document = read_json(&path, json!({ "servers": {} })).await?;
    if !document.is_object() {
        document = json!({ "servers": {} });
    }
    let before = document.clone();
    let object = document.as_object_mut().expect("object checked above");
    let key = servers_key_for(object, name);
    let servers = object.entry(key.to_string()).or_insert_with(|| json!({}));
    if !servers.is_object() {
        *servers = json!({});
    }
    let result = edit(servers.as_object_mut().expect("object ensured above"));
    if document == before {
        return Ok((result, false));
    }
    write_json(&path, &document).await?;
    Ok((result, true))
}

/// Insert (`Some`) or remove (`None`) one named server.
pub async fn write_mcp_entry_named(
    state: &AppState,
    name: &str,
    entry: Option<&Value>,
) -> Result<bool, ApiError> {
    let (_, changed) = mutate_mcp_servers(state, Some(name), |servers| match entry {
        Some(entry) => {
            servers.insert(name.to_string(), entry.clone());
        }
        None => {
            servers.remove(name);
        }
    })
    .await?;
    Ok(changed)
}

/// Every server entry, merging `servers` and `mcpServers` (first key wins).
async fn read_servers(state: &AppState) -> Result<Vec<(String, Value)>, ApiError> {
    let document = read_json(&mcp_config_path(state), json!({})).await?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for key in ["servers", "mcpServers"] {
        if let Some(map) = document.get(key).and_then(Value::as_object) {
            for (name, entry) in map {
                if seen.insert(name.clone()) {
                    out.push((name.clone(), entry.clone()));
                }
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

async fn read_server(state: &AppState, name: &str) -> Result<Option<Value>, ApiError> {
    Ok(read_servers(state)
        .await?
        .into_iter()
        .find(|(n, _)| n == name)
        .map(|(_, entry)| entry))
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// `[a-z0-9-]`, 1..=40 characters.
pub fn is_valid_slug(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_SLUG_LEN
        && name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && name.bytes().all(is_token_char)
}

fn is_valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 128
        && bytes
            .next()
            .is_some_and(|b| b.is_ascii_uppercase() || b == b'_')
        && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn validate_remote_url(raw: &str) -> Result<(), ApiError> {
    let parsed = url::Url::parse(raw.trim()).map_err(|_| bad("url is not a valid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(bad("url must be http or https"));
    }
    if parsed.host_str().is_none() {
        return Err(bad("url must have a host"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(bad("url must not contain credentials"));
    }
    if parsed.fragment().is_some() {
        return Err(bad("url must not contain a fragment"));
    }
    Ok(())
}

/// Lowercase vault field for a header/env name: `X-Api-Key` -> `x_api_key`.
fn field_for(name: &str) -> String {
    let field: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    field
}

fn vault_service(slug: &str) -> String {
    format!("mcp.{slug}")
}

fn env_var_for(slug: &str, field: &str) -> String {
    credentials::env_var_name(&vault_service(slug), field)
}

fn placeholder(slug: &str, field: &str) -> String {
    format!("${{{}}}", env_var_for(slug, field))
}

// ---------------------------------------------------------------------------
// Placeholder derivation
// ---------------------------------------------------------------------------

/// Every `${NAME}` variable name referenced in `text`.
fn placeholders_in(text: &str) -> Vec<String> {
    placeholders_with_prefix(text).into_iter().map(|(name, _)| name).collect()
}

/// Each `${NAME}` in `text`, with the literal text just before it (`Bearer `
/// in `Bearer ${…}`), so a pasted value that repeats that prefix can be
/// stored without it.
fn placeholders_with_prefix(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let before = rest[..start].to_string();
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let name = &after[..end];
                if !name.is_empty()
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                {
                    out.push((name.to_string(), before));
                }
                rest = &after[end + 1..];
            }
            None => break,
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SecretRef {
    field: String,
    env_var: String,
    location: String,
    /// Literal text before the placeholder, e.g. `Bearer `.
    prefix: String,
}

/// The vault secrets a server entry references, derived from its placeholders.
/// Only variables in this server's own namespace count.
fn secret_refs(slug: &str, entry: &Value) -> Vec<SecretRef> {
    let prefix = env_var_for(slug, "");
    let mut refs: Vec<SecretRef> = Vec::new();
    let mut add = |text: &str, location: String| {
        for (var, before) in placeholders_with_prefix(text) {
            if let Some(field) = var.strip_prefix(&prefix) {
                if field.is_empty() {
                    continue;
                }
                let r = SecretRef {
                    field: field.to_ascii_lowercase(),
                    env_var: var.clone(),
                    location: location.clone(),
                    prefix: before,
                };
                if !refs.contains(&r) {
                    refs.push(r);
                }
            }
        }
    };
    if let Some(url) = entry.get("url").and_then(Value::as_str) {
        add(url, "url".to_string());
    }
    if let Some(args) = entry.get("args").and_then(Value::as_array) {
        for arg in args.iter().filter_map(Value::as_str) {
            add(arg, "arg".to_string());
        }
    }
    if let Some(headers) = entry.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                add(value, format!("header:{name}"));
            }
        }
    }
    if let Some(env) = entry.get("env").and_then(Value::as_object) {
        for (name, value) in env {
            if let Some(value) = value.as_str() {
                add(value, format!("env:{name}"));
            }
        }
    }
    refs
}

// ---------------------------------------------------------------------------
// Server JSON
// ---------------------------------------------------------------------------

/// The entry already adds `prefix` around the secret (`Bearer ${…}`); people
/// usually paste the whole header value anyway. Drop a repeated prefix so the
/// server never receives `Bearer Bearer …`.
fn strip_template_prefix<'a>(prefix: &str, value: &'a str) -> &'a str {
    let value = value.trim();
    let p = prefix.trim();
    if p.is_empty() || value.len() <= p.len() {
        return value;
    }
    if value[..p.len()].eq_ignore_ascii_case(p) {
        let rest = value[p.len()..].trim_start();
        if !rest.is_empty() {
            return rest;
        }
    }
    value
}

fn transport_of(entry: &Value) -> &'static str {
    let kind = entry
        .get("type")
        .or_else(|| entry.get("transport"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    match kind.as_str() {
        "sse" => "sse",
        "stdio" => "stdio",
        "http" | "streamable-http" | "streamable_http" | "streamablehttp" => "http",
        _ if entry.get("command").is_some() => "stdio",
        _ => "http",
    }
}

fn is_enabled(entry: &Value) -> bool {
    if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    entry.get("disabled").and_then(Value::as_bool) != Some(true)
}

fn key_names(entry: &Value, key: &str) -> Vec<String> {
    let mut names: Vec<String> = entry
        .get(key)
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    names.sort();
    names
}

fn source_of(name: &str) -> &'static str {
    if name == COMPOSIO {
        "composio"
    } else {
        "custom"
    }
}

fn status_tools(status: &Value) -> Value {
    match status.get("tools").and_then(Value::as_array) {
        Some(tools) => Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.get("name").and_then(Value::as_str).unwrap_or(""),
                        "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                    })
                })
                .collect(),
        ),
        None => Value::Null,
    }
}

/// Build one Server object. `vault_vars` is the set of env var names present in
/// the vault; `runtime_status` is the McpStatus entry for this server, if any.
fn build_server(
    name: &str,
    entry: &Value,
    vault_vars: &HashSet<String>,
    runtime_status: Option<&Value>,
) -> Value {
    let transport = transport_of(entry);
    let enabled = is_enabled(entry);
    let secrets: Vec<Value> = if name == COMPOSIO {
        Vec::new()
    } else {
        secret_refs(name, entry)
            .into_iter()
            .map(|s| {
                json!({
                    "field": s.field,
                    "envVar": s.env_var,
                    "location": s.location,
                    "prefix": s.prefix,
                    "present": vault_vars.contains(&s.env_var),
                })
            })
            .collect()
    };
    let needs_secret = secrets
        .iter()
        .any(|s| s.get("present").and_then(Value::as_bool) == Some(false));

    let (status, error, tools) = if !enabled {
        ("disabled", Value::Null, Value::Null)
    } else if needs_secret {
        ("needs-secret", Value::Null, Value::Null)
    } else if let Some(rs) = runtime_status {
        let tools = status_tools(rs);
        if rs.get("connected").and_then(Value::as_bool) == Some(true) {
            ("connected", Value::Null, tools)
        } else {
            // Not connected with no error means this session simply hasn't
            // dialed it yet, and a "waiting for a key" error is stale once
            // the key is in the vault: both read as still checking.
            let error = rs
                .get("error")
                .and_then(Value::as_str)
                .filter(|e| !e.trim().is_empty() && !e.contains("is waiting for a key"))
                .map(|e| Value::String(e.to_string()));
            match error {
                Some(error) => ("error", error, tools),
                None => ("unknown", Value::Null, tools),
            }
        }
    } else {
        ("unknown", Value::Null, Value::Null)
    };

    let mut server = json!({
        "name": name,
        "source": source_of(name),
        "transport": transport,
        "headerNames": key_names(entry, "headers"),
        "envNames": key_names(entry, "env"),
        "enabled": enabled,
        "secrets": secrets,
        "status": status,
        "error": error,
        "tools": tools,
    });
    if let Some(url) = entry.get("url").and_then(Value::as_str) {
        server["url"] = json!(url);
    }
    if let Some(command) = entry.get("command").and_then(Value::as_str) {
        server["command"] = json!(command);
    }
    if let Some(args) = entry.get("args").and_then(Value::as_array) {
        server["args"] = Value::Array(
            args.iter()
                .filter_map(|a| a.as_str().map(|s| json!(s)))
                .collect(),
        );
    }
    server
}

async fn vault_vars(state: &AppState) -> HashSet<String> {
    credentials::list_metadata(state)
        .await
        .map(|items| items.into_iter().map(|m| m.env_var).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// McpStatus (cached)
// ---------------------------------------------------------------------------

type StatusCache = std::sync::Mutex<Option<(std::path::PathBuf, Instant, Option<Value>)>>;

fn status_cache() -> &'static StatusCache {
    static CACHE: OnceLock<StatusCache> = OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

fn invalidate_status_cache() {
    if let Ok(mut cache) = status_cache().lock() {
        *cache = None;
    }
}

async fn runtime_status(state: &AppState) -> Option<Value> {
    if let Ok(cache) = status_cache().lock() {
        if let Some((home, at, value)) = cache.as_ref() {
            if home == &state.runtime_home && at.elapsed() < STATUS_TTL {
                return value.clone();
            }
        }
    }
    let value = crate::runtime::mcp_status(state).await;
    if let Ok(mut cache) = status_cache().lock() {
        *cache = Some((state.runtime_home.clone(), Instant::now(), value.clone()));
    }
    value
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

async fn servers_payload(state: &AppState) -> Result<Value, ApiError> {
    let composio_configured = crate::composio_config::resolve(state)
        .await
        .map(|key| key.is_some())
        .unwrap_or(false);
    let entries = read_servers(state).await?;
    let vars = vault_vars(state).await;
    let status = runtime_status(state).await;
    let status_available = status.is_some();
    let by_name: HashMap<String, Value> = status
        .as_ref()
        .and_then(|s| s.get("servers"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|s| {
                    s.get("name")
                        .and_then(Value::as_str)
                        .map(|n| (n.to_string(), s.clone()))
                })
                .collect()
        })
        .unwrap_or_default();
    let servers: Vec<Value> = entries
        .iter()
        .map(|(name, entry)| build_server(name, entry, &vars, by_name.get(name)))
        .collect();
    Ok(json!({
        "composio": { "configured": composio_configured },
        "statusAvailable": status_available,
        "servers": servers,
    }))
}

async fn server_response(state: &AppState, name: &str) -> Result<Value, ApiError> {
    let entry = read_server(state, name)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "connector not found".into()))?;
    let vars = vault_vars(state).await;
    Ok(build_server(name, &entry, &vars, None))
}

async fn reload(state: &AppState) -> McpReloadOutcome {
    invalidate_status_cache();
    crate::runtime::reload_mcp_idle_sessions(state).await
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/// Lowercase, `[a-z0-9-]`, collapsed and trimmed, at most 40 characters.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let mut out: String = out.trim_matches('-').chars().take(MAX_SLUG_LEN).collect();
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn legacy_string_map(value: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    match value {
        Some(Value::Object(map)) => {
            for (k, v) in map {
                if let Some(s) = v.as_str() {
                    out.insert(k.clone(), json!(s));
                }
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                let name = item
                    .get("name")
                    .or_else(|| item.get("key"))
                    .and_then(Value::as_str);
                let val = item.get("value").and_then(Value::as_str);
                if let (Some(n), Some(v)) = (name, val) {
                    out.insert(n.to_string(), json!(v));
                }
            }
        }
        _ => {}
    }
    out
}

fn legacy_entry(config: &Value) -> Option<Value> {
    let mut entry = Map::new();
    if let Some(url) = config.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()) {
        let kind = config
            .get("type")
            .or_else(|| config.get("transport"))
            .and_then(Value::as_str)
            .unwrap_or("");
        entry.insert(
            "type".into(),
            json!(if kind.eq_ignore_ascii_case("sse") {
                "sse"
            } else {
                "streamable-http"
            }),
        );
        entry.insert("url".into(), json!(url));
        let headers = legacy_string_map(config.get("headers"));
        if !headers.is_empty() {
            entry.insert("headers".into(), Value::Object(headers));
        }
    } else if let Some(command) = config
        .get("command")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
    {
        entry.insert("command".into(), json!(command));
        if let Some(args) = config.get("args").and_then(Value::as_array) {
            let args: Vec<Value> = args
                .iter()
                .filter_map(|a| a.as_str().map(|s| json!(s)))
                .collect();
            if !args.is_empty() {
                entry.insert("args".into(), Value::Array(args));
            }
        }
        let env = legacy_string_map(config.get("env"));
        if !env.is_empty() {
            entry.insert("env".into(), Value::Object(env));
        }
    } else {
        return None;
    }
    entry.insert("shared".into(), json!(true));
    Some(Value::Object(entry))
}

/// Move servers saved by the legacy `mcp.rs` store into `mcp.json` as custom
/// servers (existing names are skipped), then rename the legacy file to
/// `mcp-servers.migrated.json`. Returns the number of servers added.
pub async fn migrate_legacy(state: &AppState) -> Result<usize, ApiError> {
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let legacy = state.home.join("store").join(LEGACY_FILE);
    if !legacy.exists() {
        return Ok(0);
    }
    let _guard = GUARD.lock().await;
    if !legacy.exists() {
        return Ok(0);
    }
    let document = read_json(&legacy, json!({})).await?;
    let mut additions: Vec<(String, Value)> = Vec::new();
    if let Some(map) = document.as_object() {
        let mut items: Vec<&Value> = map.values().collect();
        items.sort_by_key(|s| s.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string());
        for server in items {
            let slug = slugify(server.get("name").and_then(Value::as_str).unwrap_or(""));
            if slug.is_empty() || slug == COMPOSIO {
                continue;
            }
            if additions.iter().any(|(n, _)| n == &slug) {
                continue;
            }
            if let Some(entry) = server.get("config").and_then(legacy_entry) {
                additions.push((slug, entry));
            }
        }
    }
    let (added, _) = mutate_mcp_servers(state, None, |servers| {
        let mut added = 0;
        for (name, entry) in additions {
            if !servers.contains_key(&name) {
                servers.insert(name, entry);
                added += 1;
            }
        }
        added
    })
    .await?;
    let mut target = legacy.with_file_name(LEGACY_MIGRATED_FILE);
    if target.exists() {
        target = legacy.with_file_name(format!(
            "mcp-servers.migrated-{}.json",
            uuid::Uuid::new_v4()
        ));
    }
    tokio::fs::rename(&legacy, &target).await?;
    if added > 0 {
        reload(state).await;
    }
    Ok(added)
}

// ---------------------------------------------------------------------------
// Custom connector input
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Pair {
    name: String,
    value: String,
    secret: bool,
}

fn parse_pairs(body: &Value, key: &str, valid: fn(&str) -> bool, what: &str) -> Result<Vec<Pair>, ApiError> {
    let Some(list) = body.get(key) else {
        return Ok(Vec::new());
    };
    if list.is_null() {
        return Ok(Vec::new());
    }
    let list = list
        .as_array()
        .ok_or_else(|| bad(format!("{key} must be an array")))?;
    let mut out: Vec<Pair> = Vec::new();
    for item in list {
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if !valid(&name) {
            return Err(bad(format!("invalid {what} name")));
        }
        let value = item
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if value.contains(['\r', '\n', '\0']) {
            return Err(bad(format!("{what} value must be a single line")));
        }
        let secret = item.get("secret").and_then(Value::as_bool).unwrap_or(false);
        let dup = out.iter().any(|p| {
            if key == "headers" {
                p.name.eq_ignore_ascii_case(&name)
            } else {
                p.name == name
            }
        });
        if dup {
            return Err(bad(format!("duplicate {what} name")));
        }
        out.push(Pair { name, value, secret });
    }
    Ok(out)
}

/// A non-secret literal may not reference vault variables of another server.
fn check_literal(slug: &str, text: &str) -> Result<(), ApiError> {
    let own = env_var_for(slug, "");
    for var in placeholders_in(text) {
        if var.starts_with("AMIRO_CRED_") && !var.starts_with(&own) {
            return Err(bad("values may only reference this connector's own secrets"));
        }
    }
    Ok(())
}

struct Plan {
    slug: String,
    entry: Value,
    /// (field, label, new value) for secrets; empty value keeps the vault value.
    secrets: Vec<(String, String, String)>,
}

fn plan_custom(body: &Value, existing: Option<&Value>) -> Result<Plan, ApiError> {
    let slug = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if slug == COMPOSIO {
        return Err(bad("the name \"composio\" is reserved"));
    }
    if !is_valid_slug(&slug) {
        return Err(bad("name must be 1-40 characters of a-z, 0-9 and -"));
    }
    let transport = body.get("transport").and_then(Value::as_str).unwrap_or("");
    let headers = parse_pairs(body, "headers", is_valid_header_name, "header")?;
    let env = parse_pairs(body, "env", is_valid_env_name, "env")?;

    let mut entry = Map::new();
    let mut secrets: Vec<(String, String, String)> = Vec::new();
    let mut fields: HashSet<String> = HashSet::new();
    let mut resolve = |pair: &Pair, section: &str| -> Result<String, ApiError> {
        if !pair.secret {
            // Blank non-secret on edit: the UI never receives values, so keep
            // the entry's current one.
            if pair.value.is_empty() {
                let current = existing
                    .and_then(|e| e.get(section))
                    .and_then(Value::as_object)
                    .and_then(|m| {
                        m.iter()
                            .find(|(k, _)| k.eq_ignore_ascii_case(&pair.name))
                            .and_then(|(_, v)| v.as_str())
                    });
                if let Some(current) = current {
                    return Ok(current.to_string());
                }
            }
            check_literal(&slug, &pair.value)?;
            return Ok(pair.value.clone());
        }
        let field = field_for(&pair.name);
        if field.is_empty() || !fields.insert(field.clone()) {
            return Err(bad("two secrets map to the same vault field"));
        }
        secrets.push((field.clone(), pair.name.clone(), pair.value.clone()));
        Ok(placeholder(&slug, &field))
    };

    match transport {
        "http" | "sse" => {
            let url = body.get("url").and_then(Value::as_str).unwrap_or("").trim();
            if url.is_empty() {
                return Err(bad("url is required"));
            }
            validate_remote_url(url)?;
            check_literal(&slug, url)?;
            if !env.is_empty() {
                return Err(bad("env is only valid for stdio connectors"));
            }
            entry.insert(
                "type".into(),
                json!(if transport == "http" { "streamable-http" } else { "sse" }),
            );
            entry.insert("url".into(), json!(url));
            if !headers.is_empty() {
                let mut map = Map::new();
                for pair in &headers {
                    map.insert(pair.name.clone(), json!(resolve(pair, "headers")?));
                }
                entry.insert("headers".into(), Value::Object(map));
            }
        }
        "stdio" => {
            let command = body
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if command.is_empty() {
                return Err(bad("command is required for stdio connectors"));
            }
            check_literal(&slug, command)?;
            if !headers.is_empty() {
                return Err(bad("headers are only valid for http/sse connectors"));
            }
            entry.insert("command".into(), json!(command));
            if let Some(args) = body.get("args").filter(|a| !a.is_null()) {
                let args = args.as_array().ok_or_else(|| bad("args must be an array"))?;
                let mut list = Vec::new();
                for arg in args {
                    let arg = arg.as_str().ok_or_else(|| bad("args must be strings"))?;
                    check_literal(&slug, arg)?;
                    list.push(json!(arg));
                }
                if !list.is_empty() {
                    entry.insert("args".into(), Value::Array(list));
                }
            }
            if !env.is_empty() {
                let mut map = Map::new();
                for pair in &env {
                    map.insert(pair.name.clone(), json!(resolve(pair, "env")?));
                }
                entry.insert("env".into(), Value::Object(map));
            }
        }
        _ => return Err(bad("transport must be http, sse or stdio")),
    }
    entry.insert("shared".into(), json!(true));
    // Editing keeps the enable/disable state.
    if let Some(existing) = existing {
        for key in ["enabled", "disabled"] {
            if let Some(v) = existing.get(key) {
                entry.insert(key.into(), v.clone());
            }
        }
    }
    Ok(Plan {
        slug,
        entry: Value::Object(entry),
        secrets,
    })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list(State(state): State<AppState>, _user: AuthUser) -> Result<Json<Value>, ApiError> {
    if let Err(error) = migrate_legacy(&state).await {
        tracing::warn!("legacy MCP migration failed: {}", error.1);
    }
    Ok(Json(servers_payload(&state).await?))
}

async fn upsert_custom(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let name_hint = body.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let existing = if is_valid_slug(&name_hint) {
        read_server(&state, &name_hint).await?
    } else {
        None
    };
    let plan = plan_custom(&body, existing.as_ref())?;
    let service = vault_service(&plan.slug);

    for (field, label, value) in &plan.secrets {
        if value.is_empty() {
            continue;
        }
        credentials::set(&state, &service, field, value, Some(label)).await?;
    }
    write_mcp_entry_named(&state, &plan.slug, Some(&plan.entry)).await?;

    // Drop vault values the edited entry no longer references.
    if let Some(old) = existing.as_ref() {
        let keep: HashSet<String> = plan.secrets.iter().map(|(f, _, _)| f.clone()).collect();
        for old_ref in secret_refs(&plan.slug, old) {
            if !keep.contains(&old_ref.field) {
                let _ = credentials::delete(&state, &service, &old_ref.field).await;
            }
        }
    }

    reload(&state).await;
    Ok(Json(server_response(&state, &plan.slug).await?))
}

async fn put_secrets(
    State(state): State<AppState>,
    user: AuthUser,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    if name == COMPOSIO || !is_valid_slug(&name) {
        return Err(bad("invalid connector name"));
    }
    let entry = read_server(&state, &name)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "connector not found".into()))?;
    let allowed: HashMap<String, SecretRef> = secret_refs(&name, &entry)
        .into_iter()
        .map(|s| (s.field.clone(), s))
        .collect();
    let provided = body
        .get("secrets")
        .and_then(Value::as_object)
        .ok_or_else(|| bad("secrets must be an object"))?;
    let mut writes: Vec<(&SecretRef, &str)> = Vec::new();
    for (field, value) in provided {
        let reference = allowed
            .get(field)
            .ok_or_else(|| bad(format!("unknown secret field \"{field}\"")))?;
        let value = value.as_str().unwrap_or("");
        if value.is_empty() {
            return Err(bad(format!("secret \"{field}\" must not be empty")));
        }
        writes.push((reference, strip_template_prefix(&reference.prefix, value)));
    }
    let service = vault_service(&name);
    for (reference, value) in writes {
        let label = reference
            .location
            .split_once(':')
            .map(|(_, n)| n.to_string())
            .unwrap_or_else(|| reference.field.clone());
        credentials::set(&state, &service, &reference.field, value, Some(&label)).await?;
    }
    reload(&state).await;
    Ok(Json(server_response(&state, &name).await?))
}

async fn set_enabled(
    State(state): State<AppState>,
    user: AuthUser,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let enabled = body
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| bad("enabled must be a boolean"))?;
    let (found, _) = mutate_mcp_servers(&state, Some(&name), |servers| {
        match servers.get_mut(&name).and_then(Value::as_object_mut) {
            Some(entry) => {
                entry.insert("enabled".into(), json!(enabled));
                entry.remove("disabled");
                true
            }
            None => false,
        }
    })
    .await?;
    if !found {
        return Err(ApiError(StatusCode::NOT_FOUND, "connector not found".into()));
    }
    reload(&state).await;
    Ok(Json(server_response(&state, &name).await?))
}

async fn delete_custom(
    State(state): State<AppState>,
    user: AuthUser,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    if name == COMPOSIO || !is_valid_slug(&name) {
        return Err(bad("invalid connector name"));
    }
    let (removed, _) = mutate_mcp_servers(&state, Some(&name), |servers| servers.remove(&name)).await?;
    let Some(entry) = removed else {
        return Err(ApiError(StatusCode::NOT_FOUND, "connector not found".into()));
    };
    let service = vault_service(&name);
    let mut fields: HashSet<String> = secret_refs(&name, &entry).into_iter().map(|s| s.field).collect();
    if let Ok(items) = credentials::list_metadata(&state).await {
        fields.extend(items.into_iter().filter(|m| m.service == service).map(|m| m.field));
    }
    for field in fields {
        let _ = credentials::delete(&state, &service, &field).await;
    }
    reload(&state).await;
    Ok(Json(json!({ "success": true })))
}

async fn reload_route(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let outcome = reload(&state).await;
    let mut payload = servers_payload(&state).await?;
    payload["reloaded"] = json!(outcome.reloaded());
    payload["reloadedSessions"] = json!(outcome.reloaded_sessions);
    payload["skippedBusy"] = json!(outcome.skipped_busy);
    Ok(Json(payload))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/connectors", get(list))
        .route("/api/connectors/custom", post(upsert_custom))
        .route("/api/connectors/custom/{name}/secrets", put(put_secrets))
        .route("/api/connectors/custom/{name}", delete(delete_custom))
        .route("/api/connectors/{name}/enabled", post(set_enabled))
        .route("/api/connectors/reload", post(reload_route))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;

    fn state() -> AppState {
        let root = std::env::temp_dir().join(format!("amiro-connectors-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        AppState {
            home,
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("amiro-api.sock"),
            workspace: root.join("workspace"),
            runtime_bin: root.join("amiro-runtime"),
            token: String::new(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    #[test]
    fn repeated_template_prefix_is_stripped() {
        assert_eq!(strip_template_prefix("Bearer ", "Bearer abc123"), "abc123");
        assert_eq!(strip_template_prefix("Bearer ", "bearer   abc123 "), "abc123");
        assert_eq!(strip_template_prefix("Bearer ", "abc123"), "abc123");
        assert_eq!(strip_template_prefix("", "Bearer abc123"), "Bearer abc123");
        assert_eq!(strip_template_prefix("Bearer ", "Bearer"), "Bearer");
        let entry = json!({"headers": {"Authorization": "Bearer ${AMIRO_CRED_MCP_DEMO_AUTHORIZATION}"}});
        let refs = secret_refs("demo", &entry);
        assert_eq!(refs[0].prefix, "Bearer ");
    }

    #[test]
    fn slug_validation() {
        assert!(is_valid_slug("my-server"));
        assert!(is_valid_slug("a1"));
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("My-Server"));
        assert!(!is_valid_slug("my_server"));
        assert!(!is_valid_slug(&"a".repeat(41)));
        assert!(is_valid_slug(&"a".repeat(40)));
        assert_eq!(slugify("My Cool_Server!!"), "my-cool-server");
    }

    #[test]
    fn secret_storage_naming() {
        assert_eq!(
            env_var_for("my-server", "authorization"),
            "AMIRO_CRED_MCP_MY_SERVER_AUTHORIZATION"
        );
        assert_eq!(field_for("X-Api-Key"), "x_api_key");
        assert_eq!(vault_service("my-server"), "mcp.my-server");
        assert_eq!(
            placeholder("my-server", "authorization"),
            "${AMIRO_CRED_MCP_MY_SERVER_AUTHORIZATION}"
        );
    }

    #[test]
    fn placeholder_derivation_covers_every_location() {
        let entry = json!({
            "type": "streamable-http",
            "url": "https://x.example/mcp?k=${AMIRO_CRED_MCP_MY_SERVER_QUERY_KEY}",
            "args": ["--token", "${AMIRO_CRED_MCP_MY_SERVER_ARG_TOKEN}"],
            "headers": {
                "Authorization": "Bearer ${AMIRO_CRED_MCP_MY_SERVER_AUTHORIZATION}",
                "X-Plain": "literal",
                "X-Other": "${AMIRO_CRED_MCP_OTHER_TOKEN}"
            },
            "env": {"GITHUB_TOKEN": "${AMIRO_CRED_MCP_MY_SERVER_GITHUB_TOKEN}"}
        });
        let refs = secret_refs("my-server", &entry);
        let find = |f: &str| refs.iter().find(|r| r.field == f).map(|r| r.location.clone());
        assert_eq!(find("query_key").as_deref(), Some("url"));
        assert_eq!(find("arg_token").as_deref(), Some("arg"));
        assert_eq!(find("authorization").as_deref(), Some("header:Authorization"));
        assert_eq!(find("github_token").as_deref(), Some("env:GITHUB_TOKEN"));
        // Another server's secret is not this server's.
        assert_eq!(refs.len(), 4);
    }

    #[test]
    fn server_json_never_exposes_values_and_derives_status() {
        let entry = json!({
            "type": "streamable-http",
            "url": "https://x.example/mcp",
            "headers": {"Authorization": "Bearer ${AMIRO_CRED_MCP_S_AUTHORIZATION}", "X-Lit": "super-secret-literal"},
        });
        let none = HashSet::new();
        let server = build_server("s", &entry, &none, None);
        assert_eq!(server["status"], "needs-secret");
        assert!(!server.to_string().contains("super-secret-literal"));
        assert_eq!(server["headerNames"], json!(["Authorization", "X-Lit"]));
        let mut vars = HashSet::new();
        vars.insert("AMIRO_CRED_MCP_S_AUTHORIZATION".to_string());
        assert_eq!(build_server("s", &entry, &vars, None)["status"], "unknown");
        let ok = json!({"name":"s","connected":true,"tools":[{"name":"t","description":"d"}]});
        let connected = build_server("s", &entry, &vars, Some(&ok));
        assert_eq!(connected["status"], "connected");
        assert_eq!(connected["tools"][0]["name"], "t");
        let bad_status = json!({"name":"s","connected":false,"error":"boom"});
        let errored = build_server("s", &entry, &vars, Some(&bad_status));
        assert_eq!((errored["status"].clone(), errored["error"].clone()), (json!("error"), json!("boom")));
        let pending = build_server(
            "s",
            &json!({"url": "http://x/mcp"}),
            &HashSet::new(),
            Some(&json!({"name":"s","connected":false,"error":null})),
        );
        assert_eq!(pending["status"], "unknown");
        let disabled = json!({"type":"sse","url":"https://x.example","enabled":false});
        assert_eq!(build_server("s", &disabled, &none, None)["status"], "disabled");
    }

    #[test]
    fn custom_input_validation() {
        let ok = json!({"name":"my-server","transport":"http","url":"https://x.example/mcp",
            "headers":[{"name":"Authorization","value":"Bearer t","secret":true},{"name":"X-A","value":"1","secret":false}]});
        let plan = plan_custom(&ok, None).unwrap();
        assert_eq!(
            plan.entry["headers"]["Authorization"],
            "${AMIRO_CRED_MCP_MY_SERVER_AUTHORIZATION}"
        );
        assert_eq!(plan.entry["headers"]["X-A"], "1");
        assert_eq!(plan.entry["type"], "streamable-http");
        assert_eq!(plan.secrets[0].0, "authorization");

        let cases = [
            json!({"name":"composio","transport":"http","url":"https://x.example"}),
            json!({"name":"Bad Name","transport":"http","url":"https://x.example"}),
            json!({"name":"a","transport":"http","url":"ftp://x.example"}),
            json!({"name":"a","transport":"http","url":"https://user:pw@x.example"}),
            json!({"name":"a","transport":"http","url":"https://x.example/#f"}),
            json!({"name":"a","transport":"http"}),
            json!({"name":"a","transport":"stdio"}),
            json!({"name":"a","transport":"nope"}),
            json!({"name":"a","transport":"http","url":"https://x.example","headers":[{"name":"Bad Header","value":"x"}]}),
            json!({"name":"a","transport":"stdio","command":"x","env":[{"name":"lower","value":"x"}]}),
            json!({"name":"a","transport":"http","url":"https://x.example","headers":[{"name":"X","value":"${AMIRO_CRED_MCP_OTHER_TOKEN}"}]}),
        ];
        for case in cases {
            assert!(plan_custom(&case, None).is_err(), "{case}");
        }
        let stdio = json!({"name":"a","transport":"stdio","command":"npx","args":["-y","pkg"],
            "env":[{"name":"GITHUB_TOKEN","value":"t","secret":true}]});
        let plan = plan_custom(&stdio, None).unwrap();
        assert!(plan.entry.get("type").is_none());
        assert_eq!(plan.entry["env"]["GITHUB_TOKEN"], "${AMIRO_CRED_MCP_A_GITHUB_TOKEN}");
    }

    #[tokio::test]
    async fn write_preserves_other_entries_and_top_level_keys() {
        let state = state();
        write_json(
            &mcp_config_path(&state),
            &json!({"mcpServers": {"keep": {"command": "x"}}, "extra": {"a": 1}}),
        )
        .await
        .unwrap();
        let entry = json!({"type": "sse", "url": "https://x.example"});
        assert!(write_mcp_entry_named(&state, "new", Some(&entry)).await.unwrap());
        // Unchanged write is a no-op.
        assert!(!write_mcp_entry_named(&state, "new", Some(&entry)).await.unwrap());
        let doc = read_json(&mcp_config_path(&state), json!({})).await.unwrap();
        assert_eq!(doc["mcpServers"]["keep"], json!({"command": "x"}));
        assert_eq!(doc["mcpServers"]["new"], entry);
        assert_eq!(doc["extra"], json!({"a": 1}));
        assert!(doc.get("servers").is_none());
        write_mcp_entry_named(&state, "new", None).await.unwrap();
        let doc = read_json(&mcp_config_path(&state), json!({})).await.unwrap();
        assert!(doc["mcpServers"].get("new").is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(mcp_config_path(&state)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[tokio::test]
    async fn legacy_store_is_migrated_once() {
        let state = state();
        let legacy = state.home.join("store").join(LEGACY_FILE);
        write_json(
            &legacy,
            &json!({
                "1": {"id":"1","name":"My Remote","userId":"u","config":{"url":"https://r.example/mcp","headers":{"Authorization":"Bearer literal"}}},
                "2": {"id":"2","name":"Local Tool","userId":"u","config":{"command":"npx","args":["-y","p"],"env":{"K":"v"}}},
                "3": {"id":"3","name":"exists","userId":"u","config":{"url":"https://other.example"}},
                "4": {"id":"4","name":"composio","userId":"u","config":{"url":"https://other.example"}},
            }),
        )
        .await
        .unwrap();
        write_mcp_entry_named(&state, "exists", Some(&json!({"url":"https://keep.example"})))
            .await
            .unwrap();
        assert_eq!(migrate_legacy(&state).await.unwrap(), 2);
        let doc = read_json(&mcp_config_path(&state), json!({})).await.unwrap();
        assert_eq!(doc["servers"]["my-remote"]["url"], "https://r.example/mcp");
        assert_eq!(doc["servers"]["my-remote"]["headers"]["Authorization"], "Bearer literal");
        assert_eq!(doc["servers"]["local-tool"]["command"], "npx");
        assert_eq!(doc["servers"]["exists"]["url"], "https://keep.example");
        assert!(doc["servers"].get("composio").is_none());
        assert!(!legacy.exists());
        assert!(state.home.join("store").join(LEGACY_MIGRATED_FILE).exists());
        assert_eq!(migrate_legacy(&state).await.unwrap(), 0);
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(body) => {
                request = request.header("Content-Type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = app.clone().oneshot(request.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn custom_connector_lifecycle_over_http() {
        let state = state();
        write_json(
            &state.home.join("users.json"),
            &json!({"users":[{"id":"a","role":"admin"},{"id":"u","role":"user"}]}),
        )
        .await
        .unwrap();
        write_json(
            &state.home.join("sessions.json"),
            &json!({"sessions":{
                "admin":{"userId":"a","createdAt":crate::state::now_iso()},
                "user":{"userId":"u","createdAt":crate::state::now_iso()}}}),
        )
        .await
        .unwrap();
        let app = routes().with_state(state.clone());

        let create = json!({"name":"my-server","transport":"http","url":"https://x.example/mcp",
            "headers":[{"name":"Authorization","value":"","secret":true}]});
        let (status, _) = call(&app, "POST", "/api/connectors/custom", "user", Some(create.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, server) = call(&app, "POST", "/api/connectors/custom", "admin", Some(create)).await;
        assert_eq!(status, StatusCode::OK, "{server}");
        assert_eq!(server["status"], "needs-secret");
        assert_eq!(server["secrets"][0]["envVar"], "AMIRO_CRED_MCP_MY_SERVER_AUTHORIZATION");
        assert_eq!(server["secrets"][0]["location"], "header:Authorization");

        let (status, bad_field) = call(
            &app, "PUT", "/api/connectors/custom/my-server/secrets", "admin",
            Some(json!({"secrets":{"nope":"x"}})),
        ).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad_field}");

        let (status, server) = call(
            &app, "PUT", "/api/connectors/custom/my-server/secrets", "admin",
            Some(json!({"secrets":{"authorization":"Bearer tok-123"}})),
        ).await;
        assert_eq!(status, StatusCode::OK, "{server}");
        assert_eq!(server["secrets"][0]["present"], true);

        let (status, list) = call(&app, "GET", "/api/connectors", "user", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["statusAvailable"], false);
        let listed = list["servers"].as_array().unwrap().iter().find(|s| s["name"] == "my-server").unwrap();
        assert_eq!(listed["source"], "custom");
        assert_eq!(listed["status"], "unknown");
        assert_eq!(listed["secrets"][0]["present"], true);
        assert!(!list.to_string().contains("tok-123"));

        // Secret reached credential-env.json for the runtime.
        let env: Value = serde_json::from_slice(
            &std::fs::read(state.runtime_home.join("credential-env.json")).unwrap(),
        ).unwrap();
        assert_eq!(env["AMIRO_CRED_MCP_MY_SERVER_AUTHORIZATION"], "Bearer tok-123");

        // Editing without retyping the secret keeps the vault value.
        let (_, edited) = call(&app, "POST", "/api/connectors/custom", "admin", Some(json!({
            "name":"my-server","transport":"http","url":"https://y.example/mcp",
            "headers":[{"name":"Authorization","value":"","secret":true}]}))).await;
        assert_eq!(edited["secrets"][0]["present"], true);
        assert_eq!(edited["url"], "https://y.example/mcp");

        // Blank non-secret value on edit keeps the current literal; omitted entries go.
        call(&app, "POST", "/api/connectors/custom", "admin", Some(json!({
            "name":"my-server","transport":"http","url":"https://y.example/mcp",
            "headers":[{"name":"Authorization","value":"","secret":true},
                       {"name":"X-Lit","value":"keep-me","secret":false},
                       {"name":"X-Drop","value":"gone","secret":false}]}))).await;
        call(&app, "POST", "/api/connectors/custom", "admin", Some(json!({
            "name":"my-server","transport":"http","url":"https://y.example/mcp",
            "headers":[{"name":"Authorization","value":"","secret":true},
                       {"name":"X-Lit","value":"","secret":false}]}))).await;
        let doc = read_json(&mcp_config_path(&state), json!({})).await.unwrap();
        assert_eq!(doc["servers"]["my-server"]["headers"]["X-Lit"], "keep-me");
        assert!(doc["servers"]["my-server"]["headers"].get("X-Drop").is_none());

        let (_, off) = call(&app, "POST", "/api/connectors/my-server/enabled", "admin", Some(json!({"enabled":false}))).await;
        assert_eq!(off["status"], "disabled");
        let (status, _) = call(&app, "POST", "/api/connectors/missing/enabled", "admin", Some(json!({"enabled":true}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, reloaded) = call(&app, "POST", "/api/connectors/reload", "admin", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reloaded["reloaded"], false);
        assert!(reloaded["servers"].is_array());

        let (status, _) = call(&app, "DELETE", "/api/connectors/custom/my-server", "admin", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(credentials::get_plaintext(&state, "mcp.my-server", "authorization").await.unwrap().is_none());
        let (_, list) = call(&app, "GET", "/api/connectors", "admin", None).await;
        assert!(list["servers"].as_array().unwrap().is_empty());
        let (status, _) = call(&app, "DELETE", "/api/connectors/custom/composio", "admin", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
