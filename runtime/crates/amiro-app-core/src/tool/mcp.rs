//! MCP management tool - stdio/remote connections and noninteractive OAuth management

#[cfg(test)]
#[path = "mcp_remote_management_tests.rs"]
mod remote_management_tests;

use crate::mcp::{ContentBlock, McpManager, McpServerConfig, dispatch_name};
use crate::tool::{Tool, ToolContext, ToolOutput};
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Deserialize)]
struct McpSearchInput {
    #[serde(default)]
    server: Option<String>,
    #[serde(default)]
    query: Option<String>,
}

#[derive(Debug, Serialize)]
struct McpSearchResult {
    name: String,
    server: String,
    tool: String,
    description: String,
    input_schema: Value,
}

/// Upper bound on definitions one `mcp_search` call loads into context via
/// tool references, so an empty or broad query cannot pull in a whole catalog.
const MAX_SEARCH_TOOL_REFERENCES: usize = 32;

/// Token budget for one `mcp_search` result. Descriptions and schemas are
/// fitted to it adaptively: a narrow query keeps everything, a broad one
/// trims long descriptions first, then drops schemas for lower matches.
const SEARCH_TOKEN_BUDGET: usize = 6_000;

/// Shortest a description is clipped to when fitting the search budget.
const MIN_SEARCH_DESCRIPTION_CHARS: usize = 120;

/// Clip `text` to `max` chars on a char boundary, marking the cut.
fn clip_description(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// How well a tool matches a search query. Name matches outrank description
/// matches, so a query like "calendar" does not return every tool whose
/// documentation merely mentions a calendar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchRank {
    Description,
    Name,
}

fn match_rank(
    query_terms: &[String],
    name: &str,
    server: &str,
    tool: &str,
    description: &str,
) -> Option<MatchRank> {
    if query_terms.is_empty() {
        return Some(MatchRank::Name);
    }
    let names = format!("{name} {server} {tool}").to_ascii_lowercase();
    if query_terms.iter().all(|term| names.contains(term.as_str())) {
        return Some(MatchRank::Name);
    }
    let all = format!("{names} {}", description.to_ascii_lowercase());
    query_terms
        .iter()
        .all(|term| all.contains(term.as_str()))
        .then_some(MatchRank::Description)
}

/// Render search matches within `budget` tokens. Tries the loosest settings
/// first: every match in full, then shorter descriptions, then full detail for
/// only the leading matches with the rest listed by name. The first rendering
/// that fits wins, so small results are never trimmed.
fn fit_search_results(matches: &[McpSearchResult], budget: usize) -> Result<(String, usize)> {
    use amiro_core::util::estimate_tokens;
    let render = |detailed: usize, description_chars: Option<usize>| -> Result<String> {
        let head: Vec<McpSearchResult> = matches[..detailed]
            .iter()
            .map(|m| McpSearchResult {
                name: m.name.clone(),
                server: m.server.clone(),
                tool: m.tool.clone(),
                description: description_chars.map_or_else(
                    || m.description.clone(),
                    |max| clip_description(&m.description, max),
                ),
                input_schema: m.input_schema.clone(),
            })
            .collect();
        let mut out = serde_json::to_string(&head)?;
        if detailed < matches.len() {
            let rest: Vec<&str> = matches[detailed..]
                .iter()
                .map(|m| m.name.as_str())
                .collect();
            out.push_str(&format!(
                "\n\n{} more matches (names only; search for one by name for its schema): {}",
                rest.len(),
                rest.join(", ")
            ));
        }
        Ok(out)
    };
    let fits = |out: &String| estimate_tokens(out) <= budget;

    let full = render(matches.len(), None)?;
    if fits(&full) {
        return Ok((full, matches.len()));
    }
    // Shorten descriptions progressively, keeping every schema.
    let longest = matches
        .iter()
        .map(|m| m.description.chars().count())
        .max()
        .unwrap_or(0);
    let mut chars = longest / 2;
    while chars >= MIN_SEARCH_DESCRIPTION_CHARS {
        let out = render(matches.len(), Some(chars))?;
        if fits(&out) {
            return Ok((out, matches.len()));
        }
        chars /= 2;
    }
    // Keep full detail for as many leading matches as fit.
    let (mut lo, mut hi) = (0usize, matches.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if fits(&render(mid, Some(MIN_SEARCH_DESCRIPTION_CHARS))?) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Ok((render(lo, Some(MIN_SEARCH_DESCRIPTION_CHARS))?, lo))
}

/// Fixed MCP discovery surface used when individual server definitions are deferred.
pub struct McpSearchTool {
    manager: Arc<RwLock<McpManager>>,
    registry: Option<super::WeakRegistry>,
}

impl McpSearchTool {
    pub fn new(manager: Arc<RwLock<McpManager>>) -> Self {
        Self {
            manager,
            registry: None,
        }
    }

    pub fn with_registry(mut self, registry: crate::tool::Registry) -> Self {
        self.registry = Some(registry.downgrade());
        self
    }
}

#[async_trait]
impl Tool for McpSearchTool {
    fn name(&self) -> &str {
        "mcp_search"
    }

    fn description(&self) -> &str {
        "Search available MCP tools by server, name, or description. Returns callable names and input schemas."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server": {
                    "type": "string",
                    "description": "Optional exact MCP server name."
                },
                "query": {
                    "type": "string",
                    "description": "Optional case-insensitive name or description search."
                }
            }
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput> {
        let input_flags = input.clone();
        let params: McpSearchInput = serde_json::from_value(input)?;
        let server_filter = params
            .server
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        // Tokenize the optional query directly, avoiding a lowercased copy of
        // the entire query and an artificial empty-query sentinel.
        let query_terms: Vec<String> = params
            .query
            .iter()
            .flat_map(|query| query.split_whitespace().map(str::to_ascii_lowercase))
            .collect();
        let manager = self.manager.read().await;
        let catalog = manager.searchable_tools().await;
        drop(manager);

        let names = crate::mcp::dispatch_names(&catalog);
        let ranked: Vec<(MatchRank, McpSearchResult)> = catalog
            .into_iter()
            .zip(names)
            .filter_map(|((server, tool), name)| {
                if server_filter.is_some_and(|wanted| wanted != server) {
                    return None;
                }
                let legacy_name = dispatch_name(&server, &tool.name);
                let allowed = self
                    .registry
                    .as_ref()
                    .and_then(|r| r.upgrade())
                    .map_or_else(
                        || {
                            super::session_mcp_alias_is_allowed(
                                &ctx.session_id,
                                &name,
                                &legacy_name,
                                "mcp_search",
                            )
                        },
                        |r| {
                            r.mcp_dispatch_is_allowed(
                                &ctx.session_id,
                                &server,
                                &tool.name,
                                &name,
                                "mcp_search",
                            )
                        },
                    );
                if !allowed {
                    return None;
                }
                let description = tool.description.as_deref().unwrap_or_default();
                let rank = match_rank(&query_terms, &name, &server, &tool.name, description)?;
                Some((
                    rank,
                    McpSearchResult {
                        name,
                        server,
                        tool: tool.name,
                        description: tool
                            .description
                            .unwrap_or_else(|| "MCP tool".to_string())
                            .trim()
                            .to_string(),
                        input_schema: tool.input_schema,
                    },
                ))
            })
            .collect();

        // Name matches win. Description-only matches are noise once any tool
        // matches by name, so they are dropped rather than ranked below.
        let best = ranked.iter().map(|(rank, _)| *rank).max();
        let matches: Vec<McpSearchResult> = ranked
            .into_iter()
            .filter(|(rank, _)| Some(*rank) == best)
            .map(|(_, result)| result)
            .collect();
        let total = matches.len();
        let budget = if super::accepts_large_output(&input_flags) {
            usize::MAX
        } else {
            SEARCH_TOKEN_BUDGET
        };
        let (output, detailed) = fit_search_results(&matches, budget)?;

        // Ask the agent to load the matched definitions natively. With
        // provider-native deferred loading these become directly callable
        // tools without changing the cached prompt prefix; other providers
        // ignore the references and use `mcp_call` with the schemas above.
        let references: Vec<&str> = matches[..detailed]
            .iter()
            .take(MAX_SEARCH_TOOL_REFERENCES)
            .map(|m| m.name.as_str())
            .collect();
        Ok(ToolOutput::new(output)
            .with_title(format!("MCP tools ({})", total))
            .with_metadata(json!({ "tool_references": references })))
    }
}

