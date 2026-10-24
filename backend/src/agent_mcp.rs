//! Built-in MCP server that exposes Amiro's schedules to the agent.
//!
//! The runtime dials this over MCP Streamable HTTP (JSON responses only, no
//! SSE) at `POST /agent-mcp`, so a schedule created in chat and one created on
//! the Schedules page are the same record in the same store, validated by the
//! same code (`schedules::create_schedule_from` and friends).
//!
//! Auth: header `x-amiro-agent-token` must equal the secret persisted at
//! `<home>/protected/agent-mcp.token` (random 32 bytes, hex, 0600). The route
//! is mounted outside `/api` so it does not need the sidecar secret or a user
//! session; `bypasses_sidecar` is the one narrow exemption the sidecar
//! middleware in `main.rs` consults, and it only fires with a valid agent
//! token. Every call acts as the owner user (first admin).
//!
//! The `amiro` entry in the runtime's `mcp.json` carries only the
//! `${AMIRO_AGENT_MCP_TOKEN}` placeholder; the value reaches the runtime
//! through its env and `credential-env.json`.

use std::path::{Path, PathBuf};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use rand::RngCore;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

use crate::schedules;
use crate::state::{ApiError, AppState};

pub const AGENT_MCP_PATH: &str = "/agent-mcp";
pub const TOKEN_HEADER: &str = "x-amiro-agent-token";
pub const TOKEN_ENV_VAR: &str = "AMIRO_AGENT_MCP_TOKEN";
pub const SERVER_NAME: &str = "amiro";
const DEFAULT_PROTOCOL: &str = "2025-03-26";
const RUN_NOW_WAIT_SECS: u64 = 5;

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

pub fn token_path(home: &Path) -> PathBuf {
    home.join("protected").join("agent-mcp.token")
}

fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The persisted token, if present and well formed.
pub fn read_token_sync(home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(token_path(home)).ok()?;
    let token = raw.trim().to_string();
    valid_token(&token).then_some(token)
}

/// Read the token, creating it (0600, random 32 bytes hex) on first start.
pub fn ensure_token(state: &AppState) -> std::io::Result<String> {
    use std::io::Write;
    if let Some(token) = read_token_sync(&state.home) {
        return Ok(token);
    }
    let path = token_path(&state.home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    // A malformed leftover is replaced; create_new then guards a start race.
    let _ = std::fs::remove_file(&path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(token.as_bytes())?;
            file.sync_all()?;
            Ok(token)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_token_sync(&state.home).ok_or(error)
        }
        Err(error) => Err(error),
    }
}

/// True when the request carries the correct agent token (constant time).
pub fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = read_token_sync(&state.home) else {
        return false;
    };
    let provided = headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    expected.len() == provided.len() && bool::from(expected.as_bytes().ct_eq(provided.as_bytes()))
}

/// The sidecar middleware's single exemption: exactly `POST /agent-mcp` with a
/// valid agent token skips the sidecar secret. Anything else is unchanged.
pub fn bypasses_sidecar(
    state: &AppState,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> bool {
    method == Method::POST && path == AGENT_MCP_PATH && authorized(state, headers)
}

// ---------------------------------------------------------------------------
// Wiring (mcp.json + env)
// ---------------------------------------------------------------------------

pub fn mcp_entry(port: u16) -> Value {
    json!({
        "type": "streamable-http",
        "url": format!("http://127.0.0.1:{port}{AGENT_MCP_PATH}"),
        "headers": { TOKEN_HEADER: format!("${{{TOKEN_ENV_VAR}}}") },
        "shared": true,
    })
}

/// Ensure the token, write the `amiro` mcp.json entry for the real bound port,
/// refresh credential-env.json, and reload idle sessions when the entry changed.
pub async fn wire(state: &AppState, port: u16) -> Result<bool, ApiError> {
    ensure_token(state)?;
    let changed = crate::routes::connectors::write_mcp_entry_named(
        state,
        SERVER_NAME,
        Some(&mcp_entry(port)),
    )
    .await?;
    crate::credentials::sync_runtime_credential_env(state)?;
    if changed {
        crate::runtime::reload_mcp_idle_sessions(state).await;
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------
// HTTP / JSON-RPC
// ---------------------------------------------------------------------------

pub fn router() -> Router<AppState> {
    Router::new().route(
        AGENT_MCP_PATH,
        post(handle_post).get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
    )
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message.into()}})
}

fn with_session(mut response: Response, session: &str) -> Response {
    if let Ok(value) = HeaderValue::from_str(session) {
        response.headers_mut().insert("Mcp-Session-Id", value);
    }
    response
}

async fn handle_post(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&state, &headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid or missing agent token"})),
        )
            .into_response();
    }
    let session = headers
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => {
            return with_session(
                (
                    StatusCode::BAD_REQUEST,
                    Json(rpc_error(
                        Value::Null,
                        -32700,
                        format!("parse error: {error}"),
                    )),
                )
                    .into_response(),
                &session,
            );
        }
    };
    let response = match parsed {
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                if let Some(reply) = handle_message(&state, &item).await {
                    out.push(reply);
                }
            }
            if out.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(out)).into_response()
            }
        }
        other => match handle_message(&state, &other).await {
            Some(reply) => Json(reply).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    };
    with_session(response, &session)
}

/// One JSON-RPC message. `None` for notifications and client responses.
async fn handle_message(state: &AppState, message: &Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").cloned();
    let (Some(method), Some(id)) = (method, id) else {
        return None;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let protocol = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .unwrap_or(DEFAULT_PROTOCOL);
            json!({"jsonrpc":"2.0","id":id,"result":{
                "protocolVersion": protocol,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")},
            }})
        }
        "ping" => json!({"jsonrpc":"2.0","id":id,"result":{}}),
        "tools/list" => json!({"jsonrpc":"2.0","id":id,"result":{"tools": tool_definitions()}}),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if !tool_definitions()
                .iter()
                .any(|t| t.get("name").and_then(Value::as_str) == Some(name))
            {
                return Some(rpc_error(id, -32602, format!("unknown tool \"{name}\"")));
            }
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = match call_tool(state, name, &args).await {
                Ok((text, data)) => tool_result(&text, &data, false),
                Err(message) => tool_result(&message, &Value::Null, true),
            };
            json!({"jsonrpc":"2.0","id":id,"result":result})
        }
        other => rpc_error(id, -32601, format!("method not found: {other}")),
    })
}

