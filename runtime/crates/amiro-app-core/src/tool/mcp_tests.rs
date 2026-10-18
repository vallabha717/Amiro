use super::*;
use crate::tool::Tool;
use std::fs;
use std::path::PathBuf;

fn create_test_tool() -> McpManagementTool {
    // Use an explicit empty config so tests are hermetic: McpManager::new()
    // would load the developer's real ~/.jcode/mcp.json, and list output
    // now includes configured-but-not-connected servers (issue #436).
    let manager = Arc::new(RwLock::new(McpManager::with_config(
        crate::mcp::McpConfig::default(),
    )));
    McpManagementTool::new(manager)
}

fn create_test_context() -> ToolContext {
    ToolContext {
        session_id: "test-session".to_string(),
        message_id: "test-message".to_string(),
        tool_call_id: "test-tool-call".to_string(),
        working_dir: None,
        stdin_request_tx: None,
        graceful_shutdown_signal: None,
        execution_mode: crate::tool::ToolExecutionMode::Direct,
    }
}

struct LocalMcpConfigGuard {
    path: PathBuf,
    backup: Option<String>,
    created_dir: bool,
}

impl LocalMcpConfigGuard {
    fn new(content: &str) -> std::io::Result<Self> {
        let path = PathBuf::from(".jcode/mcp.json");
        let dir = path
            .parent()
            .ok_or_else(|| std::io::Error::other("missing parent"))?;
        let created_dir = if !dir.exists() {
            fs::create_dir_all(dir)?;
            true
        } else {
            false
        };
        let backup = if path.exists() {
            Some(fs::read_to_string(&path)?)
        } else {
            None
        };
        fs::write(&path, content)?;
        Ok(Self {
            path,
            backup,
            created_dir,
        })
    }
}

impl Drop for LocalMcpConfigGuard {
    fn drop(&mut self) {
        match &self.backup {
            Some(content) => {
                let _ = fs::write(&self.path, content);
            }
            None => {
                let _ = fs::remove_file(&self.path);
                if self.created_dir
                    && let Some(dir) = self.path.parent()
                {
                    let _ = fs::remove_dir(dir);
                }
            }
        }
    }
}

#[test]
fn test_tool_name() {
    let tool = create_test_tool();
    assert_eq!(tool.name(), "mcp");
}

#[test]
fn test_tool_description() {
    let tool = create_test_tool();
    assert!(tool.description().contains("MCP"));
    assert!(tool.description().contains("Model Context Protocol"));
}

#[test]
fn test_parameters_schema() {
    let tool = create_test_tool();
    let schema = tool.parameters_schema();
    assert_eq!(schema["type"], "object");
    assert!(schema["properties"]["action"].is_object());
    assert!(schema["properties"]["server"].is_object());
    assert!(schema["properties"]["command"].is_object());
}

#[test]
fn mcp_call_allows_dynamic_argument_keys_in_provider_schemas() {
    let tool = McpCallTool::new(Arc::clone(create_test_tool().manager()));
    let schema = tool.parameters_schema();
    assert_eq!(
        schema["properties"]["arguments"]["additionalProperties"],
        true
    );

    for spec in [
        &amiro_schema_dialect::registry::OPENROUTER,
        &amiro_schema_dialect::registry::OPENAI,
        &amiro_schema_dialect::registry::ANTHROPIC,
    ] {
        let normalized = amiro_schema_dialect::dialect::apply(&schema, spec);
        let arguments = &normalized["properties"]["arguments"];
        assert_eq!(arguments["type"], "object", "{}", spec.id);
        assert_eq!(arguments["additionalProperties"], true, "{}", spec.id);
        if spec.transforms.require_properties_on_objects {
            // Empty declared properties must not close the dynamic payload (#1214).
            assert_eq!(arguments["properties"], json!({}), "{}", spec.id);
        }
        assert_eq!(normalized["required"], schema["required"], "{}", spec.id);
    }
}

#[test]
fn mcp_call_dynamic_arguments_remain_ineligible_for_openai_strict_mode() {
    let tool = McpCallTool::new(Arc::clone(create_test_tool().manager()));
    let compatible =
        amiro_provider_core::openai_schema::openai_compatible_schema(&tool.parameters_schema());
    assert!(!amiro_provider_core::openai_schema::schema_supports_strict(
        &compatible
    ));
    assert_eq!(
        compatible["properties"]["arguments"]["additionalProperties"],
        true
    );
}

