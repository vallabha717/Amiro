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
const RUN_NOW_WAIT_SECS: u64 = 30;

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
    let mode = json!({"type":"string","enum":["agent","execute","notify"],"description":"agent: full agent turn with tools (default). execute: model-only turn. notify: post the instructions as a message."});
    let id = json!({"type":"string","description":"Schedule id from schedule_list"});
    vec![
        json!({"name":"schedule_list","description":"List the owner's schedules (the same ones shown on the Schedules page).","inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"schedule_create","description":"Create a recurring or one-time schedule. It appears on the Schedules page.","inputSchema":{"type":"object","properties":{
            "name":{"type":"string"},
            "instructions":{"type":"string","description":"What the agent should do each run"},
            "mode":mode,
            "cadence":cadence_schema(),
            "timezone":{"type":"string","description":"IANA timezone; defaults to the owner's timezone, else UTC"},
            "enabled":{"type":"boolean","default":true},
            "model":{"type":"string","description":"Provider-qualified model route; defaults to the deployment default"},
            "thread_id":{"type":"string","description":"Chat thread this was created from, if known"}
        },"required":["name","instructions","cadence"],"additionalProperties":false}}),
        json!({"name":"schedule_update","description":"Change a schedule. Only the provided fields change.","inputSchema":{"type":"object","properties":{
            "id":id,"name":{"type":"string"},"instructions":{"type":"string"},"mode":mode,
            "cadence":cadence_schema(),"timezone":{"type":"string"},"enabled":{"type":"boolean"},"model":{"type":"string"}
        },"required":["id"],"additionalProperties":false}}),
        json!({"name":"schedule_delete","description":"Delete a schedule (run history is kept).","inputSchema":{"type":"object","properties":{"id":id},"required":["id"],"additionalProperties":false}}),
        json!({"name":"schedule_run_now","description":"Run a schedule immediately and return the run result.","inputSchema":{"type":"object","properties":{"id":id},"required":["id"],"additionalProperties":false}}),
        json!({"name":"schedule_runs","description":"Recent runs of a schedule (status, times, output or error, result thread). Use this to read logs.","inputSchema":{"type":"object","properties":{"id":id,"limit":{"type":"integer","minimum":1,"maximum":50,"default":5}},"required":["id"],"additionalProperties":false}}),
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
        "id": pick("id"), "name": pick("name"), "mode": pick("mode"),
        "enabled": pick("enabled"), "cadenceDescription": pick("cadenceDescription"),
        "nextRunAt": pick("nextRunAt"), "lastRunAt": pick("lastRunAt"),
        "lastStatus": pick("lastStatus"), "createdBy": pick("createdBy"),
    })
}

fn detail(schedule: &Value) -> Value {
    let mut out = summary(schedule);
    let pick = |k: &str| schedule.get(k).cloned().unwrap_or(Value::Null);
    if let Some(map) = out.as_object_mut() {
        map.insert("instructions".into(), pick("prompt"));
        map.insert("timezone".into(), pick("timezone"));
        map.insert("model".into(), pick("model"));
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
        "finishedAt": pick("finishedAt"), "outputPreview": preview.clone(),
        "threadId": pick("threadId"),
    });
    if !matches!(status, "ok" | "running" | "success") {
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
            let spec = cadence_to_spec(args.get("cadence").unwrap_or(&Value::Null))?;
            let mut body = json!({
                "name": require_str(args, "name")?,
                "prompt": require_str(args, "instructions")?,
                "mode": mode,
                "timezone": timezone,
                "schedule": spec,
                "enabled": args.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            });
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
                ("instructions", "prompt"),
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
            if let Some(cadence) = args.get("cadence").filter(|c| !c.is_null()) {
                patch.insert("schedule".into(), cadence_to_spec(cadence)?);
            }
            if patch.is_empty() {
                return Err("nothing to update: provide at least one of name, instructions, mode, cadence, timezone, enabled, model".into());
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
                "Run started and is still in progress; check schedule_runs for the result."
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
        other => Err(format!("unknown tool \"{other}\"")),
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
        assert_eq!(
            names,
            [
                "schedule_list",
                "schedule_create",
                "schedule_update",
                "schedule_delete",
                "schedule_run_now",
                "schedule_runs"
            ]
        );
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
}