#[derive(Debug, Deserialize)]
struct McpCallInput {
    server: String,
    tool: String,
    #[serde(default)]
    arguments: Value,
}

/// Fixed MCP execution surface used when individual server definitions are deferred.
pub struct McpCallTool {
    manager: Arc<RwLock<McpManager>>,
    registry: Option<super::WeakRegistry>,
}

impl McpCallTool {
    pub fn new(manager: Arc<RwLock<McpManager>>) -> Self {
        Self {
            manager,
            registry: None,
        }
    }

    pub fn with_registry(mut self, registry: crate::tool::Registry) -> Self {
        self.registry = Some(registry.downgrade());
        self
    }
}

#[async_trait]
impl Tool for McpCallTool {
    fn name(&self) -> &str {
        "mcp_call"
    }

    fn description(&self) -> &str {
        "Call an MCP server tool discovered with mcp_search."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server": {"type": "string", "description": "MCP server name."},
                "tool": {"type": "string", "description": "Raw MCP tool name."},
                "arguments": {
                    "type": "object",
                    "additionalProperties": true,
                    "description": "Arguments matching the input schema returned by mcp_search."
                }
            },
            "required": ["server", "tool", "arguments"]
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput> {
        let input_flags = input.clone();
        let mut params: McpCallInput = serde_json::from_value(input)?;
        let dispatched_name = dispatch_name(&params.server, &params.tool);
        // Check the current alias too: a per-alias deny must not be bypassed
        // by spelling the original server/tool pair through mcp_call.
        let catalog = self.manager.read().await.searchable_tools().await;
        let names = crate::mcp::dispatch_names(&catalog);
        let alias = catalog
            .iter()
            .zip(&names)
            .find(|((server, tool), _)| server == &params.server && tool.name == params.tool)
            .map(|(_, alias)| alias.as_str())
            .unwrap_or(&dispatched_name);
        let allowed = self
            .registry
            .as_ref()
            .and_then(|r| r.upgrade())
            .map_or_else(
                || {
                    super::session_mcp_alias_is_allowed(
                        &ctx.session_id,
                        alias,
                        &dispatched_name,
                        "mcp_call",
                    )
                },
                |r| {
                    r.mcp_dispatch_is_allowed(
                        &ctx.session_id,
                        &params.server,
                        &params.tool,
                        alias,
                        "mcp_call",
                    )
                },
            );
        if !allowed {
            anyhow::bail!("MCP tool '{}' is not allowed", alias);
        }
        if params.arguments.is_null() {
            params.arguments = Value::Object(serde_json::Map::new());
        }
        // The escape hatch may arrive at either level; never forward it.
        let accept_large_output = super::accepts_large_output(&input_flags)
            | crate::mcp::take_accept_large_output(&mut params.arguments);

        // Deferred dispatch must honor the same session-local replacement as
        // eager and batched dispatch. Never fall through to the real MCP server
        // when the SDK owner has replaced this identity.
        let custom_name = if super::sdk::custom(&ctx.session_id, alias) {
            Some(alias)
        } else if super::sdk::custom(&ctx.session_id, &dispatched_name) {
            Some(dispatched_name.as_str())
        } else {
            None
        };
        if let Some(custom_name) = custom_name {
            let registry = self
                .registry
                .as_ref()
                .and_then(|r| r.upgrade())
                .ok_or_else(|| anyhow::anyhow!("SDK MCP override requires a live registry"))?;
            return registry.execute(custom_name, params.arguments, ctx).await;
        }

        let manager = self.manager.read().await;
        let result = manager
            .call_tool(&params.server, &params.tool, params.arguments)
            .await?;
        drop(manager);

        let mut output_parts = Vec::new();
        for block in result.content {
            match block {
                ContentBlock::Text { text } => output_parts.push(text),
                ContentBlock::Image { data, mime_type } => {
                    output_parts.push(format!("[Image: {} ({} bytes)]", mime_type, data.len()));
                }
                ContentBlock::Resource { resource } => {
                    if let Some(rendered) = crate::applets::mount_mcp_resource(
                        &ctx.session_id,
                        &ctx.tool_call_id,
                        &resource.uri,
                        resource.mime_type.as_deref(),
                        resource.text.as_deref(),
                    ) {
                        output_parts.push(rendered);
                    } else if let Some(text) = resource.text {
                        output_parts.push(text);
                    } else if let Some(blob) = resource.blob {
                        output_parts.push(format!(
                            "[Resource: {} ({} bytes)]",
                            resource.uri,
                            blob.len()
                        ));
                    } else {
                        output_parts.push(format!("[Resource: {}]", resource.uri));
                    }
                }
            }
        }
        let output = output_parts.join("\n");
        let output = if accept_large_output {
            output
        } else {
            crate::mcp::budget::fit_to_budget(&output, crate::mcp::budget::MCP_RESULT_TOKEN_BUDGET)
        };
        let title = format!("mcp:{}:{}", params.server, params.tool);
        if result.is_error {
            Ok(ToolOutput::new(format!("Error: {}", output)).with_title(title))
        } else {
            Ok(ToolOutput::new(output).with_title(title))
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct McpToolInput {
    action: String,
    #[serde(default)]
    server: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Option<Vec<String>>,
    #[serde(default)]
    env: Option<HashMap<String, String>>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: Option<HashMap<String, String>>,
    #[serde(default)]
    transport: Option<String>,
    #[serde(default)]
    secrets: Option<Vec<McpSecretSpec>>,
}

/// One secret the user (not the model) supplies through the secure card.
/// Exactly one of `header` / `env` names where the value is injected.
#[derive(Debug, Clone, Deserialize)]
struct McpSecretSpec {
    key: String,
    #[serde(default)]
    header: Option<String>,
    #[serde(default)]
    env: Option<String>,
    #[serde(default)]
    prefix: Option<String>,
}

fn connection_config(
    params: &McpToolInput,
    configured: Option<McpServerConfig>,
) -> Result<McpServerConfig> {
    if params.command.is_some() && params.url.is_some() {
        anyhow::bail!("Supply either 'command' for stdio or 'url' for remote MCP, not both");
    }
    if params.command.is_none() && params.url.is_none() {
        if params.args.is_some()
            || params.env.is_some()
            || params.headers.is_some()
            || params.transport.is_some()
        {
            anyhow::bail!(
                "Connection overrides require an explicit 'command' or 'url'; omit them to use the configured server"
            );
        }
        return configured.ok_or_else(|| anyhow::anyhow!("'command' or 'url' is required for connect action (server is not in the MCP config)"));
    }
    if let Some(url) = params.url.as_deref() {
        if params.args.is_some() || params.env.is_some() {
            anyhow::bail!("'args' and 'env' are only supported for stdio MCP servers");
        }
        let transport = params.transport.as_deref().unwrap_or("http");
        if !matches!(transport, "http" | "streamable-http" | "sse") {
            anyhow::bail!("Remote 'transport' must be 'http', 'streamable-http', or 'sse'");
        }
        validate_remote_url(url)?;
    } else {
        if params
            .command
            .as_deref()
            .is_none_or(|command| command.trim().is_empty())
        {
            anyhow::bail!("'command' must not be empty");
        }
        if params.headers.is_some()
            || params
                .transport
                .as_deref()
                .is_some_and(|transport| transport != "stdio")
        {
            anyhow::bail!("'headers' and remote transports require 'url'");
        }
    }
    Ok(McpServerConfig {
        command: params.command.clone().unwrap_or_default(),
        args: params.args.clone().unwrap_or_default(),
        env: params.env.clone().unwrap_or_default(),
        shared: true,
        transport: params.transport.clone(),
        url: params.url.clone(),
        headers: params.headers.clone().unwrap_or_default(),
        enabled: None,
        disabled: None,
        timeout_secs: None,
    })
}

fn validate_remote_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value).map_err(|_| anyhow::anyhow!("Invalid remote MCP URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        anyhow::bail!(
            "Remote MCP URL must be HTTP(S), without embedded user credentials or a fragment"
        );
    }
    Ok(())
}


// ---------------------------------------------------------------------------
// Persistent connector setup (`add` / `remove`)
// ---------------------------------------------------------------------------

/// Connector managed by the Connectors page; the agent must not replace it.
const MANAGED_SERVER: &str = "composio";

type SessionManagers = std::sync::Mutex<HashMap<String, std::sync::Weak<RwLock<McpManager>>>>;

fn session_managers() -> &'static SessionManagers {
    static MANAGERS: std::sync::OnceLock<SessionManagers> = std::sync::OnceLock::new();
    MANAGERS.get_or_init(Default::default)
}

