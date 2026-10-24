//! Team agents' tools, run in each agent's own container.
//!
//! A team agent's runtime session is configured with no built-in and no MCP
//! tools. The only tools it gets are the ones below that the owner switched
//! on; the runtime hands each call back to the backend (an SDK custom tool),
//! and this module runs it through the sandbox supervisor
//! (`backend/sandboxd`). There is no host fallback: with the supervisor
//! missing or down, the call returns an error that says so.
//!
//! Settings: `AMIRO_SANDBOX_URL` (default `http://127.0.0.1:4313`) and the
//! secrets `AMIRO_SANDBOX_TOKEN` / `AMIRO_SANDBOX_MASTER`, from the environment
//! (which wins) or from `AMIRO_SANDBOX_ENV_FILE` (default `$AMIRO_HOME/sandbox/supervisor.env`,
//! written by `scripts/sandbox.sh up`). They are read only here and never
//! appear in a response, a log line or a tool result.

use amiro_sdk::SessionToolDefinition;
use sandboxd::client::{ClientError, SandboxClient};
use sandboxd::credential::MIN_SECRET_LEN;
use sandboxd::paths::clean_relative;
use serde_json::{json, Map, Value};

use crate::routes::agents;
use crate::state::{ApiError, AppState};

pub const SHELL_TOOL: &str = "agent_shell";
pub const READ_TOOL: &str = "agent_read_file";
pub const WRITE_TOOL: &str = "agent_write_file";
pub const LIST_TOOL: &str = "agent_list_files";
pub const DESKTOP_OPEN_TOOL: &str = "agent_desktop_open";
pub const DESKTOP_STATE_TOOL: &str = "agent_desktop_state";

/// Every tool name this module answers. The chat stream marks these as run
/// by the server so the UI never tries to answer them itself.
pub fn is_agent_tool(name: &str) -> bool {
    matches!(name, SHELL_TOOL | READ_TOOL | WRITE_TOOL | LIST_TOOL | DESKTOP_OPEN_TOOL | DESKTOP_STATE_TOOL)
}

/// Shown to the model (and the owner) when the container can't be used.
pub const UNAVAILABLE: &str = "This agent's computer is not available, so the tool did not run. \
     Nothing was run on the Amiro host instead. The owner can start the sandbox with scripts/sandbox.sh up.";

fn parse_env_file(text: &str) -> Vec<(String, String)> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        .collect()
}

/// The supervisor client, or `None` when the sandbox is not configured
/// (no secrets, or secrets too short to be real).
pub async fn client(state: &AppState) -> Option<SandboxClient> {
    let env = |name: &str| std::env::var(name).unwrap_or_default();
    let (mut url, mut token, mut master) = (env("AMIRO_SANDBOX_URL"), env("AMIRO_SANDBOX_TOKEN"), env("AMIRO_SANDBOX_MASTER"));
    if url.is_empty() || token.is_empty() || master.is_empty() {
        let file = std::env::var("AMIRO_SANDBOX_ENV_FILE")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| state.home.join("sandbox").join("supervisor.env"));
        if let Ok(text) = tokio::fs::read_to_string(&file).await {
            for (key, value) in parse_env_file(&text) {
                match key.as_str() {
                    "AMIRO_SANDBOX_URL" if url.is_empty() => url = value,
                    "AMIRO_SANDBOX_TOKEN" if token.is_empty() => token = value,
                    "AMIRO_SANDBOX_MASTER" if master.is_empty() => master = value,
                    _ => {}
                }
            }
        }
    }
    if token.trim().len() < MIN_SECRET_LEN || master.trim().len() < MIN_SECRET_LEN {
        return None;
    }
    if url.trim().is_empty() {
        url = "http://127.0.0.1:4313".into();
    }
    Some(SandboxClient::new(url.trim(), token.trim(), master.trim()))
}

