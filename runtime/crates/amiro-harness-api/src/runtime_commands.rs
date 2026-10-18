//! Runtime-backed commands, shared by all non-terminal clients.
use serde::{Deserialize, Serialize};

/// Commands executed by the attached runtime, never submitted as an agent prompt.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeCommand {
    Skills,
    Context,
    Info,
    Cache,
    Memory,
    Swarm,
    Agents,
    SubagentModel,
    Autoreview,
    Autojudge,
    Transport,
    Fast,
    Telemetry,
    Subscription,
    Overnight,
    Productivity,
    Initiatives,
    Premium,
    ProviderTestCoverage,
    RefreshModelList,
    Continue,
    ResumeAll,
    Remote,
    ServerReload,
    /// Re-read the MCP configuration files (`~/.jcode/mcp.json`, project-local
    /// `.jcode/mcp.json` / `.mcp.json` / `.claude/mcp.json`) and reconnect MCP
    /// servers without a model turn. The programmatic equivalent of the `mcp`
    /// tool's `reload` action, for clients (for example a backend that just
    /// wrote a new MCP server definition) that cannot call tools directly.
    McpReload,
    Review,
    Judge,
    Subagent,
    Auth,
    Logout,
}

/// Structured runtime data plus a human-readable rendering. Data is command
/// specific and additive. Clients must ignore unknown fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeCommandOutput {
    pub session_id: String,
    pub command: RuntimeCommand,
    pub data: serde_json::Value,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The backend triggers an MCP reload by name over the socket, so the wire
    /// form is part of the contract.
    #[test]
    fn mcp_reload_round_trips_as_snake_case_wire_name() {
        let value = serde_json::to_value(RuntimeCommand::McpReload).unwrap();
        assert_eq!(value, serde_json::json!("mcp_reload"));
        let parsed: RuntimeCommand = serde_json::from_value(value).unwrap();
        assert_eq!(parsed, RuntimeCommand::McpReload);
    }

    /// Existing wire names stay stable: this command surface is consumed by
    /// third-party clients.
    #[test]
    fn server_reload_wire_name_is_unchanged() {
        let value = serde_json::to_value(RuntimeCommand::ServerReload).unwrap();
        assert_eq!(value, serde_json::json!("server_reload"));
    }
}