#[test]
fn search_name_matches_beat_description_matches() {
    let terms = vec!["calendar".to_string()];
    assert_eq!(
        match_rank(
            &terms,
            "mcp__g__calendar_events",
            "g",
            "calendar_events",
            ""
        ),
        Some(MatchRank::Name)
    );
    assert_eq!(
        match_rank(
            &terms,
            "mcp__rho__get_card",
            "rho",
            "get_card",
            "resets on calendar boundaries"
        ),
        Some(MatchRank::Description)
    );
    assert_eq!(match_rank(&terms, "mcp__x__y", "x", "y", "nothing"), None);
    // Every term must match, in any field.
    let terms = vec!["gmail".to_string(), "send".to_string()];
    assert_eq!(
        match_rank(&terms, "mcp__g__gmail_send", "g", "gmail_send", ""),
        Some(MatchRank::Name)
    );
    assert_eq!(
        match_rank(&terms, "mcp__g__gmail_read", "g", "gmail_read", ""),
        None
    );
    // An empty query lists everything.
    assert_eq!(match_rank(&[], "a", "b", "c", ""), Some(MatchRank::Name));
}

#[test]
fn search_descriptions_are_clipped() {
    assert_eq!(clip_description("  short  ", 10), "short");
    let long = "é".repeat(500);
    let clipped = clip_description(&long, 400);
    assert_eq!(clipped.chars().count(), 401);
    assert!(clipped.ends_with('…'));
}

fn search_result(n: usize, description_chars: usize) -> McpSearchResult {
    McpSearchResult {
        name: format!("mcp__s__tool_{n}"),
        server: "s".into(),
        tool: format!("tool_{n}"),
        description: "d".repeat(description_chars),
        input_schema: json!({"type": "object", "properties": {"q": {"type": "string"}}}),
    }
}

#[test]
fn search_results_fit_the_budget_adaptively() {
    // Small results come back whole, long descriptions included.
    let small = vec![search_result(0, 2_000)];
    let (out, detailed) =
        fit_search_results(&small, SEARCH_TOKEN_BUDGET).expect("serializable search results");
    assert_eq!(detailed, 1);
    assert!(out.contains(&"d".repeat(2_000)));

    // Moderately over budget: every match keeps its schema, descriptions shrink.
    let medium: Vec<_> = (0..10).map(|n| search_result(n, 4_000)).collect();
    let (out, detailed) =
        fit_search_results(&medium, SEARCH_TOKEN_BUDGET).expect("serializable search results");
    assert_eq!(detailed, 10);
    assert!(amiro_core::util::estimate_tokens(&out) <= SEARCH_TOKEN_BUDGET);
    assert!(!out.contains("more matches"));

    // Far over budget: leading matches keep detail, the rest are named.
    let large: Vec<_> = (0..400).map(|n| search_result(n, 1_000)).collect();
    let (out, detailed) =
        fit_search_results(&large, SEARCH_TOKEN_BUDGET).expect("serializable search results");
    assert!(detailed > 0 && detailed < 400, "{detailed}");
    assert!(out.contains(&format!("{} more matches", 400 - detailed)));
    assert!(out.contains("mcp__s__tool_399"));
    assert!(amiro_core::util::estimate_tokens(&out) <= SEARCH_TOKEN_BUDGET + 2_000);

    // Opting in returns everything.
    let (_, detailed) =
        fit_search_results(&large, usize::MAX).expect("serializable search results");
    assert_eq!(detailed, 400);
}

#[tokio::test]
async fn test_list_empty() {
    let tool = create_test_tool();
    let ctx = create_test_context();
    let input = json!({"action": "list"});

    let result = tool.execute(input, ctx).await.unwrap();
    assert!(result.output.contains("No MCP servers connected"));
}

#[tokio::test]
async fn test_list_shows_disabled_configured_server() {
    // Issue #436: disabled servers stay visible in the list with their
    // state, so users can see and enable them on demand.
    let mut config = crate::mcp::McpConfig::default();
    config.servers.insert(
        "off-server".to_string(),
        McpServerConfig {
            command: "some-bin".to_string(),
            args: vec![],
            env: HashMap::new(),
            shared: true,
            transport: None,
            url: None,
            headers: HashMap::new(),
            enabled: Some(false),
            disabled: None,
            timeout_secs: None,
        },
    );
    let manager = Arc::new(RwLock::new(McpManager::with_config(config)));
    let tool = McpManagementTool::new(manager);
    let ctx = create_test_context();

    let result = tool.execute(json!({"action": "list"}), ctx).await.unwrap();
    assert!(
        result.output.contains("off-server"),
        "disabled server must be listed: {}",
        result.output
    );
    assert!(
        result.output.contains("disabled in config"),
        "disabled state must be visible: {}",
        result.output
    );
}