fn definition(name: &str, description: &str, parameters: Value) -> SessionToolDefinition {
    let parameters = match parameters {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    SessionToolDefinition {
        name: name.into(),
        description: description.into(),
        parameters,
    }
}

/// The tool definitions a team agent gets for its switches. Empty when every
/// switch is off.
pub fn tool_definitions(tools: &Value) -> Vec<SessionToolDefinition> {
    let on = |key: &str| tools.get(key).and_then(Value::as_bool).unwrap_or(false);
    let mut defs = Vec::new();
    if on("shell") {
        defs.push(definition(
            SHELL_TOOL,
            "Run a shell command (sh) on your own computer: a Linux container whose only files are your \
             home folder /home/agent, where the command starts. Nothing runs on the Amiro host. \
             Output is capped at 64 KiB; the command is killed after timeoutSecs (default 60, max 110).",
            json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to run."},
                    "timeoutSecs": {"type": "integer", "description": "Seconds before the command is killed (1-110)."}
                },
                "required": ["command"]
            }),
        ));
        // The desktop runs in the same container, so it comes with the shell.
        defs.push(definition(
            DESKTOP_OPEN_TOOL,
            "Open something on your own Linux desktop, which the user watches live on the TV screen: a Chromium \
             tab at an http(s) URL, a Files window at a folder, or a terminal in a folder. Starts the desktop if \
             it is off. Folders are absolute or relative to /home/agent and must exist. Returns every open window \
             with its exact folder or URL.",
            json!({
                "type": "object",
                "properties": {
                    "app": {"type": "string", "enum": ["browser", "files", "terminal"], "description": "What to open."},
                    "target": {"type": "string", "description": "browser: an http(s) URL. files/terminal: a folder (default /home/agent)."}
                },
                "required": ["app"]
            }),
        ));
        defs.push(definition(
            DESKTOP_STATE_TOOL,
            "See what is open on your desktop (the TV): each window, which one is in front, the exact folder \
             each Files and Terminal window shows, and the URL of each browser tab.",
            json!({"type": "object", "properties": {}}),
        ));
    }
    if on("files") {
        let path = json!({"type": "string", "description": "Path relative to your home folder, e.g. notes/today.md."});
        defs.push(definition(
            READ_TOOL,
            "Read a text file from your home folder on your own computer (up to 256 KiB).",
            json!({"type": "object", "properties": {"path": path}, "required": ["path"]}),
        ));
        defs.push(definition(
            WRITE_TOOL,
            "Create or replace a text file in your home folder on your own computer (up to 1 MiB). \
             Missing folders are created.",
            json!({
                "type": "object",
                "properties": {"path": path, "content": {"type": "string", "description": "The whole new file content."}},
                "required": ["path", "content"]
            }),
        ));
        defs.push(definition(
            LIST_TOOL,
            "List one folder in your home folder on your own computer. Leave path empty for the home folder itself.",
            json!({"type": "object", "properties": {"path": path}}),
        ));
    }
    defs
}

fn switch_for(name: &str) -> &'static str {
    if matches!(name, SHELL_TOOL | DESKTOP_OPEN_TOOL | DESKTOP_STATE_TOOL) {
        "shell"
    } else {
        "files"
    }
}

fn client_error(error: ClientError) -> String {
    match error.status {
        None => UNAVAILABLE.to_string(),
        Some(_) => error.message,
    }
}