/// Record a session's MCP manager so lock-free runtime commands (for example
/// `mcp_status`) can reach it without taking the agent lock.
pub fn register_session_mcp_manager(session_id: &str, manager: &Arc<RwLock<McpManager>>) {
    if let Ok(mut managers) = session_managers().lock() {
        managers.retain(|_, weak| weak.strong_count() > 0);
        managers.insert(session_id.to_string(), Arc::downgrade(manager));
    }
}

/// The MCP manager registered for `session_id`, falling back to any live one
/// (the MCP config is user-level, so every session reports the same servers).
pub fn mcp_manager_for_session(session_id: &str) -> Option<Arc<RwLock<McpManager>>> {
    let managers = session_managers().lock().ok()?;
    managers
        .get(session_id)
        .and_then(std::sync::Weak::upgrade)
        .or_else(|| managers.values().find_map(std::sync::Weak::upgrade))
}

/// Whether a `mcp` tool call mutates persistent configuration or launches a
/// local process, and so needs user approval in the default permission mode.
/// `list` / `status` / `logout` / `reload` / `disconnect` and a by-name
/// `connect` of an already configured server stay read-only or pre-approved.
pub fn mcp_call_requires_approval(input: &Value) -> bool {
    match input.get("action").and_then(Value::as_str) {
        Some("add" | "remove") => true,
        Some("connect") => input.get("command").is_some_and(|c| !c.is_null()),
        _ => false,
    }
}

/// Normalize a connector name to a `[a-z0-9-]` slug of 1..=40 characters.
fn normalize_slug(name: &str) -> Result<String> {
    let mut slug = String::new();
    for ch in name.trim().chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() || slug.len() > 40 {
        anyhow::bail!("'server' must normalize to 1-40 characters of [a-z0-9-] (got '{name}')");
    }
    Ok(slug)
}

/// Secret field name: lowercased, anything outside `[a-z0-9_]` becomes `_`.
fn secret_field(key: &str) -> Result<String> {
    let field: String = key
        .trim()
        .chars()
        .flat_map(char::to_lowercase)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if field.is_empty() || field.len() > 64 {
        anyhow::bail!("secret 'key' must be 1-64 characters");
    }
    Ok(field)
}