#[tokio::test]
async fn test_connect_missing_server() {
    let tool = create_test_tool();
    let ctx = create_test_context();
    let input = json!({"action": "connect", "command": "/bin/test"});

    let result = tool.execute(input, ctx).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("server"));
}

#[tokio::test]
async fn test_connect_missing_command() {
    let tool = create_test_tool();
    let ctx = create_test_context();
    let input = json!({"action": "connect", "server": "test"});

    let result = tool.execute(input, ctx).await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("command"));
}

#[tokio::test]
async fn test_disconnect_not_connected() {
    let tool = create_test_tool();
    let ctx = create_test_context();
    let input = json!({"action": "disconnect", "server": "nonexistent"});

    let result = tool.execute(input, ctx).await.unwrap();
    assert!(result.output.contains("not connected"));
}

#[tokio::test]
async fn test_unknown_action() {
    let tool = create_test_tool();
    let ctx = create_test_context();
    let input = json!({"action": "invalid_action"});

    let result = tool.execute(input, ctx).await.unwrap();
    assert!(result.output.contains("Unknown action"));
}

#[tokio::test]
async fn test_reload_empty_config() {
    let _guard =
        LocalMcpConfigGuard::new("{\"servers\":{}}").expect("create temporary .jcode/mcp.json");
    let tool = create_test_tool();
    let ctx = create_test_context();
    let input = json!({"action": "reload"});

    let result = tool.execute(input, ctx).await.unwrap();
    // With config merging, global config may have servers.
    // If both are empty: "No servers found in config"
    // If global has servers: "Reloaded MCP config" (may show connection failures)
    assert!(
        result.output.contains("No servers")
            || result.output.contains("Empty config")
            || result.output.contains("Connected servers: 0")
            || result.output.contains("Reloaded MCP config")
    );
}

// ---- persistent add / remove ----

#[test]
fn slug_and_placeholder_format() {
    assert_eq!(normalize_slug("  My Linear_Server! ").unwrap(), "my-linear-server");
    assert!(normalize_slug("!!!").is_err());
    assert!(normalize_slug(&"a".repeat(41)).is_err());
    assert_eq!(secret_field("API-Key").unwrap(), "api_key");
    assert_eq!(
        placeholder_var("my-linear", "api_key"),
        "AMIRO_CRED_MCP_MY_LINEAR_API_KEY"
    );
}

#[test]
fn literal_secrets_are_rejected_but_placeholders_pass() {
    assert!(looks_like_literal_secret("sk-abc", false));
    assert!(looks_like_literal_secret("ghp_xxxxxxxx", false));
    assert!(looks_like_literal_secret("xoxb-123", false));
    assert!(looks_like_literal_secret("Bearer abcdefghijklmnopqrstuvwxyz", false));
    assert!(looks_like_literal_secret("abcdefghijklmnopqrstuvwxyz0123456789", false));
    assert!(!looks_like_literal_secret("Bearer ${AMIRO_CRED_MCP_X_TOKEN}", false));
    assert!(!looks_like_literal_secret("application/json", false));
    assert!(!looks_like_literal_secret("/home/user/some/long/path/to/directory", false));
    assert!(!looks_like_literal_secret("mcp-server-sequential-thinking-extra", true));
}

fn add_params(json: Value) -> McpToolInput {
    let mut value = json;
    value["action"] = json!("add");
    serde_json::from_value(value).unwrap()
}