fn tool_result(text: &str, data: &Value, is_error: bool) -> Value {
    let mut full = text.to_string();
    if !data.is_null() {
        full.push_str("\n\n```json\n");
        full.push_str(&serde_json::to_string_pretty(data).unwrap_or_default());
        full.push_str("\n```");
    }
    json!({"content":[{"type":"text","text":full}],"isError":is_error})
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

fn cadence_schema() -> Value {
    let time = json!({"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$","description":"24-hour HH:MM in the schedule's timezone"});
    json!({
        "description": "When to run. Provide exactly one variant.",
        "oneOf": [
            {"type":"object","properties":{"daily":{"type":"object","properties":{"time":time},"required":["time"]}},"required":["daily"],"additionalProperties":false},
            {"type":"object","properties":{"weekdays":{"type":"object","properties":{"time":time},"required":["time"]}},"required":["weekdays"],"additionalProperties":false},
            {"type":"object","properties":{"weekly":{"type":"object","properties":{"day":{"type":"string","enum":["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]},"time":time},"required":["day","time"]}},"required":["weekly"],"additionalProperties":false},
            {"type":"object","properties":{"monthly":{"type":"object","properties":{"day":{"type":"integer","minimum":1,"maximum":28},"time":time},"required":["day","time"]}},"required":["monthly"],"additionalProperties":false},
            {"type":"object","properties":{"every_minutes":{"type":"integer","minimum":5,"maximum":43200}},"required":["every_minutes"],"additionalProperties":false},
            {"type":"object","properties":{"once":{"type":"object","properties":{"at":{"type":"string","description":"YYYY-MM-DDTHH:MM wall time in the schedule's timezone (or RFC3339)"}},"required":["at"]}},"required":["once"],"additionalProperties":false},
            {"type":"object","properties":{"cron":{"type":"string","description":"5-field cron: minute hour day-of-month month day-of-week"}},"required":["cron"],"additionalProperties":false}
        ]
    })
}

pub fn tool_definitions() -> Vec<Value> {
    let mode = json!({"type":"string","enum":["agent","execute","notify","script"],"description":"agent: full agent turn with tools (default). execute: model-only turn. notify: post the instructions as a message. script: run a shell command directly."});
    let id = json!({"type":"string","description":"Schedule id from schedule_list"});
    vec![
        json!({"name":"schedule_list","description":"List the owner's schedules (the same ones shown on the Schedules page).","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"schedule_create","description":"Create a recurring or one-time schedule. It appears on the Schedules page.","inputSchema":{"type":"object","properties":{
            "name":{"type":"string"},
            "description":{"type":"string","description":"Short summary of what this schedule does"},
            "instructions":{"type":"string","description":"What the agent should do each run"},
            "message":{"type":"string","description":"Alias for instructions (Vellum compatibility)"},
            "script":{"type":"string","description":"Shell command to run when mode is script"},
            "mode":mode,
            "cadence":cadence_schema(),
            "expression":{"type":"string","description":"5-field cron expression (alternative to cadence)"},
            "fire_at":{"type":"string","description":"One-shot ISO-8601 timestamp (alternative to cadence)"},
            "timezone":{"type":"string","description":"IANA timezone; defaults to the owner's timezone, else UTC"},
            "enabled":{"type":"boolean","default":true},
            "quiet":{"type":"boolean","default":false,"description":"Suppress automatic completion notifications on clean runs"},
            "reuse_conversation":{"type":"boolean","default":false,"description":"Reuse the previous run's conversation across recurring runs"},
            "timeout_ms":{"type":"integer","minimum":1000,"maximum":1800000,"description":"Timeout in milliseconds for script mode (default 60000)"},
            "max_retries":{"type":"integer","minimum":0,"maximum":10,"description":"Maximum retries on failure with exponential backoff (default 3)"},
            "retry_backoff_ms":{"type":"integer","minimum":1000,"maximum":1800000,"description":"Base retry backoff in milliseconds (default 30000)"},
            "model":{"type":"string","description":"Provider-qualified model route; defaults to the deployment default"},
            "thread_id":{"type":"string","description":"Chat thread this was created from, if known"}
        },"required":["name"],"additionalProperties":false}}),
        json!({"name":"schedule_update","description":"Change a schedule. Only the provided fields change.","inputSchema":{"type":"object","properties":{
            "id":id,"name":{"type":"string"},"description":{"type":"string"},"instructions":{"type":"string"},"message":{"type":"string"},"script":{"type":"string"},"mode":mode,
            "cadence":cadence_schema(),"expression":{"type":"string"},"fire_at":{"type":"string"},"timezone":{"type":"string"},"enabled":{"type":"boolean"},
            "quiet":{"type":"boolean"},"reuse_conversation":{"type":"boolean"},"timeout_ms":{"type":"integer"},"max_retries":{"type":"integer"},"retry_backoff_ms":{"type":"integer"},
            "model":{"type":"string"}
        },"required":["id"],"additionalProperties":false}}),
        json!({"name":"schedule_delete","description":"Delete a schedule (run history is kept).","inputSchema":{"type":"object","properties":{"id":id},"required":["id"],"additionalProperties":false}}),
        json!({"name":"schedule_run_now","description":"Run a schedule immediately and return the run result.","inputSchema":{"type":"object","properties":{"id":id},"required":["id"],"additionalProperties":false}}),
        json!({"name":"schedule_runs","description":"Recent runs of a schedule (status, times, output or error, result thread). Use this to read logs.","inputSchema":{"type":"object","properties":{"id":id,"limit":{"type":"integer","minimum":1,"maximum":50,"default":5}},"required":["id"],"additionalProperties":false}}),
        json!({"name":"notify_send","description":"Send the owner a notification (Bell feed, desktop banner, web push). Use when something the owner asked to be told about happens.","inputSchema":{"type":"object","properties":{
            "title":{"type":"string","description":"Short notification title"},
            "body":{"type":"string","description":"Notification text"},
            "urgency":{"type":"string","enum":["low","normal","medium","high","critical"],"description":"How urgent it is (medium is treated as normal)"},
            "sourceEventName":{"type":"string","description":"Event name, e.g. assistant.share"},
            "threadId":{"type":"string","description":"Chat thread to link to, if any"},
            "scheduleId":{"type":"string","description":"Schedule to link to, if any"}
        },"required":["title","body"],"additionalProperties":false}}),
        json!({"name":"notify_channel_list","description":"Show where the owner's notifications can go outside Amiro (Telegram, Slack, Discord) and what is missing for each: the channel's bot is connected on the Channels page, and the owner's own account on that app is added and verified on their contact card in Contacts. Metadata only, never secret values.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"notify_channel_resend","description":"Re-send a recorded notification delivery to an external channel (uses the stored copy and the owner's verified address, records a new delivery row).","inputSchema":{"type":"object","properties":{
            "deliveryId":{"type":"string","description":"Delivery id from the Bell feed or a delivery row"},
            "channel":{"type":"string","description":"telegram, slack or discord"}
        },"required":["deliveryId","channel"],"additionalProperties":false}}),
        // --- Models & Providers configuration ---
        json!({"name":"provider_catalog","description":"List all supported LLM providers, their auth mechanism (oauth, device-code, api-key, local-endpoint), connection status, and available models.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"provider_models","description":"List available models for a specific LLM provider or all connected providers.","inputSchema":{"type":"object","properties":{
            "provider":{"type":"string","description":"Optional provider id (e.g. openai, claude, gemini, openrouter, groq, openai-compatible)"}
        },"additionalProperties":false}}),
        json!({"name":"provider_configure_from_vault","description":"Configure and connect an API-key LLM provider using its secret stored in the encrypted vault (never pass raw keys in chat). If the key is not in the vault yet, returns a SECRET_PROMPT card so the user can enter it securely in the UI.","inputSchema":{"type":"object","properties":{
            "provider":{"type":"string","description":"Provider ID (e.g. openai-api, anthropic-api, gemini-api, openrouter, groq, xai, deepseek, openai-compatible)"},
            "credential_service":{"type":"string","description":"Optional vault service name (defaults to provider ID)"},
            "credential_field":{"type":"string","description":"Optional vault field name (defaults to api_key)"},
            "api_base":{"type":"string","description":"Base URL for openai-compatible endpoints (e.g. https://host/v1)"}
        },"required":["provider"],"additionalProperties":false}}),
        json!({"name":"provider_oauth_start","description":"Start an interactive OAuth or device-code login flow for an LLM provider (claude, openai, gemini, antigravity, copilot, google) and emit an OAUTH_CONNECT interactive card in chat with the login link.","inputSchema":{"type":"object","properties":{
            "provider":{"type":"string","description":"OAuth provider ID (claude, openai, gemini, antigravity, copilot, google)"}
        },"required":["provider"],"additionalProperties":false}}),
        json!({"name":"provider_oauth_status","description":"Check the status of an active LLM provider OAuth/device-code login flow.","inputSchema":{"type":"object","properties":{
            "provider":{"type":"string","description":"OAuth provider ID"}
        },"required":["provider"],"additionalProperties":false}}),
        json!({"name":"provider_set_default_model","description":"Set Amiro's default chat model (the one new chats start on and Admin shows as \"Default model\"). For \"provider:model\" pass the part before the first colon as provider and the rest, verbatim, as model.","inputSchema":{"type":"object","properties":{
            "provider":{"type":"string","description":"Connected provider ID, e.g. opencode-go"},
            "model":{"type":"string","description":"Model ID exactly as the provider lists it, e.g. deepseek-v4.1-flash"}
        },"required":["provider","model"],"additionalProperties":false}}),
        json!({"name":"provider_disconnect","description":"Remove stored credentials for an API-key LLM provider.","inputSchema":{"type":"object","properties":{
            "provider":{"type":"string","description":"Provider ID"}
        },"required":["provider"],"additionalProperties":false}}),
        // --- Voice (TTS / STT / Live Voice) configuration ---
        json!({"name":"voice_settings_get","description":"Get current Voice & Speech settings, including active TTS/STT providers, models, voices, language, read-aloud preferences, and provider catalogs.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"voice_config_update","description":"Update Voice & Speech configuration (TTS provider, TTS voice ID, TTS model, TTS speed, STT provider, STT model, STT language, read-aloud toggles).","inputSchema":{"type":"object","properties":{
            "setting":{"type":"string","enum":["tts_provider","tts_voice_id","tts_model","tts_speed","tts_base_url","stt_provider","stt_model","stt_language","stt_base_url","read_aloud_enabled","auto_read_aloud"],"description":"The voice setting to update (optional if passing direct fields below)."},
            "value":{"description":"New value for `setting` when using Vellum-style `{setting, value}`."},
            "tts_provider":{"type":"string","description":"Active TTS provider (elevenlabs, openai, deepgram, fish-audio, xai, custom-openai, browser-native)"},
            "tts_model":{"type":"string","description":"TTS model ID"},
            "tts_voice_id":{"type":"string","description":"TTS voice ID or Aura model ID"},
            "tts_speed":{"type":"number","description":"TTS playback speed (0.25 to 4.0)"},
            "tts_base_url":{"type":"string","description":"Custom base URL for TTS provider"},
            "stt_provider":{"type":"string","description":"Active STT provider (deepgram, openai, groq, elevenlabs, xai, custom-openai, browser-native)"},
            "stt_model":{"type":"string","description":"STT model ID (e.g. nova-3, whisper-1, scribe_v1)"},
            "stt_language":{"type":"string","description":"STT language code (e.g. en, multi, es, fr, de, hi, ja)"},
            "stt_base_url":{"type":"string","description":"Custom base URL for STT provider"},
            "read_aloud_enabled":{"type":"boolean"},
            "auto_read_aloud":{"type":"boolean"}
        },"additionalProperties":false}}),
        json!({"name":"voice_list_voices","description":"List available voices for a TTS provider (queries live voice library when an API key is configured in the vault).","inputSchema":{"type":"object","properties":{
            "provider":{"type":"string","description":"TTS provider ID (elevenlabs, openai, deepgram, fish-audio, xai, custom-openai)"}
        },"additionalProperties":false}}),
        // --- Web Search Providers configuration ---
        json!({"name":"search_providers_list","description":"List all supported web search provider types (catalog), all configured search providers, and the currently active default search provider.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"search_provider_configure","description":"Configure, add, or update a web search provider (duckduckgo, bing, brave, tavily, exa, serper, firecrawl, searxng, custom, inference-provider-native). Reads API keys automatically from the encrypted vault (`<provider>/api_key` or `search.<provider>/api_key`). If a required key is missing, emits a SECRET_PROMPT card.","inputSchema":{"type":"object","properties":{
            "provider":{"type":"string","description":"Search provider kind (duckduckgo, bing, brave, tavily, exa, serper, firecrawl, searxng, custom, inference-provider-native)"},
            "name":{"type":"string","description":"Display name for the search provider"},
            "base_url":{"type":"string","description":"Base URL for searxng, firecrawl, or custom HTTP JSON search"},
            "set_active":{"type":"boolean","description":"Whether to immediately set this provider as the active default search provider (default true)"},
            "custom":{"type":"object","description":"Optional custom HTTP JSON search configuration (endpoint, method, query_param, count_param, results_pointer, title_pointer, url_pointer, snippet_pointer)"}
        },"required":["provider"],"additionalProperties":false}}),
        json!({"name":"search_provider_activate","description":"Set a configured web search provider as the active default.","inputSchema":{"type":"object","properties":{
            "id":{"type":"string","description":"Search provider ID, kind (e.g. tavily, duckduckgo, brave), or name"}
        },"required":["id"],"additionalProperties":false}}),
        json!({"name":"search_provider_test","description":"Run a live search test against a configured search provider and report latency and result count.","inputSchema":{"type":"object","properties":{
            "id":{"type":"string","description":"Search provider ID, kind, or name"}
        },"required":["id"],"additionalProperties":false}}),
        json!({"name":"search_provider_delete","description":"Delete a configured search provider.","inputSchema":{"type":"object","properties":{
            "id":{"type":"string","description":"Search provider ID"}
        },"required":["id"],"additionalProperties":false}}),
        // --- MCP Connectors & Composio OAuth ---
        json!({"name":"mcp_connectors_list","description":"List all MCP connectors and Composio status from the unified Connectors registry.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"mcp_oauth_start","description":"Start an interactive browser OAuth flow for a remote MCP server (e.g. linear, notion, figma, sentry) and emit an OAUTH_CONNECT card with the authorization URL.","inputSchema":{"type":"object","properties":{
            "server":{"type":"string","description":"Configured remote MCP server slug"}
        },"required":["server"],"additionalProperties":false}}),
        json!({"name":"mcp_oauth_status","description":"Check the status of an active MCP server OAuth login flow.","inputSchema":{"type":"object","properties":{
            "server":{"type":"string","description":"Configured remote MCP server slug"}
        },"required":["server"],"additionalProperties":false}}),
        json!({"name":"composio_toolkits_list","description":"List available 1-click OAuth app toolkits from Composio (Gmail, Google Calendar, Slack, Notion, GitHub, Linear, Outlook, etc.) and their connection status.","inputSchema":{"type":"object","properties":{
            "search":{"type":"string","description":"Optional search query (e.g. gmail, slack, github, linear, notion)"},
            "limit":{"type":"integer","description":"Max items to return (default 20)"}
        },"additionalProperties":false}}),
        json!({"name":"composio_connect_start","description":"Start a 1-click OAuth connection for a Composio app toolkit (e.g. gmail, googlecalendar, slack, github, notion, linear) and emit an OAUTH_CONNECT card in chat with the OAuth redirect link.","inputSchema":{"type":"object","properties":{
            "toolkit":{"type":"string","description":"Composio toolkit slug (e.g. gmail, googlecalendar, slack, github, notion, linear)"},
            "callback_url":{"type":"string","description":"Optional callback URL"}
        },"required":["toolkit"],"additionalProperties":false}}),
        json!({"name":"composio_connection_status","description":"Check the status of a Composio connected account and sync its tools into the runtime MCP config when active.","inputSchema":{"type":"object","properties":{
            "connection_id":{"type":"string","description":"Composio connection ID returned by composio_connect_start"}
        },"required":["connection_id"],"additionalProperties":false}}),
        // --- File Artifacts (Vellum-style workspace documents) ---
        json!({"name":"artifact_create","description":"Create a file artifact the user can view in the artifact panel (markdown, html, code, csv, pdf, docx). Use when the user asks for a document, report, or export, or when you produce one from chat. Saved under workspace/artifacts and shown in the UI.","inputSchema":{"type":"object","properties":{
            "title":{"type":"string","description":"Display title"},
            "kind":{"type":"string","description":"markdown, html, code, text, csv, json, pdf or docx (inferred from filename when omitted)"},
            "language":{"type":"string","description":"Code language for kind=code (e.g. python, typescript)"},
            "filename":{"type":"string","description":"Filename with extension, e.g. report.md, index.html, data.csv"},
            "mime":{"type":"string","description":"Optional MIME override"},
            "contentText":{"type":"string","description":"UTF-8 text content (for markdown, html, code, csv, text)"},
            "contentBase64":{"type":"string","description":"Base64 bytes (for pdf, docx, or any binary); use instead of contentText"}
        },"additionalProperties":false}}),
        json!({"name":"artifact_list","description":"List the owner's file artifacts (the same ones shown in the artifact panel).","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"artifact_read","description":"Read one file artifact (metadata plus inline text when it is a small text artifact).","inputSchema":{"type":"object","properties":{"id":{"type":"string","description":"Artifact id from artifact_list"}},"required":["id"],"additionalProperties":false}}),
        json!({"name":"artifact_update","description":"Update a file artifact's title and/or content (revises the saved workspace file).","inputSchema":{"type":"object","properties":{
            "id":{"type":"string"},
            "title":{"type":"string"},
            "contentText":{"type":"string"},
            "contentBase64":{"type":"string"}
        },"required":["id"],"additionalProperties":false}}),
        json!({"name":"artifact_delete","description":"Delete a file artifact and its workspace file.","inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}}),
        // --- Contacts & Relationship Graph ---
        json!({"name":"contact_search","description":"Search contacts by name, channel address, or channel type.","inputSchema":{"type":"object","properties":{
            "query":{"type":"string","description":"Search by display name (partial match)"},
            "channel_address":{"type":"string","description":"Search by channel address (email, phone, handle)"},
            "channel_type":{"type":"string","description":"Filter by channel type (slack, telegram, phone, email, discord)"},
            "limit":{"type":"integer","description":"Max results (default 50)"}
        },"additionalProperties":false}}),
        json!({"name":"contact_create","description":"Create a contact with optional channel address and notes.","inputSchema":{"type":"object","properties":{
            "name":{"type":"string","description":"Contact display name"},
            "notes":{"type":"string","description":"Notes about this contact"},
            "channel_type":{"type":"string","description":"Optional initial channel type (slack, telegram, phone, email, discord)"},
            "channel_address":{"type":"string","description":"Channel address (handle, phone, email)"}
        },"required":["name"],"additionalProperties":false}}),
        json!({"name":"contact_merge","description":"Merge two contacts when you discover they are the same person. Absorbs donor's channels and notes into keeper and deletes donor.","inputSchema":{"type":"object","properties":{
            "keep_id":{"type":"string","description":"ID of the contact to keep (survivor)"},
            "merge_id":{"type":"string","description":"ID of the contact to merge into the kept one (donor, will be deleted)"}
        },"required":["keep_id","merge_id"],"additionalProperties":false}}),
        // --- Channels & Integration Adapters ---
        json!({"name":"channel_readiness_get","description":"Check operational readiness and connection health of communication channels (Slack, Telegram, Discord, Phone, Email).","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"channel_policy_set","description":"Set the admission policy (trust floor) for a communication channel (no_one, guardian_only, trusted_contacts, any_contact, strangers).","inputSchema":{"type":"object","properties":{
            "channel_type":{"type":"string","description":"Channel type (slack, telegram, discord, phone, email)"},
            "policy":{"type":"string","enum":["no_one","guardian_only","trusted_contacts","any_contact","strangers"],"description":"Admission trust floor"}
        },"required":["channel_type","policy"],"additionalProperties":false}}),
        // --- Encrypted Vault & Interactive UI Surfaces ---
        json!({"name":"credentials_list","description":"List all credentials stored in Amiro's encrypted vault (metadata and env var names only, never secret values).","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"ui_prompt_secret","description":"Render an encrypted secret input card in the chat UI so the user can securely enter an API key, token, or secret into the vault without ever typing it in plain chat.","inputSchema":{"type":"object","properties":{
            "service":{"type":"string","description":"Vault service slug (e.g. openai, anthropic, elevenlabs, deepgram, tavily, composio, github)"},
            "field":{"type":"string","description":"Vault field slug (default: api_key)"},
            "label":{"type":"string","description":"Human-readable label shown on the card (e.g. 'ElevenLabs API Key')"},
            "description":{"type":"string","description":"Short instructions on where to get the key and what it unlocks"},
            "placeholder":{"type":"string","description":"Input placeholder (e.g. 'sk-...')"},
            "purpose":{"type":"string","description":"Purpose badge shown on the card"},
            "allowed_domains":{"type":"array","items":{"type":"string"},"description":"Optional allowed domains for brokered requests"}
        },"required":["service","label"],"additionalProperties":false}}),
        json!({"name":"ui_navigate","description":"Emit an interactive navigation card or open a specific Amiro settings/admin/superpowers page for the user.","inputSchema":{"type":"object","properties":{
            "page":{"type":"string","enum":["providers","voice","search","connectors","credentials","integrations","general","notifications","usage","schedules","superpowers","personality","memory","workspace"],"description":"Target Amiro page to open or link to"}
        },"required":["page"],"additionalProperties":false}}),
        // --- Your desktop (the TV) ---
        json!({"name":"desktop_open","description":"Open something on your own Linux desktop, which the user watches live on the TV screen (shown in the chat): a Chromium tab at a URL, a Files window at a folder, or a terminal in a folder. Starts the desktop if it is off. Folders are absolute or relative to /home/agent and must exist. Returns every open window with its exact folder or URL.","inputSchema":{"type":"object","properties":{
            "app":{"type":"string","enum":["browser","files","terminal"],"description":"What to open"},
            "target":{"type":"string","description":"browser: an http(s) URL. files/terminal: a folder (default /home/agent)."}
        },"required":["app"],"additionalProperties":false}}),
        json!({"name":"desktop_state","description":"See what is open on your desktop (the TV): each window, which one is in front, the exact folder each Files and Terminal window shows, and the URL of each browser tab.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"ui_render_openui","description":"Render a live interactive OpenUI Generative UI surface inline in the chat transcript (KPI metric cards, interactive Recharts bar/line/pie charts, sortable status tables, interactive Q&A QuestionCard, value-pasting FormInput/FormTextarea/FormSlider/FormSwitch, encrypted SecretVaultCard for API keys/passwords, tabbed comparisons, step trackers, and clickable follow-up chips). Pass an OpenUI Lang program (`root = Stack([...])`) in `code` or pick a built-in daily-use `preset` (`daily_brief`, `budget_planner`, `sprint_tracker`, `agent_data_intake`, `inbox_cleanup_setup`). Never include raw secret values in OpenUI code; use SecretVaultCard to prompt the user into the encrypted vault.","inputSchema":{"type":"object","properties":{
            "title":{"type":"string","description":"Short card title displayed in the OpenUI surface header"},
            "code":{"type":"string","description":"OpenUI Lang program starting with `root = ...` (optional when `preset` is specified)"},
            "preset":{"type":"string","enum":["daily_brief","budget_planner","sprint_tracker","agent_data_intake","inbox_cleanup_setup"],"description":"Optional built-in daily-use interactive OpenUI template when `code` is omitted"}
        },"additionalProperties":false}}),
    ]
}

fn err_text(error: ApiError) -> String {
    error.1
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        _ => Err(format!("{key} must be a string")),
    }
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    arg_str(args, key)?
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

async fn active_provider(state: &AppState, key: &str, fallback: &str) -> Result<String, String> {
    Ok(crate::routes::voice::settings_payload(state)
        .await
        .map_err(err_text)?
        .get("settings")
        .and_then(|settings| settings.get(key))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string())
}