fn env_token(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// `AMIRO_CRED_MCP_<SLUG>_<FIELD>`: matches the backend's vault naming
/// (service `mcp.<slug>` + field, uppercased, non-alphanumerics to `_`).
fn placeholder_var(slug: &str, field: &str) -> String {
    format!("AMIRO_CRED_MCP_{}_{}", env_token(slug), env_token(field))
}

/// Remove `${...}` references so only literal text is inspected.
fn strip_placeholders(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        match rest[start..].find('}') {
            Some(end) => rest = &rest[start + end + 1..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Heuristic for a token the model typed into a header/env value. `strict`
/// limits the check to well-known token prefixes (used for command args, which
/// legitimately contain long package names).
fn looks_like_literal_secret(value: &str, strict: bool) -> bool {
    let literal = strip_placeholders(value);
    let text = literal.trim();
    let lower = text.to_ascii_lowercase();
    const PREFIXES: &[&str] = &[
        "sk-", "ghp_", "gho_", "ghs_", "github_pat_", "xox", "glpat-", "akia", "aiza",
    ];
    if PREFIXES.iter().any(|prefix| lower.starts_with(prefix)) {
        return true;
    }
    for scheme in ["bearer ", "basic ", "token "] {
        if let Some(rest) = lower.strip_prefix(scheme)
            && rest.trim().len() > 16
        {
            return true;
        }
    }
    if strict || text.len() <= 24 || text.chars().any(|c| c.is_whitespace() || c == '/') {
        return false;
    }
    let token_chars = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .count();
    token_chars * 10 >= text.chars().count() * 9
}

fn reject_literal_secret(location: &str, value: &str, strict: bool) -> Result<()> {
    if looks_like_literal_secret(value, strict) {
        anyhow::bail!(
            "{location} looks like a literal secret. Never put tokens, keys or passwords in headers/env/args yourself. \
             Declare them with the 'secrets' parameter instead (for example \
             secrets=[{{\"key\":\"api_key\",\"header\":\"Authorization\",\"prefix\":\"Bearer \"}}]) so the user enters the value in a secure card."
        );
    }
    Ok(())
}

/// A saved entry plus the `(field, ${placeholder variable})` pairs it uses.
struct ConnectorEntry {
    entry: Value,
    secrets: Vec<(String, String)>,
    is_stdio: bool,
}

fn build_connector_entry(slug: &str, params: &McpToolInput) -> Result<ConnectorEntry> {
    let remote = params.url.is_some();
    if remote == params.command.is_some() {
        anyhow::bail!("'add' needs exactly one of 'url' (remote MCP) or 'command' (local stdio)");
    }
    let mut headers: std::collections::BTreeMap<String, String> = params
        .headers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut env: std::collections::BTreeMap<String, String> =
        params.env.clone().unwrap_or_default().into_iter().collect();
    let mut entry = serde_json::Map::new();
    if let Some(url) = params.url.as_deref() {
        if params.args.is_some() || params.env.is_some() {
            anyhow::bail!("'args' and 'env' are only supported with 'command'");
        }
        validate_remote_url(url)?;
        let transport = params.transport.as_deref().unwrap_or("http");
        if !matches!(transport, "http" | "streamable-http" | "sse") {
            anyhow::bail!("'transport' must be 'http', 'streamable-http', or 'sse'");
        }
        entry.insert("type".into(), json!(transport));
        entry.insert("url".into(), json!(url));
    } else {
        let command = params.command.as_deref().unwrap_or_default().trim();
        if command.is_empty() {
            anyhow::bail!("'command' must not be empty");
        }
        if params.headers.is_some()
            || params
                .transport
                .as_deref()
                .is_some_and(|transport| transport != "stdio")
        {
            anyhow::bail!("'headers' and remote transports require 'url'");
        }
        for arg in params.args.iter().flatten() {
            let value = if arg.starts_with('-') {
                arg.split_once('=').map_or(arg.as_str(), |(_, v)| v)
            } else {
                arg.as_str()
            };
            reject_literal_secret("An entry in 'args'", value, true)?;
        }
        entry.insert("command".into(), json!(command));
        if let Some(args) = &params.args {
            entry.insert("args".into(), json!(args));
        }
    }
    for (name, value) in &headers {
        reject_literal_secret(&format!("Header '{name}'"), value, false)?;
    }
    for (name, value) in &env {
        reject_literal_secret(&format!("Env '{name}'"), value, false)?;
    }

    let mut secrets = Vec::new();
    for spec in params.secrets.iter().flatten() {
        let field = secret_field(&spec.key)?;
        let var = placeholder_var(slug, &field);
        let prefix = spec.prefix.clone().unwrap_or_default();
        if prefix.len() > 20 || strip_placeholders(&prefix) != prefix {
            anyhow::bail!("secret 'prefix' must be a short literal such as \"Bearer \"");
        }
        let value = format!("{prefix}${{{var}}}");
        match (spec.header.as_deref(), spec.env.as_deref()) {
            (Some(header), None) if remote => {
                let header = header.trim();
                if header.is_empty() || header.chars().any(|c| c.is_whitespace() || c == ':') {
                    anyhow::bail!("secret 'header' must be a valid HTTP header name");
                }
                headers.insert(header.to_string(), value);
            }
            (None, Some(name)) if !remote => {
                let name = name.trim();
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    anyhow::bail!("secret 'env' must be a valid environment variable name");
                }
                env.insert(name.to_string(), value);
            }
            _ => anyhow::bail!(
                "each secret needs 'header' (for a 'url' server) or 'env' (for a 'command' server), not both"
            ),
        }
        if !secrets.iter().any(|(f, _)| f == &field) {
            secrets.push((field, var));
        }
    }
    if !headers.is_empty() {
        entry.insert("headers".into(), json!(headers));
    }
    if !env.is_empty() {
        entry.insert("env".into(), json!(env));
    }
    Ok(ConnectorEntry {
        entry: Value::Object(entry),
        secrets,
        is_stdio: !remote,
    })
}

/// `$AMIRO_HOME/mcp.json`: the file `McpConfig::load*` reads as the user-level
/// config (and the backend writes as `$AMIRO_RUNTIME_HOME/mcp.json`).
fn user_mcp_config_path() -> Result<std::path::PathBuf> {
    Ok(crate::storage::amiro_dir()?.join("mcp.json"))
}

/// Read the user-level config as raw JSON (no env expansion, no typed
/// round-trip). A missing file is an empty config; an unreadable or invalid
/// one is an error so it is never clobbered.
fn read_raw_user_config(path: &std::path::Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|e| {
                anyhow::anyhow!("{} is not valid JSON ({e}); refusing to overwrite it", path.display())
            })?;
            anyhow::ensure!(
                value.is_object(),
                "{} must contain a JSON object; refusing to overwrite it",
                path.display()
            );
            Ok(value)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(anyhow::anyhow!("cannot read {}: {e}", path.display())),
    }
}

fn servers_key(root: &serde_json::Map<String, Value>) -> &'static str {
    if root.contains_key("servers") {
        "servers"
    } else if root.contains_key("mcpServers") {
        "mcpServers"
    } else {
        "servers"
    }
}

/// Insert or replace one entry, leaving every other value untouched.
fn upsert_server_value(root: &mut Value, name: &str, entry: Value) -> Result<()> {
    let root = root.as_object_mut().ok_or_else(|| anyhow::anyhow!("config root is not an object"))?;
    let key = servers_key(root);
    let servers = root.entry(key).or_insert_with(|| json!({}));
    servers
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("'{key}' in mcp.json is not an object"))?
        .insert(name.to_string(), entry);
    Ok(())
}

/// Remove one entry; returns whether it existed.
fn remove_server_value(root: &mut Value, name: &str) -> Result<bool> {
    let Some(root) = root.as_object_mut() else {
        return Ok(false);
    };
    let key = servers_key(root);
    match root.get_mut(key) {
        None => Ok(false),
        Some(servers) => Ok(servers
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("'{key}' in mcp.json is not an object"))?
            .remove(name)
            .is_some()),
    }
}

/// Write pretty JSON atomically (tmp + rename) with 0600 permissions.
fn write_json_atomic(path: &std::path::Path, value: &Value) -> Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("config path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".mcp.json.tmp-{}-{}",
        std::process::id(),
        crate::id::new_id("w")
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&tmp)?;
        file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Whether `var` resolves from the process env or the live credential file.
fn credential_resolved(var: &str, overlay: &HashMap<String, String>) -> bool {
    std::env::var(var).is_ok_and(|v| !v.is_empty()) || overlay.get(var).is_some_and(|v| !v.is_empty())
}