/// Run one agent tool call. `Ok` is the text the model sees; `Err` is
/// reported to the model as a failed tool call.
pub async fn run_tool(state: &AppState, agent_id: &str, name: &str, input: &Value) -> Result<String, String> {
    if !is_agent_tool(name) {
        return Err(format!("unknown tool {name}"));
    }
    // Checked at call time: a switch turned off mid-turn stops the next call.
    let tools = agents::agent_tools(state, agent_id)
        .await
        .map_err(|e| e.1)?
        .ok_or("the main agent does not use container tools")?;
    let switch = switch_for(name);
    if !tools[switch].as_bool().unwrap_or(false) {
        return Err(format!("The owner has switched {switch} off for this agent."));
    }
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    if name == DESKTOP_OPEN_TOOL {
        use crate::routes::agent_browser::{describe_desktop, open_on_desktop};
        let app = text("app");
        let desktop = open_on_desktop(state, agent_id, &app, &text("target")).await?;
        return Ok(format!("Opened {app} on your desktop.\n{}", describe_desktop(&desktop)));
    }
    if name == DESKTOP_STATE_TOOL {
        use crate::routes::agent_browser::{describe_desktop, read_desktop};
        return Ok(describe_desktop(&read_desktop(state, agent_id).await?));
    }
    let sandbox = client(state).await.ok_or(UNAVAILABLE)?;
    let path = || clean_relative(&text("path"));
    match name {
        SHELL_TOOL => {
            let command = text("command");
            if command.trim().is_empty() {
                return Err("command is required".into());
            }
            let timeout = input.get("timeoutSecs").and_then(Value::as_u64);
            let out = sandbox.exec(agent_id, &command, timeout).await.map_err(client_error)?;
            Ok(format_shell(&out))
        }
        READ_TOOL => {
            let path = path()?;
            let out = sandbox.read_file(agent_id, &path).await.map_err(client_error)?;
            let mut content = out["content"].as_str().unwrap_or("").to_string();
            if out["truncated"].as_bool() == Some(true) {
                content.push_str("\n[file is longer; only the first 256 KiB is shown]");
            }
            Ok(content)
        }
        WRITE_TOOL => {
            let path = path()?;
            let content = input.get("content").and_then(Value::as_str).ok_or("content is required")?;
            let out = sandbox.write_file(agent_id, &path, content).await.map_err(client_error)?;
            Ok(format!("Wrote {} bytes to {path}.", out["bytes"].as_u64().unwrap_or(0)))
        }
        _ => {
            let path = path()?;
            let out = sandbox.list_files(agent_id, &path).await.map_err(client_error)?;
            let entries = out["entries"].as_array().cloned().unwrap_or_default();
            if entries.is_empty() {
                return Ok("(empty folder)".into());
            }
            let mut lines: Vec<String> = entries
                .iter()
                .map(|e| {
                    let name = e["name"].as_str().unwrap_or("?");
                    match e["kind"].as_str() {
                        Some("folder") => format!("{name}/"),
                        Some("file") => format!("{name} ({} bytes)", e["size"].as_u64().unwrap_or(0)),
                        _ => name.to_string(),
                    }
                })
                .collect();
            if out["truncated"].as_bool() == Some(true) {
                lines.push("[more entries not shown]".into());
            }
            Ok(lines.join("\n"))
        }
    }
}

fn format_shell(out: &Value) -> String {
    let mut text = match out["exitCode"].as_i64() {
        Some(code) => format!("exit code: {code}\n"),
        None => "exit code: unknown\n".to_string(),
    };
    text.push_str(out["stdout"].as_str().unwrap_or(""));
    let stderr = out["stderr"].as_str().unwrap_or("");
    if !stderr.is_empty() {
        text.push_str("\n--- stderr ---\n");
        text.push_str(stderr);
    }
    if out["truncated"].as_bool() == Some(true) {
        text.push_str("\n[output truncated at 64 KiB]");
    }
    if out["timedOut"].as_bool() == Some(true) {
        text.push_str(&format!("\n[killed after {} s]", out["timeoutSecs"].as_u64().unwrap_or(0)));
    }
    text
}

/// Whether `state` is the agent's own scoped state (its own runtime home,
/// `…/agents-private/<id>/runtime`). Only then is its `mcp.json` the agent's
/// own; the main runtime's connectors carry the owner's credentials and are
/// never offered to a team agent.
fn is_agent_scoped(state: &AppState, agent_id: &str) -> bool {
    state.runtime_home.ends_with(std::path::Path::new("agents-private").join(agent_id).join("runtime"))
}