fn parse_time(raw: &Value, label: &str) -> Result<(u32, u32), String> {
    let text = raw.as_str().unwrap_or("");
    let bad = || format!("{label}.time must be HH:MM in 24-hour time, got \"{text}\"");
    let (h, m) = text.split_once(':').ok_or_else(bad)?;
    if h.len() != 2 || m.len() != 2 {
        return Err(bad());
    }
    let (h, m) = (
        h.parse::<u32>().map_err(|_| bad())?,
        m.parse::<u32>().map_err(|_| bad())?,
    );
    if h > 23 || m > 59 {
        return Err(bad());
    }
    Ok((h, m))
}

/// Map the friendly cadence onto the internal schedule spec
/// (`{kind:"cron"|"interval"|"once", ...}`). Cron is evaluated in the
/// schedule's timezone by the shared scheduler code.
pub fn cadence_to_spec(cadence: &Value) -> Result<Value, String> {
    let object = cadence.as_object().ok_or_else(|| {
        "cadence must be an object with exactly one of: daily, weekdays, weekly, monthly, every_minutes, once, cron".to_string()
    })?;
    if object.len() != 1 {
        return Err("cadence must have exactly one key: daily, weekdays, weekly, monthly, every_minutes, once or cron".into());
    }
    let (key, value) = object.iter().next().expect("len checked");
    let cron = |expr: String| json!({"kind":"cron","expression":expr});
    match key.as_str() {
        "daily" => {
            let (h, m) = parse_time(&value["time"], "daily")?;
            Ok(cron(format!("{m} {h} * * *")))
        }
        "weekdays" => {
            let (h, m) = parse_time(&value["time"], "weekdays")?;
            Ok(cron(format!("{m} {h} * * 1-5")))
        }
        "weekly" => {
            let (h, m) = parse_time(&value["time"], "weekly")?;
            let day = value["day"].as_str().unwrap_or("").trim().to_ascii_lowercase();
            let dow = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"]
                .iter()
                .position(|d| *d == day)
                .ok_or_else(|| format!("weekly.day must be a weekday name such as \"monday\", got \"{day}\""))?;
            Ok(cron(format!("{m} {h} * * {dow}")))
        }
        "monthly" => {
            let (h, m) = parse_time(&value["time"], "monthly")?;
            let day = value["day"].as_i64().filter(|d| (1..=28).contains(d))
                .ok_or("monthly.day must be an integer from 1 to 28")?;
            Ok(cron(format!("{m} {h} {day} * *")))
        }
        "every_minutes" => {
            let n = value.as_i64().ok_or("every_minutes must be an integer number of minutes")?;
            Ok(json!({"kind":"interval","minutes":n}))
        }
        "once" => {
            let at = value["at"].as_str().filter(|s| !s.trim().is_empty())
                .ok_or("once.at is required (YYYY-MM-DDTHH:MM)")?;
            Ok(json!({"kind":"once","at":at}))
        }
        "cron" => {
            let expr = value.as_str().filter(|s| !s.trim().is_empty())
                .ok_or("cron must be a 5-field expression string")?;
            Ok(cron(expr.trim().to_string()))
        }
        other => Err(format!("unknown cadence \"{other}\"; use daily, weekdays, weekly, monthly, every_minutes, once or cron")),
    }
}

fn summary(schedule: &Value) -> Value {
    let pick = |k: &str| schedule.get(k).cloned().unwrap_or(Value::Null);
    json!({
        "id": pick("id"), "name": pick("name"), "description": pick("description"),
        "mode": pick("mode"), "enabled": pick("enabled"),
        "quiet": pick("quiet"), "reuseConversation": pick("reuseConversation"),
        "cadenceDescription": pick("cadenceDescription"),
        "nextRunAt": pick("nextRunAt"), "lastRunAt": pick("lastRunAt"),
        "lastStatus": pick("lastStatus"), "status": pick("status"),
        "createdBy": pick("createdBy"),
    })
}

fn detail(schedule: &Value) -> Value {
    let mut out = summary(schedule);
    let pick = |k: &str| schedule.get(k).cloned().unwrap_or(Value::Null);
    if let Some(map) = out.as_object_mut() {
        map.insert("instructions".into(), pick("prompt"));
        map.insert("script".into(), pick("script"));
        map.insert("timezone".into(), pick("timezone"));
        map.insert("model".into(), pick("model"));
        map.insert("timeoutMs".into(), pick("timeoutMs"));
        map.insert("maxRetries".into(), pick("maxRetries"));
        map.insert("retryBackoffMs".into(), pick("retryBackoffMs"));
        map.insert("createdFromThreadId".into(), pick("createdFromThreadId"));
    }
    out
}

fn run_view(run: &Value) -> Value {
    let pick = |k: &str| run.get(k).cloned().unwrap_or(Value::Null);
    let status = run.get("status").and_then(Value::as_str).unwrap_or("");
    let preview = pick("outputPreview");
    let mut out = json!({
        "id": pick("id"), "status": pick("status"),
        "scheduledAt": pick("scheduledAt"), "startedAt": pick("startedAt"),
        "finishedAt": pick("finishedAt"), "durationMs": pick("durationMs"),
        "estimatedCostUsd": pick("estimatedCostUsd"),
        "outputPreview": preview.clone(),
        "output": pick("output"),
        "threadId": pick("threadId"),
    });
    if let Some(err) = run.get("error").filter(|v| !v.is_null()) {
        out["error"] = err.clone();
    } else if !matches!(status, "ok" | "running" | "success") {
        out["error"] = preview;
    }
    out
}

async fn owner_id(state: &AppState) -> Result<String, String> {
    crate::agent_home::owner_user(state)
        .await
        .and_then(|u| u.get("id").and_then(Value::as_str).map(str::to_string))
        .ok_or_else(|| "no owner account exists yet; create the first account in Amiro".to_string())
}

async fn default_timezone(state: &AppState) -> String {
    let owner = crate::agent_home::owner_user(state).await;
    let doc = crate::agent_home::load_state(state)
        .await
        .unwrap_or_else(|_| json!({}));
    let tz = crate::agent_home::owner_timezone(state, owner.as_ref(), &doc).await;
    if tz.parse::<chrono_tz::Tz>().is_ok() {
        tz
    } else {
        "UTC".into()
    }
}

fn line(schedule: &Value) -> String {
    format!(
        "{} ({}, {}, {})",
        schedule["name"].as_str().unwrap_or(""),
        schedule["mode"].as_str().unwrap_or(""),
        schedule["cadenceDescription"].as_str().unwrap_or(""),
        if schedule["enabled"].as_bool().unwrap_or(false) {
            "enabled"
        } else {
            "paused"
        },
    )
}