/// Still-unexpanded `${AMIRO_CRED_*}` references in a loaded server config.
fn unresolved_credential_vars(config: &McpServerConfig) -> Vec<String> {
    let mut found = std::collections::BTreeSet::new();
    let values = config
        .args
        .iter()
        .chain(config.env.values())
        .chain(config.headers.values())
        .chain(config.url.iter());
    for value in values {
        let mut rest = value.as_str();
        while let Some(start) = rest.find("${AMIRO_CRED_") {
            let after = &rest[start + 2..];
            let Some(end) = after.find('}') else { break };
            found.insert(after[..end].to_string());
            rest = &after[end + 1..];
        }
    }
    found.into_iter().collect()
}

/// Field label for a placeholder variable of server `slug` (best effort).
fn field_label(slug: &str, var: &str) -> String {
    let prefix = format!("AMIRO_CRED_MCP_{}_", env_token(slug));
    var.strip_prefix(&prefix).unwrap_or(var).to_ascii_lowercase()
}

fn waiting_message(slug: &str, fields: &[String]) -> String {
    format!(
        "Waiting for the user to enter {} in the secure card shown in the chat. Do not ask for the value in chat. After they confirm, call mcp with action \"connect\" and server \"{slug}\".",
        fields.join(", ")
    )
}

fn connector_setup_line(slug: &str, missing: &[String]) -> String {
    format!(
        "CONNECTOR_SETUP {}",
        json!({"server": slug, "missingSecrets": missing})
    )
}

pub struct McpManagementTool {
    manager: Arc<RwLock<McpManager>>,
    registry: Option<crate::tool::WeakRegistry>,
}

impl McpManagementTool {
    pub fn new(manager: Arc<RwLock<McpManager>>) -> Self {
        Self {
            manager,
            registry: None,
        }
    }

    pub fn with_registry(mut self, registry: crate::tool::Registry) -> Self {
        self.registry = Some(registry.downgrade());
        self
    }
}

#[async_trait]
impl Tool for McpManagementTool {
    fn name(&self) -> &str {
        "mcp"
    }

    fn description(&self) -> &str {
        "Manage MCP (Model Context Protocol) servers: list/connect/disconnect/reload, persistent `add`/`remove` of custom connectors, and local OAuth status/logout. \
Interactive OAuth login requires the explicit CLI command `amiro mcp login <configured-server>`.\n\
Adding connectors: prefer connectors that already exist (see `list`) before adding one. For a new service, find its official remote MCP URL and call `add` with `server` (name) and `url` (optional `transport`: http|streamable-http|sse). \
`add` saves the connector persistently to the user-level mcp.json and connects it. \
For ANY token, API key or password use `secrets`: [{\"key\":\"api_key\",\"header\":\"Authorization\",\"prefix\":\"Bearer \"}] (or `env` instead of `header` for stdio servers). \
Never put a secret value in headers/env/args or ask for it in chat: the user enters it in a secure card, then call `connect` with the server name. Literal-looking secrets are rejected. \
A `command` (stdio) connector runs a local process on this machine, so only use trusted commands; `add` and `remove` require user approval. \
`remove` deletes a saved connector. `composio` is managed by the Connectors page and cannot be added or removed here."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "intent": super::intent_schema_property(),
                "action": {
                    "type": "string",
                    "enum": ["list", "connect", "disconnect", "reload", "status", "logout", "add", "remove"],
                    "description": "Action."
                },
                "server": {
                    "type": "string",
                    "description": "Server name."
                },
                "command": {
                    "type": "string",
                    "description": "Stdio server command. Mutually exclusive with url."
                },
                "args": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Command args."
                },
                "env": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                    "description": "Server env."
                },
                "url": {
                    "type": "string",
                    "description": "HTTP(S) MCP endpoint for an ad hoc remote connect, or OAuth status/logout. Omit command/url to connect a configured server by name."
                },
                "headers": {
                    "type": "object",
                    "additionalProperties": {"type": "string"},
                    "description": "HTTP headers for an ad hoc remote connect. A static Authorization header overrides stored OAuth credentials."
                },
                "transport": {
                    "type": "string",
                    "enum": ["stdio", "http", "streamable-http", "sse"],
                    "description": "Transport for ad hoc connect and `add`. Remote URLs default to Streamable HTTP with legacy SSE fallback."
                },
                "secrets": {
                    "type": "array",
                    "description": "For `add`: secrets the USER will enter in a secure card. Never supply values.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "key": {"type": "string", "description": "Field name, e.g. api_key."},
                            "header": {"type": "string", "description": "HTTP header to carry the secret (url servers)."},
                            "env": {"type": "string", "description": "Environment variable to carry the secret (command servers)."},
                            "prefix": {"type": "string", "description": "Optional literal prefix, e.g. \"Bearer \"."}
                        },
                        "required": ["key"]
                    }
                }
            },
            "required": ["action"]
        })
    }

    async fn execute(&self, input: Value, ctx: ToolContext) -> Result<ToolOutput> {
        let params: McpToolInput = serde_json::from_value(input)?;
        let started = std::time::Instant::now();
        let action = params.action.clone();
        let server = params.server.clone().unwrap_or_else(|| "none".to_string());
        crate::logging::event_info(
            "MCP_LIFECYCLE",
            vec![
                ("phase", "management_start".to_string()),
                ("action", action.clone()),
                ("server", server.clone()),
                ("session_id", ctx.session_id.clone()),
                ("tool_call_id", ctx.tool_call_id.clone()),
            ],
        );

        let result = match params.action.as_str() {
            "list" => self.list_servers().await,
            "connect" => self.connect_server(params, &ctx.session_id).await,
            "add" => self.add_server(params, &ctx).await,
            "remove" => self.remove_server(params, &ctx.session_id).await,
            "disconnect" => self.disconnect_server(params).await,
            "reload" => self.reload_config(&ctx.session_id).await,
            "status" | "logout" => self.oauth_action(params).await,
            "login" => anyhow::bail!(
                "Interactive MCP OAuth login is CLI-only. Run `amiro mcp login <configured-server>` in a terminal (add --no-browser to print the authorization URL). No browser was opened."
            ),
            _ => Ok(ToolOutput::new(format!(
                "Unknown action: {}. Use 'list', 'connect', 'disconnect', 'reload', 'status', 'logout', 'add', or 'remove'.",
                params.action
            ))),
        };

        match &result {
            Ok(_) => crate::logging::event_info(
                "MCP_LIFECYCLE",
                vec![
                    ("phase", "management_done".to_string()),
                    ("action", action),
                    ("server", server),
                    ("session_id", ctx.session_id),
                    ("tool_call_id", ctx.tool_call_id),
                    ("status", "ok".to_string()),
                    ("elapsed_ms", started.elapsed().as_millis().to_string()),
                ],
            ),
            Err(error) => crate::logging::event_warn(
                "MCP_LIFECYCLE",
                vec![
                    ("phase", "management_done".to_string()),
                    ("action", action),
                    ("server", server),
                    ("session_id", ctx.session_id),
                    ("tool_call_id", ctx.tool_call_id),
                    ("status", "error".to_string()),
                    ("error", error.to_string()),
                    ("elapsed_ms", started.elapsed().as_millis().to_string()),
                ],
            ),
        }

        result
    }
}