/// Names of the remote (URL) MCP servers in the agent's own `mcp.json`.
/// A stdio server is a process on the host, so it is never included.
pub async fn remote_mcp_servers(state: &AppState, agent_id: &str) -> Vec<String> {
    if !is_agent_scoped(state, agent_id) {
        return Vec::new();
    }
    let path = crate::routes::connectors::mcp_config_path(state);
    let Ok(text) = tokio::fs::read_to_string(&path).await else {
        return Vec::new();
    };
    remote_servers_in(&serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// The agent's remote servers. `mcp_call` can reach every server in a
/// runtime, so if the agent's config holds anything that is not a plain
/// remote server (a stdio command, or Amiro's own `amiro` admin server) the
/// answer is none at all: fail closed rather than filter.
fn remote_servers_in(config: &Value) -> Vec<String> {
    let mut names = Vec::new();
    for key in ["mcpServers", "servers"] {
        let Some(servers) = config.get(key).and_then(Value::as_object) else { continue };
        for (name, server) in servers {
            let url = server.get("url").and_then(Value::as_str).is_some_and(|u| u.starts_with("http"));
            let command = server.get("command").and_then(Value::as_str).is_some_and(|c| !c.trim().is_empty());
            let stdio = ["type", "transport"]
                .iter()
                .any(|k| server.get(*k).and_then(Value::as_str) == Some("stdio"));
            let disabled = server.get("disabled").and_then(Value::as_bool) == Some(true)
                || server.get("enabled").and_then(Value::as_bool) == Some(false);
            if disabled {
                continue;
            }
            if !url || command || stdio || name == crate::agent_mcp::SERVER_NAME {
                return Vec::new();
            }
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
    }
    names
}

/// Tools a team agent with remote connectors gets enabled. The runtime shows
/// most models only the fixed `mcp_search` / `mcp_call` surface (per-server
/// definitions are stripped); enabling `mcp_call` authorises calls through it.
/// Models with native deferred loading call `mcp__<server>__<tool>` directly,
/// so those listed names are enabled too. Never `mcp` (the management tool).
pub fn mcp_enabled_tools(listed: &[String], servers: &[String]) -> Vec<String> {
    if servers.is_empty() {
        return Vec::new();
    }
    let mut enabled = vec!["mcp_search".to_string(), "mcp_call".to_string()];
    enabled.extend(mcp_tools_for(listed, servers));
    enabled
}

/// The runtime's model-facing prefix for one server's tools
/// (`amiro-base` `mcp::tool::dispatch_name`).
fn mcp_prefix(server: &str) -> String {
    let clean: String = server.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    format!("mcp__{clean}__")
}

/// From the tools a session lists, the MCP tools that belong to `servers`.
/// Never the `mcp` management tool (it can connect a stdio command) and never
/// a built-in.
pub fn mcp_tools_for(listed: &[String], servers: &[String]) -> Vec<String> {
    let prefixes: Vec<String> = servers.iter().map(|s| mcp_prefix(s)).collect();
    listed
        .iter()
        .filter(|name| prefixes.iter().any(|p| name.starts_with(p.as_str()) && name.len() > p.len()))
        .cloned()
        .collect()
}

/// What a team agent's turn needs to answer its tool calls on the worker
/// thread: the definitions to configure, and a way back into async code.
#[derive(Clone)]
pub struct AgentToolset {
    pub agent_id: String,
    pub definitions: Vec<SessionToolDefinition>,
    /// Remote MCP servers from the agent's own runtime; their tools are
    /// enabled by exact name each turn (see `runtime::drive_turn`).
    pub mcp_servers: Vec<String>,
    state: AppState,
    handle: tokio::runtime::Handle,
}

impl std::fmt::Debug for AgentToolset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentToolset")
            .field("agent_id", &self.agent_id)
            .field("tools", &self.definitions.iter().map(|d| d.name.as_str()).collect::<Vec<_>>())
            .finish()
    }
}

impl AgentToolset {
    /// The toolset for a team agent, or `None` for the main agent. Must be
    /// called inside the tokio runtime.
    pub async fn for_agent(state: &AppState, agent_id: &str) -> Result<Option<Self>, ApiError> {
        let Some(tools) = agents::agent_tools(state, agent_id).await? else {
            return Ok(None);
        };
        Ok(Some(AgentToolset {
            agent_id: agent_id.to_string(),
            definitions: tool_definitions(&tools),
            mcp_servers: remote_mcp_servers(state, agent_id).await,
            state: state.clone(),
            handle: tokio::runtime::Handle::current(),
        }))
    }

    pub fn handles(&self, name: &str) -> bool {
        self.definitions.iter().any(|d| d.name == name)
    }

    /// Run a call from a plain (non-async) thread.
    pub fn run_blocking(&self, name: &str, input: &Value) -> Result<String, String> {
        self.handle.block_on(run_tool(&self.state, &self.agent_id, name, input))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_follow_the_switches() {
        assert!(tool_definitions(&json!({})).is_empty());
        assert!(tool_definitions(&json!({"shell": false, "files": false, "browser": true})).is_empty());
        let names = |v: Value| tool_definitions(&v).into_iter().map(|d| d.name).collect::<Vec<_>>();
        assert_eq!(names(json!({"shell": true})), vec![SHELL_TOOL, DESKTOP_OPEN_TOOL, DESKTOP_STATE_TOOL]);
        assert_eq!(names(json!({"files": true})), vec![READ_TOOL, WRITE_TOOL, LIST_TOOL]);
        assert_eq!(names(json!({"shell": true, "files": true})).len(), 6);
        for def in tool_definitions(&json!({"shell": true, "files": true})) {
            assert!(is_agent_tool(&def.name));
            assert_eq!(def.parameters["type"], "object");
        }
    }

    #[test]
    fn only_remote_servers_and_their_exact_tools_are_offered() {
        let remote = json!({"mcpServers": {
            "github": {"url": "https://api.github.example/mcp"},
            "off": {"command": "sh", "disabled": true},
            "my.notes": {"url": "http://localhost:9/mcp"}
        }});
        let servers = remote_servers_in(&remote);
        assert_eq!(servers, vec!["github".to_string(), "my.notes".to_string()]);
        // Anything local, or Amiro's admin server, means no MCP at all.
        for bad in [
            json!({"command": "npx", "args": ["server-filesystem", "/"]}),
            json!({"url": "https://x.example", "command": "sh"}),
            json!({"type": "stdio", "url": "https://y.example"}),
        ] {
            let config = json!({"mcpServers": {"github": {"url": "https://g.example"}, "local": bad}});
            assert!(remote_servers_in(&config).is_empty(), "{config}");
        }
        let admin = json!({"servers": {"amiro": {"url": "http://127.0.0.1:4000/api/agent-mcp"}}});
        assert!(remote_servers_in(&admin).is_empty());
        let listed: Vec<String> = [
            "bash", "read", "mcp", "mcp_search", "mcp_call", "mcp__github__create_issue",
            "mcp__files__read_file", "mcp__my_notes__add", "mcp__github__", "agent_shell",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(mcp_tools_for(&listed, &servers), vec!["mcp__github__create_issue", "mcp__my_notes__add"]);
        assert!(mcp_tools_for(&listed, &[]).is_empty());
        let enabled = mcp_enabled_tools(&listed, &servers);
        assert_eq!(&enabled[..2], ["mcp_search", "mcp_call"]);
        assert!(!enabled.contains(&"mcp".to_string()) && !enabled.contains(&"bash".to_string()));
        assert!(mcp_enabled_tools(&listed, &[]).is_empty());
    }

    #[test]
    fn env_file_parsing_ignores_comments() {
        let parsed = parse_env_file("# secrets\nAMIRO_SANDBOX_TOKEN=abc\n\nAMIRO_SANDBOX_MASTER=\"def\"\n");
        assert_eq!(parsed, vec![("AMIRO_SANDBOX_TOKEN".into(), "abc".into()), ("AMIRO_SANDBOX_MASTER".into(), "def".into())]);
    }

    #[test]
    fn shell_output_says_what_happened() {
        let text = format_shell(&json!({"exitCode": 2, "stdout": "out\n", "stderr": "bad", "truncated": true, "timedOut": true, "timeoutSecs": 5}));
        assert!(text.starts_with("exit code: 2\nout\n"));
        assert!(text.contains("--- stderr ---\nbad"));
        assert!(text.contains("truncated"));
        assert!(text.contains("killed after 5 s"));
    }
}