async fn call_tool(state: &AppState, name: &str, args: &Value) -> Result<(String, Value), String> {
    let uid = owner_id(state).await?;
    match name {
        "schedule_list" => {
            let list = schedules::list_schedules(state, &uid)
                .await
                .map_err(err_text)?;
            let items: Vec<Value> = list.iter().map(summary).collect();
            let text = if items.is_empty() {
                "No schedules yet.".to_string()
            } else {
                format!(
                    "{} schedule(s):\n{}",
                    items.len(),
                    list.iter()
                        .map(|s| format!("- {}", line(s)))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            };
            Ok((text, json!({"schedules": items})))
        }
        "schedule_create" => {
            let mode = arg_str(args, "mode")?
                .filter(|m| !m.is_empty())
                .unwrap_or("agent");
            let timezone = match arg_str(args, "timezone")?.filter(|t| !t.trim().is_empty()) {
                Some(t) => t.to_string(),
                None => default_timezone(state).await,
            };
            let spec = if let Some(cadence) = args.get("cadence").filter(|c| !c.is_null()) {
                cadence_to_spec(cadence)?
            } else if let Some(fire_at) = arg_str(args, "fire_at")?.filter(|s| !s.trim().is_empty()) {
                json!({"kind": "once", "at": fire_at.trim()})
            } else if let Some(expr) = arg_str(args, "expression")?.filter(|s| !s.trim().is_empty()) {
                json!({"kind": "cron", "expression": expr.trim()})
            } else {
                cadence_to_spec(&Value::Null)?
            };
            let instructions = arg_str(args, "instructions")?
                .filter(|s| !s.trim().is_empty())
                .or(arg_str(args, "message")?.filter(|s| !s.trim().is_empty()))
                .or_else(|| {
                    if mode == "script" {
                        args.get("script").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
                    } else {
                        None
                    }
                })
                .ok_or_else(|| "instructions is required".to_string())?;
            let mut body = json!({
                "name": require_str(args, "name")?,
                "prompt": instructions,
                "mode": mode,
                "timezone": timezone,
                "schedule": spec,
                "enabled": args.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            });
            if let Some(desc) = arg_str(args, "description")? {
                body["description"] = json!(desc);
            }
            if let Some(sc) = arg_str(args, "script")?.filter(|s| !s.trim().is_empty()) {
                body["script"] = json!(sc);
            }
            if let Some(quiet) = args.get("quiet").and_then(Value::as_bool) {
                body["quiet"] = json!(quiet);
            }
            if let Some(reuse) = args
                .get("reuse_conversation")
                .or_else(|| args.get("reuseConversation"))
                .and_then(Value::as_bool)
            {
                body["reuseConversation"] = json!(reuse);
            }
            if let Some(timeout_ms) = args
                .get("timeout_ms")
                .or_else(|| args.get("timeoutMs"))
                .and_then(Value::as_u64)
            {
                body["timeoutMs"] = json!(timeout_ms);
            }
            if let Some(max_retries) = args
                .get("max_retries")
                .or_else(|| args.get("maxRetries"))
                .and_then(Value::as_i64)
            {
                body["maxRetries"] = json!(max_retries);
            }
            if let Some(backoff_ms) = args
                .get("retry_backoff_ms")
                .or_else(|| args.get("retryBackoffMs"))
                .and_then(Value::as_i64)
            {
                body["retryBackoffMs"] = json!(backoff_ms);
            }
            if let Some(model) = arg_str(args, "model")?.filter(|m| !m.trim().is_empty()) {
                body["model"] = json!(model);
            }
            let thread = arg_str(args, "thread_id")?
                .filter(|t| !t.trim().is_empty())
                .map(str::to_string);
            let created = schedules::create_schedule_from(state, &uid, &body, "agent", thread)
                .await
                .map_err(err_text)?;
            Ok((
                format!(
                    "Created schedule: {}. Next run: {}. View it on the Schedules page.",
                    line(&created),
                    created["nextRunAt"].as_str().unwrap_or("none")
                ),
                json!({"schedule": detail(&created)}),
            ))
        }
        "schedule_update" => {
            let id = require_str(args, "id")?;
            let mut patch = serde_json::Map::new();
            for (arg, field) in [
                ("name", "name"),
                ("description", "description"),
                ("instructions", "prompt"),
                ("message", "prompt"),
                ("script", "script"),
                ("mode", "mode"),
                ("timezone", "timezone"),
                ("model", "model"),
            ] {
                if let Some(value) = arg_str(args, arg)? {
                    patch.insert(field.into(), json!(value));
                }
            }
            if let Some(enabled) = args.get("enabled").and_then(Value::as_bool) {
                patch.insert("enabled".into(), json!(enabled));
            }
            if let Some(quiet) = args.get("quiet").and_then(Value::as_bool) {
                patch.insert("quiet".into(), json!(quiet));
            }
            if let Some(reuse) = args
                .get("reuse_conversation")
                .or_else(|| args.get("reuseConversation"))
                .and_then(Value::as_bool)
            {
                patch.insert("reuseConversation".into(), json!(reuse));
            }
            if let Some(timeout_ms) = args
                .get("timeout_ms")
                .or_else(|| args.get("timeoutMs"))
                .and_then(Value::as_u64)
            {
                patch.insert("timeoutMs".into(), json!(timeout_ms));
            }
            if let Some(max_retries) = args
                .get("max_retries")
                .or_else(|| args.get("maxRetries"))
                .and_then(Value::as_i64)
            {
                patch.insert("maxRetries".into(), json!(max_retries));
            }
            if let Some(backoff_ms) = args
                .get("retry_backoff_ms")
                .or_else(|| args.get("retryBackoffMs"))
                .and_then(Value::as_i64)
            {
                patch.insert("retryBackoffMs".into(), json!(backoff_ms));
            }
            if let Some(cadence) = args.get("cadence").filter(|c| !c.is_null()) {
                patch.insert("schedule".into(), cadence_to_spec(cadence)?);
            } else if let Some(fire_at) = arg_str(args, "fire_at")?.filter(|s| !s.trim().is_empty()) {
                patch.insert("schedule".into(), json!({"kind": "once", "at": fire_at.trim()}));
            } else if let Some(expr) = arg_str(args, "expression")?.filter(|s| !s.trim().is_empty()) {
                patch.insert("schedule".into(), json!({"kind": "cron", "expression": expr.trim()}));
            }
            if patch.is_empty() {
                return Err("nothing to update: provide at least one of name, description, instructions, script, mode, cadence, timezone, enabled, quiet, reuse_conversation, model".into());
            }
            let updated = schedules::update_schedule(state, &uid, id, &Value::Object(patch))
                .await
                .map_err(err_text)?;
            Ok((
                format!("Updated schedule: {}.", line(&updated)),
                json!({"schedule": detail(&updated)}),
            ))
        }
        "schedule_delete" => {
            let id = require_str(args, "id")?;
            schedules::delete_schedule(state, &uid, id)
                .await
                .map_err(err_text)?;
            Ok((format!("Deleted schedule {id}."), json!({"deleted": id})))
        }
        "schedule_run_now" => {
            let id = require_str(args, "id")?;
            let (_, run) = schedules::run_schedule_now(state, &uid, id)
                .await
                .map_err(err_text)?;
            let run_id = run["id"].as_str().unwrap_or("").to_string();
            let mut current = run;
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_secs(RUN_NOW_WAIT_SECS);
            while current["status"].as_str() == Some("running")
                && std::time::Instant::now() < deadline
            {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                if let Ok(runs) = schedules::list_runs(state, &uid, id).await {
                    if let Some(found) = runs
                        .into_iter()
                        .find(|r| r["id"].as_str() == Some(run_id.as_str()))
                    {
                        current = found;
                    }
                }
            }
            let view = run_view(&current);
            let status = view["status"].as_str().unwrap_or("").to_string();
            let text = if status == "running" {
                "Run started and is executing in the background (runs can take several minutes on large inboxes). Do NOT sleep or poll in a loop; tell the user the run has started and will appear in their Schedules page run history and Bell notifications when complete."
                    .to_string()
            } else {
                format!(
                    "Run finished with status \"{status}\".{}",
                    view["outputPreview"]
                        .as_str()
                        .map(|p| format!(" Output: {p}"))
                        .unwrap_or_default()
                )
            };
            Ok((text, json!({"run": view})))
        }
        "schedule_runs" => {
            let id = require_str(args, "id")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(5)
                .clamp(1, 50) as usize;
            let runs = schedules::list_runs(state, &uid, id)
                .await
                .map_err(err_text)?;
            let views: Vec<Value> = runs.iter().take(limit).map(run_view).collect();
            let text = if views.is_empty() {
                "No runs yet.".to_string()
            } else {
                format!(
                    "{} most recent run(s):\n{}",
                    views.len(),
                    views
                        .iter()
                        .map(|r| format!(
                            "- {} at {}: {}",
                            r["status"].as_str().unwrap_or(""),
                            r["startedAt"]
                                .as_str()
                                .or(r["scheduledAt"].as_str())
                                .unwrap_or(""),
                            r["outputPreview"].as_str().unwrap_or("(no output)")
                        ))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            };
            Ok((text, json!({"runs": views})))
        }
        "notify_send" => {
            let body = json!({
                "sourceChannel": "assistant_tool",
                "sourceEventName": arg_str(args, "sourceEventName")?.filter(|s| !s.trim().is_empty()).unwrap_or("assistant.share"),
                "title": require_str(args, "title")?,
                "body": require_str(args, "body")?,
                "urgency": arg_str(args, "urgency")?.filter(|s| !s.trim().is_empty()).unwrap_or("normal"),
                "threadId": arg_str(args, "threadId")?.filter(|s| !s.trim().is_empty()),
                "scheduleId": arg_str(args, "scheduleId")?.filter(|s| !s.trim().is_empty()),
            });
            let emitted = crate::notify::emit_signal(state, &uid, &body)
                .await
                .map_err(err_text)?;
            let title = emitted
                .get("item")
                .and_then(|item| item.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok((
                format!("Notification sent: {title}. It appears in the owner's Bell feed."),
                json!({"notification": emitted.get("item").cloned().unwrap_or(Value::Null)}),
            ))
        }
        "notify_channel_list" => {
            let listed = crate::routes::notify_channels::list_channels(state, &uid)
                .await
                .map_err(err_text)?;
            let lines: Vec<String> = listed
                .get("channels")
                .and_then(|c| c.as_array())
                .map(|channels| {
                    channels
                        .iter()
                        .map(|c| {
                            let channel = c.get("channel").and_then(Value::as_str).unwrap_or("?");
                            let step = match c.get("nextStep").and_then(Value::as_str).unwrap_or("") {
                                "ready" => "ready: notifications go to your verified account",
                                "connect_bot" => "connect its bot on the Channels page",
                                "add_address" => "add your account to your contact card in Contacts",
                                "verify_address" => "verify your account on your contact card in Contacts",
                                "fix_address" => "your saved account cannot receive direct messages; add your user id in Contacts",
                                _ => "only the owner's notifications go outside Amiro",
                            };
                            format!("{channel}: {step}")
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok((format!("External notification channels:\n{}", lines.join("\n")), listed))
        }
        "notify_channel_resend" => {
            let delivery_id = require_str(args, "deliveryId")?;
            let channel = require_str(args, "channel")?.to_lowercase();
            let resent = crate::routes::notify_channels::resend_to_channel(state, &uid, delivery_id, &channel)
                .await
                .map_err(err_text)?;
            let status = resent.get("status").and_then(Value::as_str).unwrap_or("failed");
            Ok((
                format!("Resend to {channel}: {status}."),
                json!({"resend": resent}),
            ))
        }

        // ===================================================================
        // LLM Models & Providers
        // ===================================================================
        "provider_catalog" => {
            let catalog = crate::routes::providers_catalog::catalog_payload(state).await;
            let providers = catalog.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut summary_lines = Vec::new();
            for p in &providers {
                let id = p.get("id").and_then(Value::as_str).unwrap_or("");
                let name = p.get("display_name").or_else(|| p.get("name")).and_then(Value::as_str).unwrap_or(id);
                let mechanism = p.get("mechanism").and_then(Value::as_str).unwrap_or("unknown");
                let connected = p.get("connected").and_then(Value::as_bool).unwrap_or(false);
                summary_lines.push(format!(
                    "- **{}** (`{}`): {} · {}",
                    name,
                    id,
                    mechanism,
                    if connected { "Connected" } else { "Not configured" }
                ));
            }
            let text = format!(
                "Amiro supports {} provider(s):\n{}",
                providers.len(),
                summary_lines.join("\n")
            );
            Ok((text, catalog))
        }

        "provider_models" => {
            let provider_filter = arg_str(args, "provider")?.map(str::to_lowercase);
            let catalog = crate::models::build_catalog(state).await;
            let providers = catalog.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
            let filtered: Vec<Value> = providers
                .into_iter()
                .filter(|p| {
                    if let Some(ref wanted) = provider_filter {
                        p.get("id").and_then(Value::as_str).map(|s| s.eq_ignore_ascii_case(wanted)).unwrap_or(false)
                    } else {
                        true
                    }
                })
                .collect();
            let mut lines = Vec::new();
            for p in &filtered {
                let id = p.get("id").and_then(Value::as_str).unwrap_or("");
                let name = p.get("name").and_then(Value::as_str).unwrap_or(id);
                let models: Vec<&str> = p.get("models").and_then(Value::as_array)
                    .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let selected = p.get("selectedModel").and_then(Value::as_str).unwrap_or("");
                lines.push(format!(
                    "### {} (`{}`)\nSelected: `{selected}`\nModels ({}): {}",
                    name,
                    id,
                    models.len(),
                    if models.is_empty() { "none available (connect provider first)".to_string() } else { models.join(", ") }
                ));
            }
            let text = if lines.is_empty() {
                format!("No models found for provider filter \"{}\".", provider_filter.unwrap_or_default())
            } else {
                lines.join("\n\n")
            };
            Ok((text, json!({"providers": filtered})))
        }

        "provider_configure_from_vault" => {
            let provider = require_str(args, "provider")?.to_lowercase();
            let cred_service = arg_str(args, "credential_service")?
                .map(str::to_string)
                .unwrap_or_else(|| provider.clone());
            let cred_field = arg_str(args, "credential_field")?
                .map(str::to_string)
                .unwrap_or_else(|| "api_key".to_string());
            let api_base = arg_str(args, "api_base")?.unwrap_or("");

            // Check if credential exists in vault
            let secret_opt = crate::credentials::get_plaintext(state, &cred_service, &cred_field).await.map_err(err_text)?;
            match secret_opt {
                Some(secret) => {
                    let key = secret.expose();
                    crate::routes::providers_catalog::store_api_key(state, &provider, key, api_base).await.map_err(err_text)?;
                    let text = format!("Successfully connected provider \"{provider}\" using the encrypted credential in vault ({cred_service}/{cred_field}).");
                    Ok((text, json!({"provider": provider, "connected": true})))
                }
                None => {
                    // Prompt the user securely via SECRET_PROMPT card
                    let label = format!("{provider} API Key");
                    let prompt_json = json!({
                        "service": cred_service,
                        "field": cred_field,
                        "label": label,
                        "description": format!("Enter your {provider} API key. It is saved directly to Amiro's encrypted vault and never shown in chat."),
                        "purpose": "Model provider authentication",
                        "placeholder": "sk-..."
                    });
                    let text = format!(
                        "A secret for provider \"{provider}\" ({cred_service}/{cred_field}) is not in the vault yet. \
                        Please enter it in the secure card below.\n\n\
                        SECRET_PROMPT {}",
                        prompt_json
                    );
                    Ok((text, json!({"status": "needs_secret", "prompt": prompt_json})))
                }
            }
        }

        "provider_oauth_start" => {
            let provider = require_str(args, "provider")?.to_lowercase();
            let flow_res = crate::routes::provider_login::start_oauth_for_user(state, &uid, &provider).await.map_err(err_text)?;
            let auth_url = flow_res.get("authorizationUrl").and_then(Value::as_str).unwrap_or("");
            let user_code = flow_res.get("userCode").and_then(Value::as_str);
            let flow_type = flow_res.get("flow").and_then(Value::as_str).unwrap_or("authorization_code");
            
            let connect_card = json!({
                "type": "provider",
                "provider": provider,
                "flow": flow_type,
                "authorizationUrl": auth_url,
                "userCode": user_code,
            });

            let text = if let Some(code) = user_code {
                format!(
                    "Device code authorization started for **{provider}**!\n\
                    1. Open the login URL: [{auth_url}]({auth_url})\n\
                    2. Enter your code: `{code}`\n\n\
                    OAUTH_CONNECT {}",
                    connect_card
                )
            } else {
                format!(
                    "Click the link below to authorize **{provider}**:\n\
                    👉 [Authorize {provider}]({auth_url})\n\n\
                    After approving in your browser, return here to complete setup.\n\n\
                    OAUTH_CONNECT {}",
                    connect_card
                )
            };
            Ok((text, flow_res))
        }

        "provider_oauth_status" => {
            let provider = require_str(args, "provider")?.to_lowercase();
            let status = crate::routes::provider_login::oauth_status_for_user(&uid, &provider).await.map_err(err_text)?;
            let st = status.get("status").and_then(Value::as_str).unwrap_or("unknown");
            let text = format!("OAuth status for \"{provider}\": **{st}**");
            Ok((text, status))
        }

        "provider_set_default_model" => {
            let provider = require_str(args, "provider")?;
            let model = require_str(args, "model")?;
            let route = crate::models::set_runtime_default_model(state, provider, model)
                .await
                .map_err(err_text)?;
            let text = format!("Default model updated to `{route}`.");
            Ok((text, json!({"provider": provider, "model": route})))
        }

        "provider_disconnect" => {
            let provider = require_str(args, "provider")?.to_lowercase();
            let res = crate::routes::providers_catalog::remove_api_key(state, &provider).await.map_err(err_text)?;
            let text = format!("Disconnected provider \"{provider}\" and removed its API key.");
            Ok((text, res))
        }

        // ===================================================================
        // Voice (TTS / STT / Live Voice)
        // ===================================================================
        "voice_settings_get" => {
            let payload = crate::routes::voice::settings_payload(state).await.map_err(err_text)?;
            let settings = payload.get("settings").unwrap_or(&payload);
            let tts_p = settings.get("ttsProvider").and_then(Value::as_str).unwrap_or("browser-native");
            let stt_p = settings.get("sttProvider").and_then(Value::as_str).unwrap_or("browser-native");
            let lang = settings.get("sttLanguage").and_then(Value::as_str).unwrap_or("en");
            let text = format!(
                "**Voice & Speech Configuration**:\n\
                - **TTS Provider**: `{tts_p}`\n\
                - **STT Provider**: `{stt_p}` (Language: `{lang}`)\n\
                - **Read Aloud**: enabled={}, auto={}",
                settings.get("readAloudEnabled").and_then(Value::as_bool).unwrap_or(true),
                settings.get("autoReadAloud").and_then(Value::as_bool).unwrap_or(false)
            );
            Ok((text, payload))
        }

        "voice_config_update" => {
            // Support both Vellum's setting/value pattern and direct parameter updates
            let mut update_body = json!({});
            if let Some(setting) = arg_str(args, "setting")? {
                let val = args.get("value").cloned().unwrap_or(Value::Null);
                match setting {
                    "tts_provider" => {
                        update_body["ttsProvider"] = val;
                    }
                    "stt_provider" => {
                        update_body["sttProvider"] = val;
                    }
                    "stt_language" => {
                        update_body["sttLanguage"] = val.clone();
                        let provider =
                            active_provider(state, "sttProvider", "deepgram").await?;
                        update_body["sttProviderUpdate"] =
                            json!({ "provider": provider, "language": val });
                    }
                    "tts_speed" => {
                        let provider =
                            active_provider(state, "ttsProvider", "elevenlabs").await?;
                        update_body["ttsProviderUpdate"] =
                            json!({ "provider": provider, "speed": val });
                    }
                    "tts_base_url" => {
                        let provider =
                            active_provider(state, "ttsProvider", "elevenlabs").await?;
                        update_body["ttsProviderUpdate"] =
                            json!({ "provider": provider, "baseUrl": val });
                    }
                    "stt_base_url" => {
                        let provider =
                            active_provider(state, "sttProvider", "deepgram").await?;
                        update_body["sttProviderUpdate"] =
                            json!({ "provider": provider, "baseUrl": val });
                    }
                    "tts_voice_id" => {
                        let provider = crate::routes::voice::settings_payload(state).await.map_err(err_text)?
                            .get("settings")
                            .and_then(|s| s.get("ttsProvider"))
                            .and_then(Value::as_str)
                            .unwrap_or("elevenlabs")
                            .to_string();
                        update_body["ttsProviderUpdate"] = json!({
                            "provider": provider,
                            "voiceId": val,
                        });
                    }
                    "tts_model" => {
                        let provider = crate::routes::voice::settings_payload(state).await.map_err(err_text)?
                            .get("settings")
                            .and_then(|s| s.get("ttsProvider"))
                            .and_then(Value::as_str)
                            .unwrap_or("elevenlabs")
                            .to_string();
                        update_body["ttsProviderUpdate"] = json!({
                            "provider": provider,
                            "model": val,
                        });
                    }
                    "stt_model" => {
                        let provider = crate::routes::voice::settings_payload(state).await.map_err(err_text)?
                            .get("settings")
                            .and_then(|s| s.get("sttProvider"))
                            .and_then(Value::as_str)
                            .unwrap_or("deepgram")
                            .to_string();
                        update_body["sttProviderUpdate"] = json!({
                            "provider": provider,
                            "model": val,
                        });
                    }
                    "read_aloud_enabled" => {
                        update_body["readAloudEnabled"] = val;
                    }
                    "auto_read_aloud" => {
                        update_body["autoReadAloud"] = val;
                    }
                    _ => {}
                }
            } else {
                if let Some(tts_p) = arg_str(args, "tts_provider")? {
                    update_body["ttsProvider"] = json!(tts_p);
                }
                if let Some(stt_p) = arg_str(args, "stt_provider")? {
                    update_body["sttProvider"] = json!(stt_p);
                }
                if let Some(lang) = arg_str(args, "stt_language")? {
                    update_body["sttLanguage"] = json!(lang);
                }
                if let Some(enabled) = args.get("read_aloud_enabled").and_then(Value::as_bool) {
                    update_body["readAloudEnabled"] = json!(enabled);
                }
                if let Some(auto) = args.get("auto_read_aloud").and_then(Value::as_bool) {
                    update_body["autoReadAloud"] = json!(auto);
                }
                let tts_voice = arg_str(args, "tts_voice_id")?;
                let tts_model = arg_str(args, "tts_model")?;
                let tts_base = arg_str(args, "tts_base_url")?;
                let tts_speed = args.get("tts_speed").and_then(Value::as_f64);
                if tts_voice.is_some()
                    || tts_model.is_some()
                    || tts_base.is_some()
                    || tts_speed.is_some()
                {
                    let provider = match arg_str(args, "tts_provider")? {
                        Some(provider) => provider.to_string(),
                        None => active_provider(state, "ttsProvider", "elevenlabs").await?,
                    };
                    let mut p_up = json!({ "provider": provider });
                    if let Some(voice) = tts_voice { p_up["voiceId"] = json!(voice); }
                    if let Some(model) = tts_model { p_up["model"] = json!(model); }
                    if let Some(base) = tts_base { p_up["baseUrl"] = json!(base); }
                    if let Some(speed) = tts_speed { p_up["speed"] = json!(speed); }
                    update_body["ttsProviderUpdate"] = p_up;
                }
                let stt_model = arg_str(args, "stt_model")?;
                let stt_base = arg_str(args, "stt_base_url")?;
                let stt_language = arg_str(args, "stt_language")?;
                if stt_model.is_some() || stt_base.is_some() || stt_language.is_some() {
                    let provider = match arg_str(args, "stt_provider")? {
                        Some(provider) => provider.to_string(),
                        None => active_provider(state, "sttProvider", "deepgram").await?,
                    };
                    let mut p_up = json!({ "provider": provider });
                    if let Some(model) = stt_model { p_up["model"] = json!(model); }
                    if let Some(base) = stt_base { p_up["baseUrl"] = json!(base); }
                    if let Some(language) = stt_language { p_up["language"] = json!(language); }
                    update_body["sttProviderUpdate"] = p_up;
                }
            }

            let res = crate::routes::voice::apply_settings_update(state, &update_body).await.map_err(err_text)?;
            let text = "Voice configuration updated successfully.".to_string();
            Ok((text, res))
        }

        "voice_list_voices" => {
            let provider = arg_str(args, "provider")?.unwrap_or("");
            let body = if provider.is_empty() { json!({}) } else { json!({"provider": provider}) };
            let res = crate::routes::voice::list_voices_payload(state, &body).await.map_err(err_text)?;
            let voices = res.get("voices").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut lines = Vec::new();
            for v in &voices {
                let id = v.get("id").and_then(Value::as_str).unwrap_or("");
                let name = v.get("name").and_then(Value::as_str).unwrap_or(id);
                lines.push(format!("- **{}** (`{}`)", name, id));
            }
            let text = format!("Available voices ({}):\n{}", voices.len(), lines.join("\n"));
            Ok((text, res))
        }

        // ===================================================================
        // Web Search Providers
        // ===================================================================
        "search_providers_list" => {
            let active = crate::routes::search_providers::active_search_payload(state).await.map_err(err_text)?;
            let providers = crate::routes::search_providers::list_search_providers_payload(state).await.map_err(err_text)?;
            let catalog = crate::routes::search_providers::search_catalog();
            let active_label = active.get("label").and_then(Value::as_str).unwrap_or("None");

            let mut lines = Vec::new();
            lines.push(format!("**Active default search provider**: {}", active_label));
            lines.push("\n**Configured Search Providers**:".to_string());
            for p in &providers {
                let name = p.get("name").and_then(Value::as_str).unwrap_or("");
                let kind = p.get("provider").and_then(Value::as_str).unwrap_or("");
                let is_act = p.get("isActive").and_then(Value::as_bool).unwrap_or(false);
                let id = p.get("id").and_then(Value::as_str).unwrap_or("");
                lines.push(format!("- **{}** (`{}`): ID `{}` {}", name, kind, id, if is_act { "★ (active)" } else { "" }));
            }
            let text = lines.join("\n");
            Ok((text, json!({"active": active, "providers": providers, "catalog": catalog})))
        }

        "search_provider_configure" => {
            let provider_kind = require_str(args, "provider")?.to_lowercase();
            let name = arg_str(args, "name")?.unwrap_or(&provider_kind);
            let base_url = arg_str(args, "base_url")?;
            let custom = args.get("custom").cloned();
            let set_active = args.get("set_active").and_then(Value::as_bool).unwrap_or(true);

            // Check if key is needed and if it's already in vault
            let needs_key = matches!(provider_kind.as_str(), "brave" | "tavily" | "exa" | "serper" | "firecrawl");
            let mut api_key = String::new();
            if needs_key {
                // Try `<provider_kind>/api_key` or `search.<provider_kind>/api_key`
                if let Some(secret) = crate::credentials::get_plaintext(state, &provider_kind, "api_key").await.map_err(err_text)? {
                    api_key = secret.expose().to_string();
                } else if let Some(secret) = crate::credentials::get_plaintext(state, &format!("search.{provider_kind}"), "api_key").await.map_err(err_text)? {
                    api_key = secret.expose().to_string();
                } else {
                    let prompt = json!({
                        "service": format!("search.{provider_kind}"),
                        "field": "api_key",
                        "label": format!("{name} Search API Key"),
                        "description": format!("API key for {name} web search. Entered secrets are encrypted in Amiro's vault."),
                        "purpose": "Web search provider",
                        "placeholder": "API key..."
                    });
                    let text = format!(
                        "An API key for search provider \"{name}\" is needed. Please enter it securely in the card below:\n\n\
                        SECRET_PROMPT {}",
                        prompt
                    );
                    return Ok((text, json!({"status": "needs_secret", "prompt": prompt})));
                }
            }

            let mut config_body = json!({
                "name": name,
                "provider": provider_kind,
                "apiKey": api_key,
            });
            if let Some(base) = base_url { config_body["baseUrl"] = json!(base); }
            if let Some(c) = custom { config_body["custom"] = c; }

            let res = crate::routes::search_providers::upsert_search_provider(state, &config_body).await.map_err(err_text)?;
            let id = res.get("id").and_then(Value::as_str).unwrap_or("");
            if set_active && !id.is_empty() {
                let _ = crate::routes::search_providers::set_active_search_provider(state, id).await;
            }
            let text = format!("Search provider \"{name}\" ({provider_kind}) configured successfully{}.", if set_active { " and activated as default" } else { "" });
            Ok((text, res))
        }

        "search_provider_activate" => {
            let id = require_str(args, "id")?;
            let res = crate::routes::search_providers::set_active_search_provider(state, id).await.map_err(err_text)?;
            let text = format!("Search provider `{id}` activated as default.");
            Ok((text, res))
        }

        "search_provider_test" => {
            let id = require_str(args, "id")?;
            let res = crate::routes::search_providers::run_search_provider_test(state, id).await.map_err(err_text)?;
            let ok = res.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let count = res.get("count").and_then(Value::as_u64).unwrap_or(0);
            let ms = res.get("latencyMs").and_then(Value::as_u64).unwrap_or(0);
            let err = res.get("error").and_then(Value::as_str).unwrap_or("");
            let text = if ok {
                format!("Search test successful ({count} results returned in {ms}ms).")
            } else {
                format!("Search test failed: {err}")
            };
            Ok((text, res))
        }

        "search_provider_delete" => {
            let id = require_str(args, "id")?;
            let res = crate::routes::search_providers::remove_search_provider(state, id).await.map_err(err_text)?;
            let text = format!("Deleted search provider `{id}`.");
            Ok((text, res))
        }

        // ===================================================================
        // MCP Connectors & Composio OAuth
        // ===================================================================
        "mcp_connectors_list" => {
            let payload = crate::routes::connectors::servers_payload(state).await.map_err(err_text)?;
            let servers = payload.get("servers").and_then(Value::as_array).cloned().unwrap_or_default();
            let composio_cfg = payload.get("composio").and_then(|c| c.get("configured")).and_then(Value::as_bool).unwrap_or(false);
            let mut lines = Vec::new();
            lines.push(format!("**Composio 1-Click Apps**: {}", if composio_cfg { "Connected" } else { "Not configured" }));
            lines.push("\n**Connectors / MCP Servers**:".to_string());
            for s in &servers {
                let name = s.get("name").and_then(Value::as_str).unwrap_or("");
                let status = s.get("status").and_then(Value::as_str).unwrap_or("unknown");
                let transport = s.get("transport").and_then(Value::as_str).unwrap_or("");
                let tools_cnt = s.get("tools").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
                lines.push(format!("- **{}** (`{}`): status `{}` ({} tools)", name, transport, status, tools_cnt));
            }
            let text = lines.join("\n");
            Ok((text, payload))
        }

        "mcp_oauth_start" => {
            let server = require_str(args, "server")?;
            let flow_res = crate::routes::connectors::start_mcp_oauth(state, server).await.map_err(err_text)?;
            let auth_url = flow_res.get("authorizationUrl").and_then(Value::as_str).unwrap_or("");
            let card = json!({
                "type": "mcp",
                "server": server,
                "flow": "authorization_code",
                "authorizationUrl": auth_url,
            });
            let text = format!(
                "OAuth login started for MCP server **{server}**!\n\
                👉 [Authorize {server}]({auth_url})\n\n\
                Click the link to sign in, then return here once approved.\n\n\
                OAUTH_CONNECT {}",
                card
            );
            Ok((text, flow_res))
        }

        "mcp_oauth_status" => {
            let server = require_str(args, "server")?;
            let status = crate::routes::connectors::get_mcp_oauth_status(server).await.map_err(err_text)?;
            let st = status.get("status").and_then(Value::as_str).unwrap_or("unknown");
            let text = format!("OAuth status for MCP server \"{server}\": **{st}**");
            Ok((text, status))
        }

        "composio_toolkits_list" => {
            let search = arg_str(args, "search")?;
            let limit_str = args.get("limit").and_then(Value::as_u64).map(|n| n.to_string());
            let res = crate::routes::composio::list_toolkits_for_user(state, &uid, search, limit_str.as_deref()).await.map_err(err_text)?;
            let items = res.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut lines = Vec::new();
            for item in &items {
                let slug = item.get("slug").and_then(Value::as_str).unwrap_or("");
                let name = item.get("name").and_then(Value::as_str).unwrap_or(slug);
                let connected = item.get("connected").and_then(Value::as_bool).unwrap_or(false);
                let desc = item.get("description").and_then(Value::as_str).unwrap_or("");
                lines.push(format!("- **{}** (`{}`): {} · {}", name, slug, if connected { "Connected" } else { "Available" }, desc));
            }
            let text = format!("Composio toolkits ({}):\n{}", items.len(), lines.join("\n"));
            Ok((text, res))
        }

        "composio_connect_start" => {
            let toolkit = require_str(args, "toolkit")?;
            let callback_url = arg_str(args, "callback_url")?;
            let res = crate::routes::composio::start_connect_for_user(state, &uid, toolkit, callback_url).await.map_err(err_text)?;
            let redirect_url = res.get("redirectUrl").and_then(Value::as_str).unwrap_or("");
            let connection_id = res.get("connectionId").and_then(Value::as_str).unwrap_or("");
            let card = json!({
                "type": "composio",
                "toolkit": toolkit,
                "connectionId": connection_id,
                "redirectUrl": redirect_url,
                "authorizationUrl": redirect_url,
            });
            let text = format!(
                "Connect **{toolkit}** in 1 click:\n\
                👉 [Log in to {toolkit}]({redirect_url})\n\n\
                After signing in, return here and I'll confirm your connection.\n\n\
                OAUTH_CONNECT {}",
                card
            );
            Ok((text, res))
        }

        "composio_connection_status" => {
            let connection_id = require_str(args, "connection_id")?;
            let res = crate::routes::composio::connection_status_for_user(state, &uid, connection_id).await.map_err(err_text)?;
            let status = res.get("status").and_then(Value::as_str).unwrap_or("UNKNOWN");
            let text = format!("Connection status for `{connection_id}`: **{status}**");
            Ok((text, res))
        }

        // ===================================================================
        // Encrypted Vault & Interactive UI Cards
        // ===================================================================
        "credentials_list" => {
            let items = crate::credentials::list_metadata(state).await.map_err(err_text)?;
            let mut lines = Vec::new();
            for item in &items {
                lines.push(format!(
                    "- **{}/{}** (`${}`): {} (updated: {})",
                    item.service,
                    item.field,
                    item.env_var,
                    item.label.as_deref().unwrap_or(item.hint.as_str()),
                    item.updated_at
                ));
            }
            let text = format!("Credentials in encrypted vault ({}):\n{}", items.len(), lines.join("\n"));
            Ok((text, json!({"items": items})))
        }

        "ui_prompt_secret" => {
            let service = require_str(args, "service")?;
            let field = arg_str(args, "field")?.unwrap_or("api_key");
            let label = require_str(args, "label")?;
            let desc = arg_str(args, "description")?;
            let placeholder = arg_str(args, "placeholder")?.unwrap_or("••••");
            let purpose = arg_str(args, "purpose")?;
            let domains = args.get("allowed_domains").cloned().unwrap_or(json!([]));

            let prompt_card = json!({
                "service": service,
                "field": field,
                "label": label,
                "description": desc,
                "placeholder": placeholder,
                "purpose": purpose,
                "allowedDomains": domains,
            });

            let text = format!(
                "Please enter the required secret in the encrypted card below:\n\n\
                SECRET_PROMPT {}",
                prompt_card
            );
            Ok((text, prompt_card))
        }

        "artifact_list" => {
            let doc = crate::state::read_json(
                &state.home.join("store").join("artifacts.json"),
                serde_json::json!({}),
            )
            .await
            .map_err(err_text)?;
            let mut items: Vec<Value> = doc
                .as_object()
                .map(|m| {
                    m.values()
                        .filter(|e| e.get("ownerId").and_then(|v| v.as_str()) == Some(&uid))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            items.sort_by(|a, b| {
                b.get("createdAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .cmp(a.get("createdAt").and_then(|v| v.as_str()).unwrap_or(""))
            });
            let text = if items.is_empty() {
                "No artifacts yet.".to_string()
            } else {
                format!(
                    "{} artifact(s):\n{}",
                    items.len(),
                    items
                        .iter()
                        .map(|a| format!(
                            "- {} (`{}`): {} [{}]",
                            a["title"].as_str().unwrap_or(""),
                            a["id"].as_str().unwrap_or(""),
                            a["filename"].as_str().unwrap_or(""),
                            a["kind"].as_str().unwrap_or("")
                        ))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            };
            Ok((text, json!({"artifacts": items})))
        }
        "artifact_create" => {
            let bytes = match (args.get("contentText"), args.get("contentBase64")) {
                (Some(Value::String(t)), None) | (Some(Value::String(t)), Some(Value::Null)) => {
                    t.as_bytes().to_vec()
                }
                (None, Some(Value::String(b))) | (Some(Value::Null), Some(Value::String(b))) => {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD
                        .decode(b.trim())
                        .map_err(|_| "contentBase64 is not valid base64".to_string())?
                }
                _ => return Err("contentText or contentBase64 is required (exactly one)".into()),
            };
            let opt = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
            let entry = crate::routes::artifacts::create_artifact_record(
                state,
                &uid,
                opt("title"),
                opt("kind"),
                opt("language"),
                opt("filename"),
                opt("mime"),
                None,
                bytes,
            )
            .await
            .map_err(err_text)?;
            Ok((
                format!(
                    "Created artifact \"{}\" ({}). It is saved under {} and can be opened from the Files tab in the artifact panel.",
                    entry["title"].as_str().unwrap_or(""),
                    entry["filename"].as_str().unwrap_or(""),
                    entry["workspacePath"].as_str().unwrap_or("")
                ),
                json!({"artifact": entry}),
            ))
        }
        "artifact_read" => {
            let id = require_str(args, "id")?;
            let doc = crate::state::read_json(
                &state.home.join("store").join("artifacts.json"),
                serde_json::json!({}),
            )
            .await
            .map_err(err_text)?;
            let entry = doc.get(id).ok_or_else(|| format!("Artifact \"{id}\" not found"))?;
            if entry.get("ownerId").and_then(|v| v.as_str()) != Some(&uid) {
                return Err(format!("Artifact \"{id}\" not found"));
            }
            Ok((
                format!(
                    "Artifact \"{}\" ({}).",
                    entry["title"].as_str().unwrap_or(""),
                    entry["filename"].as_str().unwrap_or("")
                ),
                json!({"artifact": entry}),
            ))
        }
        "artifact_update" => {
            let id = require_str(args, "id")?;
            let bytes = match (args.get("contentText"), args.get("contentBase64")) {
                (None, None) | (Some(Value::Null), Some(Value::Null)) => None,
                (Some(Value::String(t)), None) | (Some(Value::String(t)), Some(Value::Null)) => {
                    Some(t.as_bytes().to_vec())
                }
                (None, Some(Value::String(b))) | (Some(Value::Null), Some(Value::String(b))) => {
                    use base64::Engine;
                    Some(
                        base64::engine::general_purpose::STANDARD
                            .decode(b.trim())
                            .map_err(|_| "contentBase64 is not valid base64".to_string())?,
                    )
                }
                _ => return Err("Provide contentText or contentBase64, not both".into()),
            };
            let title = args.get("title").and_then(Value::as_str).map(str::to_string);
            if title.is_none() && bytes.is_none() {
                return Err("nothing to update: provide title and/or content".into());
            }
            let entry = crate::routes::artifacts::update_artifact_record(state, &uid, id, title, bytes)
                .await
                .map_err(err_text)?;
            Ok((
                format!("Updated artifact \"{}\".", entry["title"].as_str().unwrap_or("")),
                json!({"artifact": entry}),
            ))
        }
        "artifact_delete" => {
            let id = require_str(args, "id")?;
            crate::routes::artifacts::delete_artifact_record(state, &uid, id)
                .await
                .map_err(err_text)?;
            Ok((format!("Deleted artifact {id}."), json!({"deleted": id})))
        }
        // ===================================================================
        // Contacts
        // ===================================================================
        "contact_search" => {
            let mut search_body = json!({});
            if let Some(q) = arg_str(args, "query")? {
                search_body["query"] = json!(q);
            }
            if let Some(addr) = arg_str(args, "channel_address")? {
                search_body["channelAddress"] = json!(addr);
            }
            if let Some(ct) = arg_str(args, "channel_type")? {
                search_body["channelType"] = json!(ct);
            }
            let res = crate::routes::contacts::search_contacts(
                axum::extract::State(state.clone()),
                crate::state::AuthUser(json!({"id": uid, "role": "admin"})),
                axum::Json(search_body),
            )
            .await
            .map_err(err_text)?;

            let list = res.0.as_array().cloned().unwrap_or_default();
            let mut lines = Vec::new();
            for c in &list {
                let name = c.get("displayName").and_then(Value::as_str).unwrap_or("Unknown");
                let id = c.get("id").and_then(Value::as_str).unwrap_or("");
                let role = c.get("role").and_then(Value::as_str).unwrap_or("contact");
                lines.push(format!("- **{}** (`{}`), role: `{}`", name, id, role));
            }
            let text = if lines.is_empty() {
                "No matching contacts found.".to_string()
            } else {
                format!("Found {} contact(s):\n{}", list.len(), lines.join("\n"))
            };
            Ok((text, res.0))
        }

        "contact_create" => {
            let name = require_str(args, "name")?;
            let notes = arg_str(args, "notes")?;
            let mut body = json!({
                "displayName": name,
                "notes": notes,
            });
            if let Some(ct) = arg_str(args, "channel_type")? {
                if let Some(ca) = arg_str(args, "channel_address")? {
                    body["channels"] = json!([{
                        "type": ct,
                        "address": ca,
                        "isPrimary": true
                    }]);
                }
            }
            let res = crate::routes::contacts::upsert_contact(
                axum::extract::State(state.clone()),
                crate::state::AuthUser(json!({"id": uid, "role": "admin"})),
                axum::Json(body),
            )
            .await
            .map_err(err_text)?;

            let created_name = res.0.get("contact").and_then(|c| c.get("displayName")).and_then(Value::as_str).unwrap_or(name);
            let text = format!("Contact **{created_name}** created successfully.");
            Ok((text, res.0))
        }

        "contact_merge" => {
            let keep_id = require_str(args, "keep_id")?;
            let merge_id = require_str(args, "merge_id")?;
            let res = crate::routes::contacts::merge_contacts(
                axum::extract::State(state.clone()),
                crate::state::AuthUser(json!({"id": uid, "role": "admin"})),
                axum::Json(json!({ "keepId": keep_id, "mergeId": merge_id })),
            )
            .await
            .map_err(err_text)?;

            let text = format!("Merged contact `{merge_id}` into survivor `{keep_id}`.");
            Ok((text, res.0))
        }

        // ===================================================================
        // Channels
        // ===================================================================
        "channel_readiness_get" => {
            let snapshots = crate::routes::channels::compute_channel_snapshots(state).await.map_err(err_text)?;
            let mut lines = Vec::new();
            for s in &snapshots {
                let ch = s.get("channel").and_then(Value::as_str).unwrap_or("");
                let ready = s.get("ready").and_then(Value::as_bool).unwrap_or(false);
                let st = s.get("setupStatus").and_then(Value::as_str).unwrap_or("unknown");
                lines.push(format!("- **{}**: {} (status: `{}`)", ch, if ready { "✅ ready" } else { "⚠️ not ready" }, st));
            }
            let text = format!("**Channel Readiness Snapshot**:\n{}", lines.join("\n"));
            Ok((text, json!({ "snapshots": snapshots })))
        }

        "channel_policy_set" => {
            let ch_type = require_str(args, "channel_type")?;
            let policy = require_str(args, "policy")?;
            let res = crate::routes::channels::set_channel_policy_root(
                axum::extract::State(state.clone()),
                crate::state::AuthUser(json!({"id": uid, "role": "admin"})),
                axum::Json(json!({ "channelType": ch_type, "policy": policy })),
            )
            .await
            .map_err(err_text)?;

            let text = format!("Updated admission policy for **{ch_type}** to `{policy}`.");
            Ok((text, res.0))
        }

        "ui_navigate" => {
            let page = require_str(args, "page")?;
            let (title, path) = match page {
                "providers" => ("Models & Providers", "/admin/providers"),
                "voice" => ("Voice & Speech", "/admin/voice"),
                "search" => ("Search Providers", "/admin/search"),
                "connectors" => ("App Connectors & MCP", "/connectors"),
                "credentials" => ("Encrypted Credentials Vault", "/admin/credentials"),
                "integrations" => ("Integrations & MCP", "/admin/integrations"),
                "general" => ("General Settings", "/admin/general"),
                "notifications" => ("Notifications", "/admin/notifications"),
                "usage" => ("Usage & Limits", "/admin/usage"),
                "schedules" => ("Schedules", "/schedules"),
                "superpowers" => ("Superpowers (Skills)", "/skills"),
                "personality" => ("Agent Personality", "/agent/personality"),
                "memory" => ("Agent Memory", "/agent/memory"),
                "workspace" => ("Agent Workspace", "/agent/workspace"),
                "channels" => ("Channels", "/agent/channels"),
                "contacts" => ("Contacts", "/agent/contacts"),
                _ => ("Settings", "/admin/general"),
            };
            let text = format!("Opened [**{}**]({}) in Amiro.", title, path);
            Ok((text, json!({"page": page, "title": title, "path": path})))
        }
        "desktop_open" => {
            use crate::routes::agent_browser::{describe_desktop, open_on_desktop};
            let app = require_str(args, "app")?;
            let target = arg_str(args, "target")?.unwrap_or("");
            let desktop = open_on_desktop(state, crate::routes::agents::MAIN_AGENT_ID, app, target).await?;
            let text = format!("Opened {app} on your desktop.\n{}", describe_desktop(&desktop));
            Ok((text, json!({"agentId": crate::routes::agents::MAIN_AGENT_ID, "desktop": desktop})))
        }
        "desktop_state" => {
            use crate::routes::agent_browser::{describe_desktop, read_desktop};
            let desktop = read_desktop(state, crate::routes::agents::MAIN_AGENT_ID).await?;
            Ok((describe_desktop(&desktop), json!({"agentId": crate::routes::agents::MAIN_AGENT_ID, "desktop": desktop})))
        }
        "ui_render_openui" => {
            let preset = arg_str(args, "preset")?;
            let raw_code = arg_str(args, "code")?;
            let code = match (raw_code.map(str::trim).filter(|s| !s.is_empty()), preset) {
                (Some(c), _) => c.to_string(),
                (None, Some("daily_brief")) => openui_preset_code("daily_brief").to_string(),
                (None, Some("budget_planner")) => openui_preset_code("budget_planner").to_string(),
                (None, Some("sprint_tracker")) => openui_preset_code("sprint_tracker").to_string(),
                (None, Some("agent_data_intake")) => openui_preset_code("agent_data_intake").to_string(),
                (None, Some("inbox_cleanup_setup")) => openui_preset_code("inbox_cleanup_setup").to_string(),
                (None, Some(other)) => {
                    return Err(format!(
                        "unknown preset \"{other}\"; use daily_brief, budget_planner, sprint_tracker, agent_data_intake, or inbox_cleanup_setup"
                    ))
                }
                (None, None) => {
                    return Err("code or preset is required for ui_render_openui".to_string())
                }
            };
            let default_title = match preset {
                Some("daily_brief") => "Daily Executive & Engineering Command Center",
                Some("budget_planner") => "Cloud AI Cost & Capacity Planner",
                Some("sprint_tracker") => "Sprint Release Readiness & Triage",
                Some("agent_data_intake") => "Interactive Deployment & Credential Intake",
                Some("inbox_cleanup_setup") => "Inbox Cleanup Schedule Studio",
                _ => "Interactive OpenUI Surface",
            };
            let title = arg_str(args, "title")?
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(default_title);
            let payload = json!({
                "surface": "openui",
                "title": title,
                "preset": preset,
                "code": code,
            });
            let text = format!(
                "Rendered interactive OpenUI surface **{title}**.\n\n```openui\n{code}\n```"
            );
            Ok((text, payload))
        }
        other => Err(format!("unknown tool \"{other}\"")),
    }
}

fn openui_preset_code(preset: &str) -> &'static str {
    match preset {
        "inbox_cleanup_setup" => r##"root = Stack([header, steps, question, rulesForm, followUps])
header = CardHeader("Inbox Cleanup Schedule Studio", "Select what to sweep away and what to protect before Amiro activates your automated inbox schedule", "Interactive Setup")
steps = Steps([stMail, stRules, stSchedule])
stMail = StepItem("1. Mail Provider Check (Gmail / IMAP)", "completed", "Checked connected mail toolkits and MCP connectors")
stRules = StepItem("2. Keep vs. Clean Up Rules", "in_progress", "Toggle what to remove and what to always protect")
stSchedule = StepItem("3. Activate Schedule on Cadence", "pending", "Creates your recurring schedule on the Schedules page")
question = QuestionCard("How should Amiro handle emails that match your cleanup rules?", [optArchive, optLabel, optDigest], "Confirm Cleanup Mode")
optArchive = QuestionOption("Smart Archive & Mute Clutter (Recommended)", "Remove promotions and noisy notifications from Inbox while keeping them searchable in All Mail", "Safest")
optLabel = QuestionOption("Move to Cleanup Review Label", "Tag matched clutter as Amiro/Cleaned and archive after 7 days", "Reviewable")
optDigest = QuestionOption("Clean + Daily Summary Digest", "Archive clutter and post a 3-bullet summary of protected bills and reservations", "Popular")
rulesForm = InteractiveForm("Configure What to Clean Up vs. What to Keep", [swPromo, swNotif, swSocial, swOtp, swKeepRes, swKeepBills, swKeepReceipts, selCadence, inCustomKeep], "Create Inbox Cleanup Schedule", "Create my Inbox Cleanup schedule with these rules")
swPromo = FormSwitch("clean_promotions", "Clear all promotions, marketing deals & flash sales", true)
swNotif = FormSwitch("clean_notifications", "Clear unwanted automated notifications & system alerts", true)
swSocial = FormSwitch("clean_social", "Clear social media updates & cold outreach clutter", true)
swOtp = FormSwitch("clean_expired_otps", "Clear expired OTPs, login codes & old newsletters (>14 days)", true)
swKeepRes = FormSwitch("keep_reservations_month", "Keep reservations, flights, hotels & event bookings from this month", true)
swKeepBills = FormSwitch("keep_bills_2_months", "Keep utility bills, invoices, bank statements & tax docs from the last 2 months", true)
swKeepReceipts = FormSwitch("keep_active_deliveries", "Keep active package tracking, order receipts & starred VIP threads", true)
selCadence = FormSelect("cleanup_cadence", "Cleanup Schedule Cadence", ["Every day at 7:30 AM", "Every evening at 8:00 PM", "Weekdays at 8:00 AM", "Every Sunday at 6:00 PM"], "Every day at 7:30 AM")
inCustomKeep = FormInput("custom_keep_senders", "Always Keep Senders / Keywords (Optional)", "e.g. @mycompany.com, landlord, school, airline", "flights, hotel, booking, invoice, statement, receipt")
followUps = FollowUpBlock([fuDefault, fuConnectGmail, fuDryRun])
fuDefault = FollowUpItem("Activate now with recommended defaults (Daily 7:30 AM)", "Create my Inbox Cleanup schedule now with the default rules: clear promotions and unwanted notifications, keep this month's reservations and last 2 months' bills, running daily at 07:30.")
fuConnectGmail = FollowUpItem("Connect Gmail or another mail account first", "Help me connect my Gmail or mail account so the Inbox Cleanup schedule can run on my inbox.")
fuDryRun = FollowUpItem("Create schedule & run a test preview now", "Create the Inbox Cleanup schedule with these defaults and trigger a sample run right now.")"##,
        "agent_data_intake" => r##"root = Stack([header, question, intakeForm, secretVault, followUps])
header = CardHeader("Interactive Deployment & Credential Intake", "Answer the agent's rollout question, paste your service configuration values, and store your API key in the encrypted vault", "Action Needed")
question = QuestionCard("Which rollout strategy should Amiro execute for the v1.27 service cutover?", [optCanary, optBlueGreen, optShadow], "Confirm Strategy")
optCanary = QuestionOption("Progressive Canary (10% -> 50% -> 100%)", "Zero-downtime traffic shifting with automated p95 latency rollback gates", "Recommended")
optBlueGreen = QuestionOption("Blue-Green Instant Cutover", "Provision full parallel fleet and flip ingress router after smoke check", "Fastest")
optShadow = QuestionOption("Dark Traffic Shadowing (24h)", "Mirror production requests to v1.27 without serving responses to users", "Safest")
intakeForm = InteractiveForm("Paste Service Endpoints & Configuration Values", [fEndpoint, fRegion, fPayload, fAutoRollback], "Submit Values to Agent", "Here are the service deployment values")
fEndpoint = FormInput("webhook_url", "Production Webhook / Service URL", "https://api.tyson-cloud.internal/v1/hooks/release", "https://api.tyson-cloud.internal/v1/hooks/release")
fRegion = FormSelect("target_region", "Primary Deployment Region", ["us-central1 (Iowa)", "eu-west1 (Belgium)", "ap-south1 (Mumbai)"], "us-central1 (Iowa)")
fPayload = FormTextarea("config_snippet", "Paste JSON / ENV Configuration Values", "Paste JSON, YAML, or KEY=VALUE lines here...", "RELEASE_CHANNEL=canary\nMAX_ERROR_BUDGET_PCT=0.5\nHEALTHCHECK_PATH=/healthz")
fAutoRollback = FormSwitch("auto_rollback", "Enable automatic rollback if 5xx exceeds 0.5%", true)
secretVault = SecretVaultCard("release-webhook", "signing_secret", "Release Webhook API Key / Signing Secret", "Paste your webhook API key or signing password below. It is encrypted directly into Amiro's local vault ($AMIRO_CRED_RELEASE_WEBHOOK_SIGNING_SECRET) and never sent in plain chat.", "whsec_live_...", "Sign and verify production release webhooks")
followUps = FollowUpBlock([fuVerify, fuDryRun])
fuVerify = FollowUpItem("Run pre-flight readiness check", "Run a pre-flight readiness check using the submitted deployment configuration")
fuDryRun = FollowUpItem("Generate rollback runbook", "Generate a step-by-step rollback runbook for v1.27")"##,
        "budget_planner" => r##"root = Stack([header, kpis, controls, chartCard, followUps])
header = CardHeader("Cloud AI Cost & Capacity Planner", "Model spend, latency, and interactive scaling simulator")
kpis = MetricGrid([mSpend, mTokens, mCache, mSavings])
mSpend = Metric("Monthly Run-Rate", "$4,820", "-14% vs last month", "positive")
mTokens = Metric("Daily Requests", "184K", "+22% this week", "info")
mCache = Metric("Prompt Cache Hit", "68.4%", "+9.1% efficiency", "positive")
mSavings = Metric("Projected Annual Savings", "$19,400", "With hybrid routing", "positive")
controls = InteractiveForm("Simulate Workload & Routing Policy", [fRpm, fCache, fRoute], "Recalculate Forecast", "Update my AI budget plan with the selected workload parameters")
fRpm = FormSlider("requests_per_day", "Peak Daily Requests (K)", 50, 500, 180, "K req/day")
fCache = FormSlider("cache_target", "Target Cache Hit Rate (%)", 20, 90, 70, "%")
fRoute = FormSwitch("smart_routing", "Auto-route routine tasks to Flash tier", true)
chartCard = BarChart("Monthly Spend by Model Tier ($ USD)", ["Jan", "Feb", "Mar", "Apr"], [seriesFrontier, seriesFlash])
seriesFrontier = ChartSeries("Frontier Reasoning", [3400, 3150, 2890, 2420], "#6366f1")
seriesFlash = ChartSeries("Fast Workhorse", [1200, 1480, 1790, 2400], "#10b981")
followUps = FollowUpBlock([fuOptimize, fuExport, fuAlert])
fuOptimize = FollowUpItem("Apply hybrid routing policy", "Configure hybrid model routing to cap monthly spend at $4,500")
fuExport = FollowUpItem("Export FinOps CSV report", "Generate a CSV artifact of the April model cost breakdown")
fuAlert = FollowUpItem("Schedule weekly budget check", "Schedule a weekly Monday 9am cost anomaly digest")"##,
        "sprint_tracker" => r##"root = Stack([header, kpis, steps, tabs, followUps])
header = CardHeader("Sprint 42 Release Command Center", "Release v1.27 readiness, PR velocity, and active blockers")
kpis = MetricGrid([mVelocity, mMerged, mP95, mBlockers])
mVelocity = Metric("Sprint Completion", "88%", "37 of 42 story points", "positive")
mMerged = Metric("PRs Merged", "29", "+6 since yesterday", "info")
mP95 = Metric("API p95 Latency", "142 ms", "-18 ms improvement", "positive")
mBlockers = Metric("Release Blockers", "1", "OAuth token refresh edge case", "warning")
steps = Steps([sFreeze, sCanary, sE2E, sProd])
sFreeze = StepItem("Feature Freeze & Schema Lock", "completed", "All 14 migrations verified in staging")
sCanary = StepItem("EU-West Canary Rollout (10%)", "completed", "Zero 5xx errors over 6h soak")
sE2E = StepItem("Playwright E2E Suite & Security Audit", "in_progress", "13/14 journeys green, final voice check running")
sProd = StepItem("Global Production Promotion", "pending", "Scheduled for 16:00 UTC")
tabs = Tabs([tabPRs, tabVelocity, tabRisk])
tabPRs = TabItem("Priority PR Queue", prTable)
tabVelocity = TabItem("Burnup & Throughput", velocityChart)
tabRisk = TabItem("Release Triage", riskCallout)
prTable = DataTable(["PR", "Owner", "Service", "Status", "Impact"], [r1, r2, r3, r4])
r1 = ["#418 Streaming OpenUI Renderer", "A. Patel", "frontend-chat", "Ready to Merge", "High"]
r2 = ["#421 Vault Key Rotation Guard", "S. Somayaji", "backend-auth", "Merged", "Critical"]
r3 = ["#425 MCP OAuth Retry Backoff", "M. Chen", "runtime-mcp", "In Review", "High"]
r4 = ["#429 Hindi Locale Parity Check", "R. Sharma", "i18n", "Merged", "Medium"]
velocityChart = LineChart("Story Points Completed vs Target", ["Day 1", "Day 3", "Day 5", "Day 7", "Day 10"], [sActual, sTarget])
sActual = ChartSeries("Completed Points", [4, 12, 21, 31, 37], "#10b981")
sTarget = ChartSeries("Ideal Burnup", [4, 11, 19, 28, 42], "#6366f1")
riskCallout = Callout("warning", "Action Required: MCP OAuth Refresh (#425)", "Approve PR #425 before 15:00 UTC to unblock the remaining 2 enterprise connector tests.")
followUps = FollowUpBlock([fuNudge, fuNotes, fuRollback])
fuNudge = FollowUpItem("Draft release notes for v1.27", "Draft customer-facing release notes for Sprint 42 v1.27")
fuNotes = FollowUpItem("Inspect PR #425 blocker", "Show the risk summary and test plan for PR #425 MCP OAuth Retry Backoff")
fuRollback = FollowUpItem("Generate rollout checklist", "Create an interactive production deployment and rollback checklist")"##,
        _ => r##"root = Stack([header, kpis, tabs, followUps])
header = CardHeader("Daily Executive & Engineering Command Center", "Live snapshot of system health, sprint delivery, and AI operations")
kpis = MetricGrid([mUptime, mDeploy, mLatency, mCost])
mUptime = Metric("Platform Availability", "99.98%", "Last 30 days SLA", "positive")
mDeploy = Metric("Deploys This Week", "18", "100% automated rollback ready", "info")
mLatency = Metric("Agent Median Response", "1.18s", "-240ms faster with streaming UI", "positive")
mCost = Metric("Open Action Items", "3", "1 high-priority review today", "warning")
tabs = Tabs([tabOverview, tabServices, tabActionPlan])
tabOverview = TabItem("Traffic & Latency", trafficChart)
tabServices = TabItem("Service Matrix", serviceTable)
tabActionPlan = TabItem("Today's Focus", focusSteps)
trafficChart = BarChart("Weekly Agent Tasks & Automated Resolutions", ["Mon", "Tue", "Wed", "Thu", "Fri"], [sResolved, sEscalated])
sResolved = ChartSeries("Resolved Autonomously", [420, 465, 510, 548, 590], "#10b981")
sEscalated = ChartSeries("Human-in-the-Loop", [48, 41, 39, 34, 28], "#6366f1")
serviceTable = DataTable(["Subsystem", "Health", "Latency (p95)", "Owner", "Notes"], [row1, row2, row3, row4])
row1 = ["Amiro Rust Backend", "Healthy", "11 ms", "Core Platform", "v1.26 active"]
row2 = ["Jcode Agent Runtime", "Healthy", "185 ms", "Agent Engine", "MCP bridge synced"]
row3 = ["Connector OAuth Broker", "Degraded", "410 ms", "Integrations", "Token refresh retry queued"]
row4 = ["Voice TTS/STT Pipeline", "Healthy", "210 ms", "Voice & Speech", "EN + HI active"]
focusSteps = Steps([step1, step2, step3])
step1 = StepItem("Morning Health & Vault Audit", "completed", "All 6 encrypted credentials verified")
step2 = StepItem("Approve Connector OAuth Retry Patch", "in_progress", "Waiting on final staging check")
step3 = StepItem("Publish Friday Customer Digest", "pending", "Scheduled for 17:00 UTC")
followUps = FollowUpBlock([f1, f2, f3])
f1 = FollowUpItem("Open Cloud AI Budget Planner", "Show me the interactive Cloud AI Cost & Capacity Planner")
f2 = FollowUpItem("Drill into Connector OAuth latency", "Why is the Connector OAuth Broker showing 410ms p95 latency?")
f3 = FollowUpItem("Schedule this briefing daily at 8:30 AM", "Schedule this Executive Command Center briefing every weekday at 08:30")"##,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;

    use crate::state::write_json;

    const MODEL: &str = "test:model";

    fn state() -> AppState {
        let root = std::env::temp_dir().join(format!("amiro-agent-mcp-{}", uuid::Uuid::new_v4()));
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

    struct Harness {
        state: AppState,
        app: Router,
        token: String,
        scheduler: tokio::task::JoinHandle<()>,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.scheduler.abort();
        }
    }

    async fn harness() -> Harness {
        let state = state();
        write_json(
            &state.home.join("users.json"),
            &json!({"users":[{"id":"owner","role":"admin"},{"id":"other","role":"user"}]}),
        )
        .await
        .unwrap();
        write_json(
            &state.home.join("sessions.json"),
            &json!({"sessions":{
                "owner":{"userId":"owner","createdAt":crate::state::now_iso()},
                "other":{"userId":"other","createdAt":crate::state::now_iso()}}}),
        )
        .await
        .unwrap();
        let token = ensure_token(&state).unwrap();
        let scheduler = schedules::spawn_scheduler(state.clone());
        for _ in 0..100 {
            if schedules::mutation_allowed(&state) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(schedules::mutation_allowed(&state), "scheduler lease");
        let app = router()
            .merge(crate::routes::schedules::routes())
            .with_state(state.clone());
        Harness {
            state,
            app,
            token,
            scheduler,
        }
    }

    async fn rpc_raw(
        h: &Harness,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri(AGENT_MCP_PATH)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header(TOKEN_HEADER, token);
        }
        let response = h
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// tools/call -> (isError, text, parsed JSON block)
    async fn tool(h: &Harness, name: &str, args: Value) -> (bool, String, Value) {
        let (status, _, body) = rpc_raw(
            h,
            Some(&h.token),
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let text = body["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        let data = text
            .split("```json\n")
            .nth(1)
            .and_then(|rest| rest.split("\n```").next())
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or(Value::Null);
        (body["result"]["isError"].as_bool().unwrap(), text, data)
    }

    async fn http_get(h: &Harness, uri: &str, bearer: &str) -> (StatusCode, Value) {
        let response = h
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header("Authorization", format!("Bearer {bearer}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn auth_requires_the_agent_token() {
        let h = harness().await;
        let ping = json!({"jsonrpc":"2.0","id":1,"method":"ping"});
        let (status, _, _) = rpc_raw(&h, None, ping.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = rpc_raw(&h, Some("wrong"), ping.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let mut off_by_one = h.token.clone();
        off_by_one.replace_range(0..1, if h.token.starts_with('a') { "b" } else { "a" });
        let (status, _, _) = rpc_raw(&h, Some(&off_by_one), ping.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        // A user session bearer is not an agent token.
        let (status, headers, body) = rpc_raw(&h, Some(&h.token), ping).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["result"], json!({}));
        assert!(headers.get("Mcp-Session-Id").is_some());

        let get = h
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(AGENT_MCP_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn sidecar_exemption_is_narrow() {
        let h = harness().await;
        let mut ok = HeaderMap::new();
        ok.insert(TOKEN_HEADER, HeaderValue::from_str(&h.token).unwrap());
        let mut bad = HeaderMap::new();
        bad.insert(TOKEN_HEADER, HeaderValue::from_static("nope"));
        assert!(bypasses_sidecar(
            &h.state,
            &Method::POST,
            AGENT_MCP_PATH,
            &ok
        ));
        assert!(!bypasses_sidecar(
            &h.state,
            &Method::POST,
            AGENT_MCP_PATH,
            &bad
        ));
        assert!(!bypasses_sidecar(
            &h.state,
            &Method::POST,
            AGENT_MCP_PATH,
            &HeaderMap::new()
        ));
        assert!(!bypasses_sidecar(
            &h.state,
            &Method::GET,
            AGENT_MCP_PATH,
            &ok
        ));
        assert!(!bypasses_sidecar(
            &h.state,
            &Method::POST,
            "/api/schedules",
            &ok
        ));
        assert!(!bypasses_sidecar(
            &h.state,
            &Method::POST,
            "/agent-mcp/x",
            &ok
        ));
    }

    #[tokio::test]
    async fn token_file_is_private_and_stable() {
        let state = state();
        let token = ensure_token(&state).unwrap();
        assert!(valid_token(&token));
        assert_eq!(ensure_token(&state).unwrap(), token);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(token_path(&state.home))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[tokio::test]
    async fn initialize_and_tools_list_shape() {
        let h = harness().await;
        let (status, headers, body) = rpc_raw(
            &h,
            Some(&h.token),
            json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(headers.get("Mcp-Session-Id").is_some());
        assert_eq!(body["id"], 7);
        assert_eq!(body["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(body["result"]["capabilities"], json!({"tools":{}}));
        assert_eq!(body["result"]["serverInfo"]["name"], "amiro");
        let (_, _, body) = rpc_raw(
            &h,
            Some(&h.token),
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        )
        .await;
        assert_eq!(body["result"]["protocolVersion"], "2025-03-26");

        let (status, _, body) = rpc_raw(
            &h,
            Some(&h.token),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
        assert!(body.is_null());

        let (_, _, body) = rpc_raw(
            &h,
            Some(&h.token),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .await;
        let names: Vec<&str> = body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"schedule_list"));
        assert!(names.contains(&"provider_catalog"));
        assert!(names.contains(&"provider_configure_from_vault"));
        assert!(names.contains(&"provider_oauth_start"));
        assert!(names.contains(&"voice_settings_get"));
        assert!(names.contains(&"voice_config_update"));
        assert!(names.contains(&"search_providers_list"));
        assert!(names.contains(&"search_provider_configure"));
        assert!(names.contains(&"mcp_connectors_list"));
        assert!(names.contains(&"mcp_oauth_start"));
        assert!(names.contains(&"composio_toolkits_list"));
        assert!(names.contains(&"composio_connect_start"));
        assert!(names.contains(&"ui_prompt_secret"));
        assert!(names.contains(&"ui_navigate"));
        for tool in body["result"]["tools"].as_array().unwrap() {
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert!(tool["description"].is_string());
        }
        let (_, _, body) = rpc_raw(
            &h,
            Some(&h.token),
            json!({"jsonrpc":"2.0","id":3,"method":"nope"}),
        )
        .await;
        assert_eq!(body["error"]["code"], -32601);
    }

    #[test]
    fn cadence_variants_map_to_internal_specs() {
        let cron = |e: &str| json!({"kind":"cron","expression":e});
        assert_eq!(
            cadence_to_spec(&json!({"daily":{"time":"09:05"}})).unwrap(),
            cron("5 9 * * *")
        );
        assert_eq!(
            cadence_to_spec(&json!({"weekdays":{"time":"18:30"}})).unwrap(),
            cron("30 18 * * 1-5")
        );
        assert_eq!(
            cadence_to_spec(&json!({"weekly":{"day":"Sunday","time":"07:00"}})).unwrap(),
            cron("0 7 * * 0")
        );
        assert_eq!(
            cadence_to_spec(&json!({"weekly":{"day":"friday","time":"07:00"}})).unwrap(),
            cron("0 7 * * 5")
        );
        assert_eq!(
            cadence_to_spec(&json!({"monthly":{"day":15,"time":"08:00"}})).unwrap(),
            cron("0 8 15 * *")
        );
        assert_eq!(
            cadence_to_spec(&json!({"every_minutes":30})).unwrap(),
            json!({"kind":"interval","minutes":30})
        );
        assert_eq!(
            cadence_to_spec(&json!({"once":{"at":"2099-01-02T03:04"}})).unwrap(),
            json!({"kind":"once","at":"2099-01-02T03:04"})
        );
        assert_eq!(
            cadence_to_spec(&json!({"cron":" 0 12 * * 1 "})).unwrap(),
            cron("0 12 * * 1")
        );
        assert!(cadence_to_spec(&json!({"daily":{"time":"25:00"}})).is_err());
        assert!(cadence_to_spec(&json!({"monthly":{"day":31,"time":"08:00"}})).is_err());
        assert!(cadence_to_spec(&json!({"weekly":{"day":"funday","time":"08:00"}})).is_err());
        assert!(cadence_to_spec(&json!({"daily":{"time":"09:00"},"cron":"* * * * *"})).is_err());
        assert!(cadence_to_spec(&json!("daily")).is_err());
    }

    #[tokio::test]
    async fn create_each_cadence_and_provenance_over_http() {
        let h = harness().await;
        let cases = [
            (json!({"daily":{"time":"09:00"}}), "Every day at 9:00 AM"),
            (json!({"weekdays":{"time":"09:00"}}), "Weekdays at 9:00 AM"),
            (
                json!({"weekly":{"day":"monday","time":"09:00"}}),
                "Every Monday at 9:00 AM",
            ),
            (
                json!({"monthly":{"day":1,"time":"09:00"}}),
                "On the 1st of every month at 9:00 AM",
            ),
            (json!({"every_minutes":30}), "Every 30 minutes"),
            (
                json!({"once":{"at":"2099-01-02T09:00"}}),
                "Once on Jan 2, 2099 at 9:00 AM",
            ),
            (json!({"cron":"0 12 * * 1"}), "Every Monday at 12:00 PM"),
        ];
        for (i, (cadence, description)) in cases.iter().enumerate() {
            let (is_error, text, data) = tool(
                &h,
                "schedule_create",
                json!({"name":format!("s{i}"),"instructions":"do it","cadence":cadence,"timezone":"America/New_York","model":MODEL,"thread_id":"thr-1"}),
            )
            .await;
            assert!(!is_error, "{text}");
            assert!(text.contains("View it on the Schedules page."));
            let schedule = &data["schedule"];
            assert_eq!(schedule["cadenceDescription"], *description, "{cadence}");
            assert_eq!(schedule["mode"], "agent");
            assert_eq!(schedule["createdBy"], "agent");
            assert_eq!(schedule["createdFromThreadId"], "thr-1");
            assert!(schedule["nextRunAt"].is_string(), "{schedule}");
        }
        let (status, list) = http_get(&h, "/api/schedules", "owner").await;
        assert_eq!(status, StatusCode::OK);
        let rows = list["schedules"].as_array().unwrap();
        assert_eq!(rows.len(), cases.len());
        assert!(rows
            .iter()
            .all(|s| s["createdBy"] == "agent" && s["createdFromThreadId"] == "thr-1"));
        assert_eq!(rows[0]["timezone"], "America/New_York");
        assert_eq!(rows[0]["schedule"]["kind"], "cron");

        // Validation errors surface with the API's message.
        let (is_error, text, _) = tool(
            &h,
            "schedule_create",
            json!({"name":"x","instructions":"y","cadence":{"cron":"nope"},"model":MODEL}),
        )
        .await;
        assert!(is_error);
        assert!(text.contains("expression"), "{text}");
        let (is_error, text, _) = tool(&h, "schedule_create", json!({"name":"x","instructions":"y","cadence":{"daily":{"time":"09:00"}},"timezone":"Mars/Base","model":MODEL})).await;
        assert!(is_error);
        assert!(text.contains("timezone"), "{text}");

        let listed = tool(&h, "schedule_list", json!({})).await.2;
        assert_eq!(listed["schedules"].as_array().unwrap().len(), cases.len());
    }

    #[tokio::test]
    async fn default_timezone_falls_back_to_owner_then_utc() {
        let h = harness().await;
        let (_, _, data) = tool(&h, "schedule_create", json!({"name":"a","instructions":"y","cadence":{"daily":{"time":"09:00"}},"model":MODEL})).await;
        assert_eq!(data["schedule"]["timezone"], "UTC");
        write_json(
            &h.state.home.join("store").join("user-preferences.json"),
            &json!({"owner":{"timezone":"Europe/Paris"}}),
        )
        .await
        .unwrap();
        let (_, _, data) = tool(&h, "schedule_create", json!({"name":"b","instructions":"y","cadence":{"daily":{"time":"09:00"}},"model":MODEL})).await;
        assert_eq!(data["schedule"]["timezone"], "Europe/Paris");
    }

    #[tokio::test]
    async fn update_delete_and_owner_scoping() {
        let h = harness().await;
        let (_, _, data) = tool(&h, "schedule_create", json!({"name":"mine","instructions":"y","cadence":{"daily":{"time":"09:00"}},"timezone":"UTC","mode":"notify"})).await;
        let id = data["schedule"]["id"].as_str().unwrap().to_string();

        let (is_error, text, data) = tool(&h, "schedule_update", json!({"id":id,"name":"renamed","cadence":{"weekdays":{"time":"10:15"}},"enabled":false})).await;
        assert!(!is_error, "{text}");
        assert_eq!(data["schedule"]["name"], "renamed");
        assert_eq!(data["schedule"]["enabled"], false);
        assert_eq!(
            data["schedule"]["cadenceDescription"],
            "Weekdays at 10:15 AM"
        );
        let (is_error, _, _) = tool(&h, "schedule_update", json!({"id":id})).await;
        assert!(is_error);

        // A schedule owned by someone else is invisible and untouchable.
        let response = h.app.clone().oneshot(
            Request::builder().method("POST").uri("/api/schedules")
                .header("Authorization", "Bearer other").header("content-type", "application/json")
                .body(Body::from(json!({"name":"theirs","prompt":"p","mode":"notify","timezone":"UTC","schedule":{"kind":"interval","minutes":60}}).to_string()))
                .unwrap(),
        ).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let foreign: Value = serde_json::from_slice(&bytes).unwrap();
        let foreign_id = foreign["schedule"]["id"].as_str().unwrap().to_string();
        assert_eq!(
            foreign["schedule"]["createdBy"], "user",
            "HTTP creates default to user"
        );
        let (_, _, listed) = tool(&h, "schedule_list", json!({})).await;
        let ids: Vec<&str> = listed["schedules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, [id.as_str()]);
        for name in [
            "schedule_update",
            "schedule_delete",
            "schedule_run_now",
            "schedule_runs",
        ] {
            let (is_error, text, _) =
                tool(&h, name, json!({"id":foreign_id,"name":"hijack"})).await;
            assert!(is_error, "{name}");
            assert!(text.contains("not found"), "{name}: {text}");
        }
        let (status, other) = http_get(&h, "/api/schedules", "other").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(other["schedules"].as_array().unwrap().len(), 1);

        let (is_error, text, _) = tool(&h, "schedule_delete", json!({"id":id})).await;
        assert!(!is_error, "{text}");
        let (_, _, listed) = tool(&h, "schedule_list", json!({})).await;
        assert!(listed["schedules"].as_array().unwrap().is_empty());
        let (is_error, _, _) = tool(&h, "schedule_delete", json!({"id":id})).await;
        assert!(is_error);
    }

    #[tokio::test]
    async fn run_now_then_runs_returns_the_failed_run() {
        let h = harness().await;
        let (_, _, data) = tool(&h, "schedule_create", json!({"name":"r","instructions":"say hi","cadence":{"daily":{"time":"09:00"}},"timezone":"UTC","model":MODEL})).await;
        let id = data["schedule"]["id"].as_str().unwrap().to_string();
        let (is_error, text, data) = tool(&h, "schedule_run_now", json!({"id":id})).await;
        assert!(!is_error, "{text}");
        let run = &data["run"];
        // No runtime in the harness: the agent turn cannot succeed.
        assert_ne!(run["status"], "ok", "{run}");
        assert_ne!(run["status"], "running", "{run}");
        assert!(run["outputPreview"].is_string(), "{run}");
        assert!(run["error"].is_string(), "{run}");

        let (is_error, text, data) = tool(&h, "schedule_runs", json!({"id":id,"limit":3})).await;
        assert!(!is_error, "{text}");
        let runs = data["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["id"], run["id"]);
        assert_eq!(runs[0]["status"], run["status"]);
        assert!(runs[0]["error"].is_string());
        assert!(runs[0]["startedAt"].is_string() && runs[0]["finishedAt"].is_string());
    }

    #[tokio::test]
    async fn wiring_writes_the_placeholder_never_the_token() {
        let state = state();
        let token = ensure_token(&state).unwrap();
        // Preserve an unrelated entry.
        crate::routes::connectors::write_mcp_entry_named(
            &state,
            "other",
            Some(&json!({"url":"https://x.example"})),
        )
        .await
        .unwrap();
        assert!(wire(&state, 4321).await.unwrap());
        assert!(!wire(&state, 4321).await.unwrap(), "idempotent");
        let raw =
            std::fs::read_to_string(crate::routes::connectors::mcp_config_path(&state)).unwrap();
        assert!(!raw.contains(&token), "raw token leaked into mcp.json");
        let doc: Value = serde_json::from_str(&raw).unwrap();
        let entry = &doc["servers"]["amiro"];
        assert_eq!(entry["type"], "streamable-http");
        assert_eq!(entry["url"], "http://127.0.0.1:4321/agent-mcp");
        assert_eq!(
            entry["headers"]["x-amiro-agent-token"],
            "${AMIRO_AGENT_MCP_TOKEN}"
        );
        assert_eq!(entry["shared"], true);
        assert!(doc["servers"]["other"].is_object());
        // The value reaches the runtime via credential-env.json.
        let env: Value = serde_json::from_slice(
            &std::fs::read(state.runtime_home.join("credential-env.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(env["AMIRO_AGENT_MCP_TOKEN"], token);
        // A new port rewrites the entry.
        assert!(wire(&state, 9999).await.unwrap());
    }

    #[tokio::test]
    async fn notify_send_emits_through_the_pipeline() {
        let state = state();
        write_json(
            &state.home.join("users.json"),
            &json!({"users":[{"id":"owner","role":"admin"}]}),
        )
        .await
        .unwrap();
        let (text, data) = call_tool(
            &state,
            "notify_send",
            &json!({"title":"Hello","body":"World","urgency":"medium"}),
        )
        .await
        .unwrap();
        assert!(text.contains("Hello"), "unexpected text: {text}");
        let item = &data["notification"];
        assert_eq!(item["title"], json!("Hello"));
        // The tool accepts Vellum's `medium`; the feed persists `normal`.
        assert_eq!(item["urgency"], json!("normal"));
        assert_eq!(item["category"], json!("system"));
    }

    #[tokio::test]
    async fn notify_channel_list_says_what_each_channel_still_needs() {
        let state = state();
        write_json(
            &state.home.join("users.json"),
            &json!({"users":[{"id":"owner","role":"admin"}]}),
        )
        .await
        .unwrap();
        let (text, data) = call_tool(&state, "notify_channel_list", &json!({}))
            .await
            .unwrap();
        assert_eq!(data["channels"].as_array().unwrap().len(), 3);
        assert!(text.contains("telegram: connect its bot on the Channels page"), "{text}");
        assert!(call_tool(&state, "notify_channel_bind", &json!({"channel": "telegram"}))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn ui_render_openui_supports_presets_and_custom_code() {
        let state = state();
        write_json(
            &state.home.join("users.json"),
            &json!({"users":[{"id":"owner","role":"admin"}]}),
        )
        .await
        .unwrap();

        let (text, data) = call_tool(
            &state,
            "ui_render_openui",
            &json!({"preset": "budget_planner"}),
        )
        .await
        .unwrap();
        assert!(text.contains("```openui"), "expected openui fence: {text}");
        assert_eq!(data["surface"], json!("openui"));
        assert_eq!(data["preset"], json!("budget_planner"));
        assert!(
            data["code"]
                .as_str()
                .unwrap_or("")
                .contains("InteractiveForm"),
            "expected budget_planner code: {data}"
        );

        let (_, intake_data) = call_tool(
            &state,
            "ui_render_openui",
            &json!({"preset": "agent_data_intake"}),
        )
        .await
        .unwrap();
        assert_eq!(intake_data["preset"], json!("agent_data_intake"));
        assert!(
            intake_data["code"]
                .as_str()
                .unwrap_or("")
                .contains("SecretVaultCard"),
            "expected agent_data_intake code: {intake_data}"
        );

        let (_, inbox_data) = call_tool(
            &state,
            "ui_render_openui",
            &json!({"preset": "inbox_cleanup_setup"}),
        )
        .await
        .unwrap();
        assert_eq!(inbox_data["preset"], json!("inbox_cleanup_setup"));
        assert_eq!(inbox_data["title"], json!("Inbox Cleanup Schedule Studio"));
        let inbox_code = inbox_data["code"].as_str().unwrap_or("");
        assert!(inbox_code.contains("clean_promotions"));
        assert!(inbox_code.contains("keep_reservations_month"));
        assert!(inbox_code.contains("keep_bills_2_months"));

        let custom = "root = Stack([h])\nh = CardHeader(\"Custom Brief\", \"Live\")";
        let (_, custom_data) = call_tool(
            &state,
            "ui_render_openui",
            &json!({"title": "Custom Brief", "code": custom}),
        )
        .await
        .unwrap();
        assert_eq!(custom_data["title"], json!("Custom Brief"));
        assert_eq!(custom_data["code"], json!(custom));

        assert!(call_tool(&state, "ui_render_openui", &json!({}))
            .await
            .is_err());
        assert!(call_tool(
            &state,
            "ui_render_openui",
            &json!({"preset": "nonexistent"})
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn desktop_tools_are_listed_and_say_plainly_when_there_is_no_sandbox() {
        let names: Vec<String> = tool_definitions()
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_string))
            .collect();
        assert!(names.contains(&"desktop_open".to_string()));
        assert!(names.contains(&"desktop_state".to_string()));

        let h = harness().await;
        let state = h.state.clone();
        let err = call_tool(&state, "desktop_state", &json!({})).await.unwrap_err();
        assert!(err.contains("scripts/sandbox.sh up"), "{err}");
        let err = call_tool(&state, "desktop_open", &json!({"app": "files"})).await.unwrap_err();
        assert!(err.contains("scripts/sandbox.sh up"), "{err}");
        assert!(call_tool(&state, "desktop_open", &json!({})).await.is_err(), "app is required");
    }
}