// Helper for tests to update cached server names
impl McpManagementTool {
    pub fn manager(&self) -> &Arc<RwLock<McpManager>> {
        &self.manager
    }
}

impl McpManagementTool {
    async fn oauth_action(&self, params: McpToolInput) -> Result<ToolOutput> {
        let configured =
            if let Some(name) = params.server.as_deref().filter(|_| params.url.is_none()) {
                self.manager
                    .read()
                    .await
                    .config()
                    .servers
                    .get(name)
                    .cloned()
            } else {
                None
            };
        if params.url.is_none()
            && configured
                .as_ref()
                .is_some_and(|server| !server.is_remote())
        {
            anyhow::bail!("OAuth status/logout is only supported for remote MCP servers");
        }
        let url = params
            .url
            .as_deref()
            .or_else(|| configured.as_ref().and_then(|server| server.url.as_deref()))
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Supply a configured remote 'server' or its 'url' for OAuth status/logout"
                )
            })?;
        validate_remote_url(url)?;
        if params.action == "logout" {
            let removed = crate::mcp::oauth::logout(url)?;
            return Ok(ToolOutput::new(format!("{}. Static headers and existing connections are unchanged. This only forgets local OAuth credentials, not server-side authorization. Disconnect/reconnect active servers to stop using the old token.",
                if removed { "Removed local OAuth credentials" } else { "No local OAuth credentials stored" }))
                .with_title("MCP: OAuth logout"));
        }
        let static_auth = params
            .headers
            .as_ref()
            .or_else(|| configured.as_ref().map(|server| &server.headers))
            .is_some_and(|headers| {
                headers
                    .keys()
                    .any(|name| name.eq_ignore_ascii_case("authorization"))
            });
        let status = if static_auth {
            "Static Authorization header configured (takes precedence over OAuth)"
        } else if crate::mcp::oauth::status(url)?.logged_in {
            "OAuth credentials stored (not a connection or token-validity check)"
        } else {
            "No OAuth credentials stored. To sign in, run `amiro mcp login <configured-server>` in a terminal."
        };
        Ok(ToolOutput::new(status).with_title("MCP: OAuth status"))
    }

    async fn list_servers(&self) -> Result<ToolOutput> {
        let manager = self.manager.read().await;
        let servers = manager.connected_servers().await;
        let all_tools = manager.all_tools().await;
        // Configured-but-not-connected servers, including disabled ones
        // (issue #436), so the full config state is visible.
        let mut configured: Vec<(String, bool)> = manager
            .config()
            .servers
            .iter()
            .filter(|(name, _)| !servers.contains(name))
            .map(|(name, cfg)| (name.clone(), cfg.is_enabled()))
            .collect();
        configured.sort();

        if servers.is_empty() && configured.is_empty() {
            return Ok(ToolOutput::new(
                "No MCP servers connected.\n\n\
                To connect a server, use:\n\
                {\"action\": \"connect\", \"server\": \"name\", \"command\": \"/path/to/server\", \"args\": []}\n\n\
                Or add servers to ~/.jcode/mcp.json or .jcode/mcp.json and use {\"action\": \"reload\"}.\n\
                .claude/mcp.json is also supported for compatibility."
            ).with_title("MCP: No servers"));
        }

        // Names only: full descriptions for every tool of every server cost
        // tens of thousands of tokens. `mcp_search` returns descriptions and
        // schemas for the tools the agent actually needs.
        let mut output = String::new();
        output.push_str(&format!(
            "Connected MCP servers: {} ({} tools)\n\n",
            servers.len(),
            all_tools
                .iter()
                .filter(|(owner, _)| servers.contains(owner))
                .count()
        ));

        let names = crate::mcp::dispatch_names(&all_tools);
        let registry = self.registry.as_ref().and_then(|r| r.upgrade());
        for server in &servers {
            // Callable aliases, which differ from raw names when servers collide.
            let server_tools: Vec<String> = all_tools
                .iter()
                .zip(&names)
                .filter(|((owner, _), _)| owner == server)
                .map(|((_, tool), fallback)| {
                    registry
                        .as_ref()
                        .and_then(|r| r.mcp_alias(server, &tool.name))
                        .unwrap_or_else(|| fallback.clone())
                })
                .collect();
            output.push_str(&format!(
                "## {} ({} tool{})\n",
                server,
                server_tools.len(),
                if server_tools.len() == 1 { "" } else { "s" }
            ));
            if server_tools.is_empty() {
                output.push_str("(no tools)\n");
            } else {
                output.push_str(&server_tools.join(", "));
                output.push('\n');
            }
            output.push('\n');
        }
        if !servers.is_empty() {
            output.push_str(
                "Use mcp_search with a server or query for descriptions and input schemas.\n\n",
            );
        }

        if !configured.is_empty() {
            output.push_str("Configured but not connected:\n");
            for (name, enabled) in &configured {
                if *enabled {
                    output.push_str(&format!(
                        "  - {} (enabled; connect with {{\"action\": \"connect\", \"server\": \"{}\"}})\n",
                        name, name
                    ));
                } else {
                    output.push_str(&format!(
                        "  - {} (disabled in config; connect on demand with {{\"action\": \"connect\", \"server\": \"{}\"}})\n",
                        name, name
                    ));
                }
            }
        }

        Ok(ToolOutput::new(output).with_title("MCP: Server list"))
    }

    async fn add_server(&self, params: McpToolInput, ctx: &ToolContext) -> Result<ToolOutput> {
        let raw_name = params
            .server
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("'server' is required for add action"))?;
        let slug = normalize_slug(raw_name)?;
        if slug == MANAGED_SERVER {
            anyhow::bail!("'composio' is managed by the Connectors page and cannot be changed here");
        }
        let built = build_connector_entry(&slug, &params)?;
        if built.is_stdio {
            let mut line = params.command.clone().unwrap_or_default();
            for arg in params.args.iter().flatten() {
                line.push(' ');
                line.push_str(arg);
            }
            if let Some(refusal) =
                super::bash::destructive_gate::destructive_command_refusal(&line, None, ctx.working_dir.clone())
            {
                anyhow::bail!("{refusal}");
            }
        }

        let path = user_mcp_config_path()?;
        let mut root = read_raw_user_config(&path)?;
        let replaced = root
            .get(servers_key(root.as_object().unwrap_or(&serde_json::Map::new())))
            .and_then(|servers| servers.get(&slug))
            .is_some();
        upsert_server_value(&mut root, &slug, built.entry.clone())?;
        write_json_atomic(&path, &root)?;

        let overlay = crate::storage::read_credential_env();
        let missing: Vec<String> = built
            .secrets
            .iter()
            .filter(|(_, var)| !credential_resolved(var, &overlay))
            .map(|(field, _)| field.clone())
            .collect();

        let mut output = format!(
            "{} MCP server '{}' in {}.\n",
            if replaced { "Updated" } else { "Saved" },
            slug,
            path.display()
        );
        let mut metadata = None;
        if missing.is_empty() {
            // Drop any stale connection made with the previous definition.
            let was_connected = self
                .manager
                .read()
                .await
                .connected_servers()
                .await
                .contains(&slug);
            if was_connected {
                let _ = self
                    .disconnect_server(McpToolInput {
                        action: "disconnect".into(),
                        server: Some(slug.clone()),
                        ..Default::default()
                    })
                    .await;
            }
            let connected = self
                .connect_server(
                    McpToolInput {
                        action: "connect".into(),
                        server: Some(slug.clone()),
                        ..Default::default()
                    },
                    &ctx.session_id,
                )
                .await;
            let manager = self.manager.read().await;
            let is_connected = manager.connected_servers().await.contains(&slug);
            let tool_count = manager
                .all_tools()
                .await
                .iter()
                .filter(|(owner, _)| owner == &slug)
                .count();
            drop(manager);
            match connected {
                Ok(connect_output) => {
                    if is_connected {
                        output.push_str(&format!("Connected: yes ({tool_count} tools).\n\n"));
                    } else {
                        output.push_str("Connected: no.\n\n");
                    }
                    output.push_str(&connect_output.output);
                    metadata = connect_output.metadata;
                }
                Err(error) => {
                    output.push_str(&format!("Connected: no ({error:#}).\n"));
                }
            }
        } else {
            output.push_str("Connected: no (waiting for secrets).\n");
            output.push_str(&waiting_message(&slug, &missing));
            output.push('\n');
        }
        if !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&connector_setup_line(&slug, &missing));
        let mut result = ToolOutput::new(output).with_title(format!("MCP: Added {slug}"));
        if let Some(metadata) = metadata {
            result = result.with_metadata(metadata);
        }
        Ok(result)
    }

    async fn remove_server(&self, params: McpToolInput, session_id: &str) -> Result<ToolOutput> {
        let raw_name = params
            .server
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| anyhow::anyhow!("'server' is required for remove action"))?;
        let normalized = normalize_slug(raw_name).ok();
        if raw_name == MANAGED_SERVER || normalized.as_deref() == Some(MANAGED_SERVER) {
            anyhow::bail!("'composio' is managed by the Connectors page and cannot be removed here");
        }
        let path = user_mcp_config_path()?;
        let mut root = read_raw_user_config(&path)?;
        let mut removed_name = None;
        for candidate in std::iter::once(raw_name.to_string()).chain(normalized) {
            if remove_server_value(&mut root, &candidate)? {
                removed_name = Some(candidate);
                break;
            }
        }
        let Some(name) = removed_name else {
            return Ok(ToolOutput::new(format!(
                "No saved MCP server named '{raw_name}' in {}. Nothing was removed.",
                path.display()
            ))
            .with_title("MCP: Not found"));
        };
        write_json_atomic(&path, &root)?;

        let was_connected = self
            .manager
            .read()
            .await
            .connected_servers()
            .await
            .contains(&name);
        if was_connected {
            self.disconnect_server(McpToolInput {
                action: "disconnect".into(),
                server: Some(name.clone()),
                ..Default::default()
            })
            .await?;
        }
        self.manager.write().await.remove_server_config(&name);
        crate::logging::event_info(
            "MCP_LIFECYCLE",
            vec![
                ("phase", "connector_removed".to_string()),
                ("server", name.clone()),
                ("session_id", session_id.to_string()),
            ],
        );
        let still_configured = self
            .manager
            .read()
            .await
            .load_fresh_config()
            .servers
            .contains_key(&name);
        let mut output = format!(
            "Removed MCP server '{name}' from {}{}.",
            path.display(),
            if was_connected { " and disconnected it" } else { "" }
        );
        if still_configured {
            output.push_str(
                " Note: another config source (project-local or Claude Code config) still defines this name.",
            );
        }
        Ok(ToolOutput::new(output).with_title(format!("MCP: Removed {name}")))
    }

    async fn connect_server(&self, params: McpToolInput, session_id: &str) -> Result<ToolOutput> {
        let server_name = params
            .server
            .clone()
            .ok_or_else(|| anyhow::anyhow!("'server' is required for connect action"))?;

        // Explicit command/URL is ad hoc. Otherwise use the named config,
        // including disabled entries, without changing persistent configuration.
        let mut configured = self
            .manager
            .read()
            .await
            .config()
            .servers
            .get(&server_name)
            .cloned();
        if params.command.is_none() && params.url.is_none() {
            // Connecting a configured server by name re-reads the config files
            // and the live credential file, so a connector added (or a secret
            // entered) after this session started is picked up without reload.
            let fresh = self
                .manager
                .read()
                .await
                .load_fresh_config()
                .servers
                .remove(&server_name);
            if let Some(fresh) = fresh {
                self.manager
                    .write()
                    .await
                    .set_server_config(&server_name, fresh.clone());
                configured = Some(fresh);
            }
            if let Some(config) = &configured {
                let vars = unresolved_credential_vars(config);
                if !vars.is_empty() {
                    let fields: Vec<String> = vars
                        .iter()
                        .map(|var| field_label(&server_name, var))
                        .collect();
                    return Ok(ToolOutput::new(format!(
                        "Not connected: '{}' is still missing {}.\n{}\n{}",
                        server_name,
                        fields.join(", "),
                        waiting_message(&server_name, &fields),
                        connector_setup_line(&server_name, &fields)
                    ))
                    .with_title("MCP: Waiting for secrets"));
                }
            }
        }
        let config = connection_config(&params, configured)?;

        let manager = self.manager.read().await;

        // Check if already connected
        let connected = manager.connected_servers().await;
        if connected.contains(&server_name) {
            return Ok(ToolOutput::new(format!(
                "Server '{}' is already connected. Use 'disconnect' first to reconnect.",
                server_name
            ))
            .with_title("MCP: Already connected"));
        }
        drop(manager);

        // Connect
        let manager = self.manager.read().await;
        match manager.connect(&server_name, &config).await {
            Ok(()) => {
                let tools = manager.all_tools().await;
                let connected = manager.connected_servers().await;
                drop(manager);
                let registry = self.registry.as_ref().and_then(|r| r.upgrade());
                if let Some(registry) = &registry {
                    registry
                        .refresh_mcp_tools(
                            crate::mcp::create_mcp_tools_from_cached_many(
                                &tools,
                                Arc::clone(&self.manager),
                            ),
                            &connected,
                        )
                        .await;
                }
                let names = crate::mcp::dispatch_names(&tools);
                let server_tools: Vec<_> = tools
                    .iter()
                    .zip(&names)
                    .filter(|((server, _), _)| server == &server_name)
                    .collect();
                let mut output = format!(
                    "Connected to MCP server '{}'\n\nAvailable tools ({}):\n",
                    server_name,
                    server_tools.len()
                );
                let mut references = Vec::new();
                for ((_, tool), fallback) in server_tools {
                    let name = registry
                        .as_ref()
                        .and_then(|r| r.mcp_alias(&server_name, &tool.name))
                        .unwrap_or_else(|| fallback.clone());
                    // The schema is part of the result on purpose: on providers
                    // without native deferred loading the cached tool list never
                    // changes, so this transcript entry is the only place the
                    // model learns how to call the new tool (via `mcp_call`).
                    output.push_str(&format!(
                        "  - {}: {}\n    tool: {}  input_schema: {}\n",
                        name,
                        tool.description.as_deref().unwrap_or("(no description)"),
                        tool.name,
                        serde_json::to_string(&tool.input_schema)
                            .unwrap_or_else(|_| "{}".to_string()),
                    ));
                    references.push(name);
                }
                references.truncate(MAX_SEARCH_TOOL_REFERENCES);
                output.push_str(&format!(
                    "\nCall these tools directly by name if they appear in your tool list; \
                     otherwise use mcp_call with server=\"{}\", tool=<tool>, and arguments \
                     matching input_schema.\n",
                    server_name
                ));

                // The new server's tools load as provider-native deferred
                // definitions (no prompt-cache miss) where supported.
                Ok(ToolOutput::new(output)
                    .with_title(format!("MCP: Connected {}", server_name))
                    .with_metadata(json!({ "tool_references": references })))
            }
            Err(e) => {
                let auth_hint = if config.is_remote()
                    && !config
                        .headers
                        .keys()
                        .any(|key| key.eq_ignore_ascii_case("authorization"))
                {
                    format!(
                        "\nIf authentication is required, configure this server and run `amiro mcp login {server_name}` in a terminal, then reconnect. Login never runs automatically."
                    )
                } else {
                    String::new()
                };
                crate::logging::event_warn(
                    "MCP_LIFECYCLE",
                    vec![
                        ("phase", "connect_failed".to_string()),
                        ("server", server_name.clone()),
                        ("session_id", session_id.to_string()),
                        ("error", e.to_string()),
                    ],
                );
                Ok(ToolOutput::new(format!(
                    "Failed to connect to '{}': {}{}",
                    server_name, e, auth_hint
                ))
                .with_title("MCP: Connection failed"))
            }
        }
    }

    async fn disconnect_server(&self, params: McpToolInput) -> Result<ToolOutput> {
        let server_name = params
            .server
            .ok_or_else(|| anyhow::anyhow!("'server' is required for disconnect action"))?;

        let manager = self.manager.read().await;
        let connected = manager.connected_servers().await;

        if !connected.contains(&server_name) {
            return Ok(ToolOutput::new(format!(
                "Server '{}' is not connected.\n\nConnected servers: {}",
                server_name,
                if connected.is_empty() {
                    "(none)".to_string()
                } else {
                    connected.join(", ")
                }
            ))
            .with_title("MCP: Not connected"));
        }
        drop(manager);

        let manager = self.manager.read().await;
        manager.disconnect(&server_name).await?;
        drop(manager);

        // Unregister tools for this server
        if let Some(registry) = self
            .registry
            .as_ref()
            .and_then(|registry| registry.upgrade())
        {
            let removed = registry.unregister_mcp_server(&server_name).await;
            let connected = self.manager.read().await.connected_servers().await;
            registry
                .refresh_mcp_tools(
                    crate::mcp::create_mcp_tools(Arc::clone(&self.manager)).await,
                    &connected,
                )
                .await;
            crate::logging::event_info(
                "MCP_LIFECYCLE",
                vec![
                    ("phase", "tools_unregistered".to_string()),
                    ("server", server_name.clone()),
                    ("removed_tool_count", removed.len().to_string()),
                ],
            );
        }

        Ok(
            ToolOutput::new(format!("Disconnected from MCP server '{}'", server_name))
                .with_title(format!("MCP: Disconnected {}", server_name)),
        )
    }

    async fn reload_config(&self, session_id: &str) -> Result<ToolOutput> {
        // Load fresh config, resolved against the session's project directory
        // rather than the server process cwd (issue #420).
        let config = self.manager.read().await.load_fresh_config();

        if config.servers.is_empty() {
            // Unregister all existing MCP tools before reporting empty
            if let Some(registry) = self
                .registry
                .as_ref()
                .and_then(|registry| registry.upgrade())
            {
                registry.unregister_prefix("mcp__").await;
            }
            return Ok(ToolOutput::new(
                "No servers found in config.\n\n\
                Add servers to ~/.jcode/mcp.json (global) or .jcode/mcp.json (project):\n\
                {\n  \"servers\": {\n    \"server-name\": {\n      \"command\": \"/path/to/server\",\n      \"args\": [],\n      \"env\": {},\n      \"shared\": true\n    }\n  }\n}\n\n\
                .claude/mcp.json is also supported for compatibility."
            ).with_title("MCP: Empty config"));
        }

        // Unregister all existing MCP server tools before reload
        if let Some(registry) = self
            .registry
            .as_ref()
            .and_then(|registry| registry.upgrade())
        {
            registry.unregister_prefix("mcp__").await;
        }

        let mut manager = self.manager.write().await;
        let (successes, failures) = manager.reload().await?;

        let servers = manager.connected_servers().await;
        let all_tools = manager.all_tools().await;
        drop(manager);

        // Re-register tools from fresh connections
        if let Some(registry) = self
            .registry
            .as_ref()
            .and_then(|registry| registry.upgrade())
        {
            let mcp_tools = crate::mcp::create_mcp_tools(Arc::clone(&self.manager)).await;
            registry.reconcile_mcp_tools(mcp_tools).await;
        }

        let enabled_count = config
            .servers
            .values()
            .filter(|cfg| cfg.is_enabled())
            .count();
        let disabled_count = config.servers.len() - enabled_count;
        let mut output = format!(
            "Reloaded MCP config. Connected: {}/{}\n\n",
            successes, enabled_count
        );
        if disabled_count > 0 {
            output.push_str(&format!(
                "{} server(s) disabled in config (kept, not spawned).\n\n",
                disabled_count
            ));
        }

        // Show failures first
        if !failures.is_empty() {
            crate::logging::event_warn(
                "MCP_LIFECYCLE",
                vec![
                    ("phase", "reload_connect_failures".to_string()),
                    ("session_id", session_id.to_string()),
                    ("failure_count", failures.len().to_string()),
                    (
                        "servers",
                        failures
                            .iter()
                            .map(|(name, _)| name.clone())
                            .collect::<Vec<_>>()
                            .join(","),
                    ),
                ],
            );
            output.push_str("## Connection Failures\n");
            for (name, error) in &failures {
                output.push_str(&format!("  - {}: {}\n", name, error));
            }
            output.push('\n');
        }

        let names = crate::mcp::dispatch_names(&all_tools);
        for server in &servers {
            output.push_str(&format!("## {}\n", server));
            let server_tools: Vec<_> = all_tools
                .iter()
                .zip(&names)
                .filter(|((owner, _), _)| owner == server)
                .collect();

            for (_, name) in server_tools {
                output.push_str(&format!("  - {}\n", name));
            }
            output.push('\n');
        }

        Ok(ToolOutput::new(output).with_title("MCP: Reloaded"))
    }
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