#[test]
fn build_entry_uses_placeholders_and_rejects_typed_secrets() {
    let built = build_connector_entry(
        "linear",
        &add_params(json!({
            "server": "linear",
            "url": "https://mcp.linear.app/mcp",
            "secrets": [{"key": "authorization", "header": "Authorization", "prefix": "Bearer "}]
        })),
    )
    .unwrap();
    assert_eq!(
        built.entry["headers"]["Authorization"],
        "Bearer ${AMIRO_CRED_MCP_LINEAR_AUTHORIZATION}"
    );
    assert_eq!(built.entry["type"], "http");
    assert_eq!(built.secrets[0].0, "authorization");

    let err = build_connector_entry(
        "linear",
        &add_params(json!({
            "server": "linear",
            "url": "https://mcp.linear.app/mcp",
            "headers": {"Authorization": "Bearer abcdefghijklmnopqrstuvwxyz"}
        })),
    )
    .err()
    .expect("typed secret must be rejected");
    assert!(err.to_string().contains("secrets"));

    let stdio = build_connector_entry(
        "gh",
        &add_params(json!({
            "server": "gh", "command": "npx", "args": ["-y", "some-mcp"],
            "secrets": [{"key": "token", "env": "GITHUB_TOKEN"}]
        })),
    )
    .unwrap();
    assert_eq!(stdio.entry["env"]["GITHUB_TOKEN"], "${AMIRO_CRED_MCP_GH_TOKEN}");
    assert!(stdio.is_stdio);
}

#[test]
fn upsert_and_remove_preserve_other_entries_and_unknown_keys() {
    let mut root = json!({
        "mcpServers": {
            "composio": {"type": "http", "url": "https://x", "headers": {"x-api-key": "${COMPOSIO_API_KEY}"}, "weird": [1, {"a": null}]},
        },
        "extra": {"keep": true}
    });
    let before = root.clone();
    upsert_server_value(&mut root, "linear", json!({"url": "https://l"})).unwrap();
    assert_eq!(root["mcpServers"]["composio"], before["mcpServers"]["composio"]);
    assert_eq!(root["extra"], before["extra"]);
    assert!(root.get("servers").is_none());
    assert!(remove_server_value(&mut root, "linear").unwrap());
    assert!(!remove_server_value(&mut root, "linear").unwrap());
    assert_eq!(root, before);
}

#[cfg(unix)]
#[test]
fn atomic_write_is_0600_and_leaves_no_tmp_files() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    write_json_atomic(&path, &json!({"servers": {}})).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn approval_classification() {
    assert!(mcp_call_requires_approval(&json!({"action": "add"})));
    assert!(mcp_call_requires_approval(&json!({"action": "remove"})));
    assert!(mcp_call_requires_approval(&json!({"action": "connect", "command": "x"})));
    assert!(!mcp_call_requires_approval(&json!({"action": "list"})));
    assert!(!mcp_call_requires_approval(&json!({"action": "status"})));
    assert!(!mcp_call_requires_approval(&json!({"action": "connect", "server": "a"})));
}

#[tokio::test]
async fn add_without_secret_waits_then_remove_cleans_up() {
    let _guard = crate::storage::lock_test_env();
    let home = tempfile::tempdir().unwrap();
    let previous = std::env::var_os("AMIRO_HOME");
    crate::env::set_var("AMIRO_HOME", home.path());
    let path = home.path().join("mcp.json");
    fs::write(
        &path,
        r#"{"servers":{"composio":{"type":"http","url":"https://c.example/mcp"}},"extra":1}"#,
    )
    .unwrap();

    let tool = create_test_tool();
    let ctx = create_test_context();
    let out = tool
        .execute(
            json!({"action":"add","server":"Linear","url":"https://mcp.linear.app/mcp",
                   "secrets":[{"key":"authorization","header":"Authorization","prefix":"Bearer "}]}),
            ctx.clone(),
        )
        .await;
    let removed = tool
        .execute(json!({"action":"remove","server":"linear"}), ctx.clone())
        .await;
    let refused = tool
        .execute(json!({"action":"remove","server":"composio"}), ctx)
        .await;
    let saved_after = fs::read_to_string(&path).unwrap();

    match previous {
        Some(v) => crate::env::set_var("AMIRO_HOME", v),
        None => crate::env::remove_var("AMIRO_HOME"),
    }
    let out = out.unwrap().output;
    assert!(out.contains("Saved MCP server 'linear'"), "{out}");
    assert!(out.contains("Waiting for the user to enter authorization"), "{out}");
    assert!(out.trim_end().ends_with(
        r#"CONNECTOR_SETUP {"missingSecrets":["authorization"],"server":"linear"}"#
    ) || out.trim_end().ends_with(
        r#"CONNECTOR_SETUP {"server":"linear","missingSecrets":["authorization"]}"#
    ), "{out}");
    assert!(removed.unwrap().output.contains("Removed MCP server 'linear'"));
    assert!(refused.is_err());
    let value: Value = serde_json::from_str(&saved_after).unwrap();
    assert!(value["servers"].get("linear").is_none());
    assert!(value["servers"].get("composio").is_some());
    assert_eq!(value["extra"], 1);
}
