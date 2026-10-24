//! Per-agent Browser & Real X11 Virtual Desktop (VNC over WebSocket) service.
//!
//! 1. **Real X11 Virtual Desktop (`/api/desktop/ticket`, `/api/desktop/stream` WebSocket)**:
//!    Streams a live Vellum-parity Xtigervnc + Openbox + Plank + Chromium + Thunar + Terminal
//!    desktop running inside the agent's Docker container (`amiro-agent-<id>`) over
//!    raw RFB WebSocket binary frames to `@novnc/novnc`.
//! 2. **Browser inspection fallback (`/api/debug/browser`, `/api/debug/browser/navigate`)**:
//!    Provides HTTP browser inspection for tests and lightweight previews.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent::get_agent_identity;
use crate::routes::agents::{self, AGENT_HEADER, MAIN_AGENT_ID};
use crate::sandbox;
use crate::state::{now_iso, read_json, write_json, ApiError, AppState, AuthUser};

const TICKET_TTL: Duration = Duration::from_secs(60);

#[derive(Default)]
struct DesktopTicketStore {
    map: HashMap<String, (String, Instant)>,
}

impl DesktopTicketStore {
    fn issue(&mut self, user_id: &str) -> String {
        let now = Instant::now();
        self.map.retain(|_, (_, at)| now.duration_since(*at) < TICKET_TTL);
        let mut bytes = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut bytes);
        let ticket = hex::encode(bytes);
        self.map.insert(ticket.clone(), (user_id.to_string(), now));
        ticket
    }

    fn consume(&mut self, ticket: &str) -> Option<String> {
        let now = Instant::now();
        let (user, at) = self.map.remove(ticket)?;
        (now.saturating_duration_since(at) < TICKET_TTL).then_some(user)
    }
}

static DESKTOP_TICKETS: LazyLock<Mutex<DesktopTicketStore>> =
    LazyLock::new(|| Mutex::new(DesktopTicketStore::default()));

async fn issue_desktop_ticket(user: AuthUser) -> Result<Json<Value>, ApiError> {
    agents::require_admin(&user)?;
    let uid = user.0.get("id").and_then(Value::as_str).unwrap_or("admin");
    let ticket = DESKTOP_TICKETS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .issue(uid);
    Ok(Json(json!({
        "ticket": ticket,
        "expiresInMs": TICKET_TTL.as_millis() as u64,
    })))
}

#[derive(Deserialize, Default)]
struct StreamQuery {
    ticket: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
}

async fn desktop_stream_ws(
    State(state): State<AppState>,
    Query(query): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(ticket) = query.ticket.as_deref() else {
        return (StatusCode::UNAUTHORIZED, "missing desktop ticket").into_response();
    };
    let valid = DESKTOP_TICKETS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .consume(ticket);
    if valid.is_none() {
        return (StatusCode::UNAUTHORIZED, "invalid or expired desktop ticket").into_response();
    }

    let raw_agent = query.agent_id.unwrap_or_else(|| MAIN_AGENT_ID.to_string());
    let agent_id = if raw_agent.is_empty() || raw_agent == "amiro" {
        MAIN_AGENT_ID.to_string()
    } else {
        raw_agent
    };

    ws.protocols(["binary"])
        .on_upgrade(move |socket| handle_desktop_ws(state, agent_id, socket))
}

async fn resolve_agent_label_and_accent(state: &AppState, agent_id: &str) -> (String, String) {
    if agent_id == MAIN_AGENT_ID {
        let _ = tokio::fs::create_dir_all(state.home.join("agents").join(MAIN_AGENT_ID)).await;
        let id_doc = get_agent_identity(state, None).await.unwrap_or_else(|_| json!({}));
        let name = id_doc["name"].as_str().unwrap_or("Amiro").to_string();
        let accent = id_doc["accentHex"].as_str().unwrap_or("#E9642F").to_string();
        return (name, accent);
    }
    let _ = agents::working_dir_for(state, agent_id).await;
    if let Ok(scoped) = agents::scoped_state(state, agent_id).await {
        let id_doc = get_agent_identity(&scoped, None).await.unwrap_or_else(|_| json!({}));
        let name = id_doc["name"].as_str().unwrap_or("Agent").to_string();
        let accent = id_doc["accentHex"].as_str().unwrap_or("#38bdf8").to_string();
        return (name, accent);
    }
    ("Agent".to_string(), "#38bdf8".to_string())
}

/// Close codes the desktop viewer maps to a message.
pub const DESKTOP_CLOSE_UNAVAILABLE: u16 = 4008;
pub const DESKTOP_CLOSE_FAILED: u16 = 4011;

async fn close_desktop(mut socket: WebSocket, code: u16, reason: &str) {
    let frame = axum::extract::ws::CloseFrame { code, reason: reason.chars().take(120).collect::<String>().into() };
    let _ = socket.send(Message::Close(Some(frame))).await;
}

/// Pipe the viewer's RFB WebSocket frames to the agent's VNC server through
/// the supervisor's byte tunnel, and the server's bytes back as binary frames.
async fn handle_desktop_ws(state: AppState, agent_id: String, socket: WebSocket) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let Some(client) = sandbox::client(&state).await else {
        return close_desktop(socket, DESKTOP_CLOSE_UNAVAILABLE, "the sandbox is not set up").await;
    };
    let (label, accent) = resolve_agent_label_and_accent(&state, &agent_id).await;
    let tunnel = match client.desktop_connect(&agent_id, &label, &accent).await {
        Ok(tunnel) => tunnel,
        Err(e) => {
            let code = if e.status.is_none() { DESKTOP_CLOSE_UNAVAILABLE } else { DESKTOP_CLOSE_FAILED };
            return close_desktop(socket, code, &e.message).await;
        }
    };
    let (mut vnc_rx, mut vnc_tx) = tokio::io::split(tunnel);
    let (mut ws_tx, mut ws_rx) = socket.split();

    let up = async {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                Message::Binary(bytes) => {
                    if vnc_tx.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = vnc_tx.shutdown().await;
    };
    let down = async {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match vnc_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        return;
                    }
                }
            }
        }
        let _ = ws_tx.send(Message::Close(None)).await;
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
}

// ---------------------------------------------------------------------------
// Browser State & Navigation Endpoints (used by tests & HTTP preview)
// ---------------------------------------------------------------------------

fn resolve_agent_id(headers: &HeaderMap, body: Option<&Value>) -> String {
    if let Some(id) = body
        .and_then(|b| b.get("agentId").or_else(|| b.get("agent_id")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return id.to_string();
    }
    if let Some(id) = headers
        .get(AGENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return id.to_string();
    }
    MAIN_AGENT_ID.to_string()
}

fn browser_state_path(state: &AppState, agent_id: &str) -> PathBuf {
    if agent_id == MAIN_AGENT_ID || agent_id == "amiro" || agent_id.is_empty() {
        state.runtime_home.join("browser-state.json")
    } else {
        crate::state::agent_private_root(&state.home, agent_id).join("browser-state.json")
    }
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn strip_html_tags(html: &str) -> (String, String, Vec<Value>) {
    let mut title = String::new();
    let lower = html.to_lowercase();
    if let Some(start) = lower.find("<title") {
        if let Some(gt) = lower[start..].find('>') {
            let content_start = start + gt + 1;
            if let Some(end) = lower[content_start..].find("</title>") {
                title = html[content_start..content_start + end]
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
            }
        }
    }

    let mut links = Vec::new();
    let mut search_pos = 0;
    while let Some(a_idx) = lower[search_pos..].find("<a ") {
        let abs_a = search_pos + a_idx;
        let rest = &html[abs_a..];
        let rest_lower = &lower[abs_a..];
        let Some(gt) = rest_lower.find('>') else {
            break;
        };
        let tag_attrs = &rest[..gt];
        let after_gt = &rest[gt + 1..];
        let after_gt_lower = &rest_lower[gt + 1..];
        let Some(end_a) = after_gt_lower.find("</a>") else {
            search_pos = abs_a + gt + 1;
            continue;
        };
        let inner = &after_gt[..end_a];
        let label = strip_simple_tags(inner)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        if let Some(href) = extract_attr(tag_attrs, "href") {
            if (href.starts_with("http://")
                || href.starts_with("https://")
                || href.starts_with('/'))
                && !label.is_empty()
                && links.len() < 12
            {
                links.push(json!({
                    "label": label.chars().take(60).collect::<String>(),
                    "href": href,
                }));
            }
        }
        search_pos = abs_a + gt + 1 + end_a + 4;
    }

    let mut cleaned = html.to_string();
    for tag in ["script", "style", "noscript", "svg", "head"] {
        let open_pat = format!("<{tag}");
        let close_pat = format!("</{tag}>");
        loop {
            let l = cleaned.to_lowercase();
            let Some(s) = l.find(&open_pat) else { break };
            if let Some(e) = l[s..].find(&close_pat) {
                cleaned.replace_range(s..s + e + close_pat.len(), " ");
            } else {
                break;
            }
        }
    }

    let text = strip_simple_tags(&cleaned)
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    (title, text, links)
}

fn strip_simple_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => {
                in_tag = false;
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn extract_attr(attrs: &str, name: &str) -> Option<String> {
    let lower = attrs.to_lowercase();
    let pat = format!("{name}=");
    let idx = lower.find(&pat)?;
    let rest = attrs[idx + pat.len()..].trim_start();
    if let Some(stripped) = rest.strip_prefix('"') {
        let end = stripped.find('"')?;
        Some(stripped[..end].to_string())
    } else if let Some(stripped) = rest.strip_prefix('\'') {
        let end = stripped.find('\'')?;
        Some(stripped[..end].to_string())
    } else {
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(rest.len());
        Some(rest[..end].to_string())
    }
}

fn render_viewport_svg(
    url: &str,
    title: &str,
    text: &str,
    agent_id: &str,
    isolation: &str,
    status_code: u16,
) -> String {
    let safe_url = xml_escape(&url.chars().take(85).collect::<String>());
    let safe_title = xml_escape(
        &if title.trim().is_empty() {
            url.to_string()
        } else {
            title.to_string()
        }
        .chars()
        .take(70)
        .collect::<String>(),
    );
    let badge = xml_escape(&format!(
        "{} · HTTP {}",
        if isolation == "container" {
            format!("Container ({})", &agent_id[..agent_id.len().min(8)])
        } else {
            "Host Browser".to_string()
        },
        status_code
    ));

    let lines: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(18)
        .map(|line| {
            let truncated: String = line.chars().take(96).collect();
            xml_escape(&truncated)
        })
        .collect();

    let mut text_nodes = String::new();
    for (i, line) in lines.iter().enumerate() {
        let y = 165 + (i * 28);
        let fill = if i == 0 { "#f8fafc" } else { "#cbd5e1" };
        let weight = if i == 0 { "600" } else { "400" };
        text_nodes.push_str(&format!(
            r#"<text x="48" y="{y}" fill="{fill}" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="{weight}">{line}</text>"#
        ));
    }
    if lines.is_empty() {
        text_nodes.push_str(
            r##"<text x="48" y="180" fill="#94a3b8" font-family="Inter, system-ui, sans-serif" font-size="15">(Page loaded with no visible text content)</text>"##,
        );
    }

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#0f1117"/>
  <rect x="0" y="0" width="1280" height="56" fill="#161922"/>
  <circle cx="26" cy="28" r="6" fill="#ef4444"/>
  <circle cx="46" cy="28" r="6" fill="#f59e0b"/>
  <circle cx="66" cy="28" r="6" fill="#10b981"/>
  <rect x="96" y="12" width="920" height="32" rx="8" fill="#0f1117" stroke="#262b38"/>
  <text x="114" y="33" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="13">{safe_url}</text>
  <rect x="1032" y="12" width="224" height="32" rx="8" fill="#1e2433"/>
  <text x="1144" y="33" text-anchor="middle" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="12">{badge}</text>
  <rect x="28" y="76" width="1224" height="616" rx="12" fill="#131722" stroke="#222736"/>
  <text x="48" y="122" fill="#ffffff" font-family="Inter, system-ui, sans-serif" font-size="22" font-weight="700">{safe_title}</text>
  <line x1="48" y1="138" x2="1204" y2="138" stroke="#222736" stroke-width="1"/>
  {text_nodes}
</svg>"##
    );

    let b64 = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
    format!("data:image/svg+xml;base64,{b64}")
}

async fn get_browser_state(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    agents::require_admin(&user)?;
    let agent_id = resolve_agent_id(&headers, None);
    let is_team = agent_id != MAIN_AGENT_ID && agent_id != "amiro";

    if is_team {
        let _ = agents::working_dir_for(&state, &agent_id).await?;
    }

    let path = browser_state_path(&state, &agent_id);
    let saved = read_json(&path, Value::Null).await.unwrap_or(Value::Null);
    let isolation = if is_team { "container" } else { "host" };

    Ok(Json(json!({
        "agentId": agent_id,
        "isolation": isolation,
        "state": if saved.is_null() { "idle" } else { "ready" },
        "page": saved,
    })))
}

async fn navigate_browser(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    agents::require_admin(&user)?;
    let agent_id = resolve_agent_id(&headers, Some(&body));
    let is_team = agent_id != MAIN_AGENT_ID && agent_id != "amiro";

    let raw_url = body["url"].as_str().unwrap_or("").trim().to_string();
    if raw_url.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "A URL is required.".into()));
    }
    let normalized_url = if raw_url.starts_with("http://")
        || raw_url.starts_with("https://")
        || raw_url.starts_with("about:")
    {
        raw_url
    } else {
        format!("https://{raw_url}")
    };

    if normalized_url != "about:blank" {
        let parsed = url::Url::parse(&normalized_url)
            .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "Enter a valid HTTP(S) URL.".into()))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "Only HTTP and HTTPS URLs are supported.".into(),
            ));
        }
    }

    let (status_code, final_url, html, isolation) = if normalized_url == "about:blank" {
        (
            200u16,
            "about:blank".to_string(),
            "<html><head><title>Blank Page</title></head><body>Ready to browse. Enter a URL above to inspect how this agent sees the page.</body></html>".to_string(),
            if is_team { "container" } else { "host" },
        )
    } else if is_team {
        let tools = agents::agent_tools(&state, &agent_id)
            .await?
            .ok_or_else(agents::not_found)?;
        let allowed = tools["shell"].as_bool().unwrap_or(false)
            || tools["browser"].as_bool().unwrap_or(false);
        if !allowed {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Browser/Shell access is disabled for this team agent. Enable it above first.".into(),
            ));
        }
        let client = sandbox::client(&state).await.ok_or_else(|| {
            ApiError(StatusCode::SERVICE_UNAVAILABLE, sandbox::UNAVAILABLE.into())
        })?;
        let quoted = normalized_url.replace('\'', "'\"'\"'");
        let cmd = format!("curl -sSL -m 20 --max-filesize 524288 '{quoted}'");
        let exec_out = client
            .exec(&agent_id, &cmd, Some(25))
            .await
            .map_err(|e| match e.status {
                None => ApiError(StatusCode::SERVICE_UNAVAILABLE, sandbox::UNAVAILABLE.into()),
                Some(c) => ApiError(
                    StatusCode::from_u16(c).unwrap_or(StatusCode::BAD_GATEWAY),
                    e.message,
                ),
            })?;
        let code = exec_out["exitCode"].as_i64().unwrap_or(1);
        if code != 0 {
            let stderr = exec_out["stderr"].as_str().unwrap_or("Navigation failed");
            return Err(ApiError(
                StatusCode::BAD_GATEWAY,
                format!("Container browser fetch failed (exit {code}): {stderr}"),
            ));
        }
        let stdout = exec_out["stdout"].as_str().unwrap_or("").to_string();
        (200u16, normalized_url.clone(), stdout, "container")
    } else {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("AmiroAgentBrowser/1.0")
            .build()
            .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let resp = http
            .get(&normalized_url)
            .send()
            .await
            .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, format!("Navigation failed: {e}")))?;
        let status = resp.status().as_u16();
        let resolved = resp.url().to_string();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, format!("Failed reading page: {e}")))?;
        let body_str = String::from_utf8_lossy(&bytes[..bytes.len().min(512 * 1024)]).into_owned();
        (status, resolved, body_str, "host")
    };

    let (parsed_title, parsed_text, links) = strip_html_tags(&html);
    let title = if parsed_title.is_empty() {
        final_url.clone()
    } else {
        parsed_title
    };
    let excerpt: String = parsed_text.chars().take(12_000).collect();
    let screenshot = render_viewport_svg(
        &final_url,
        &title,
        &excerpt,
        &agent_id,
        isolation,
        status_code,
    );

    let page_doc = json!({
        "url": final_url,
        "title": title,
        "status": status_code,
        "text": excerpt,
        "links": links,
        "screenshot": screenshot,
        "capturedAt": now_iso(),
        "isolation": isolation,
    });

    let state_path = browser_state_path(&state, &agent_id);
    if let Some(parent) = state_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = write_json(&state_path, &page_doc).await;

    Ok(Json(json!({
        "agentId": agent_id,
        "isolation": isolation,
        "state": "ready",
        "page": page_doc,
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/desktop/ticket", post(issue_desktop_ticket))
        .route("/api/desktop/stream", get(desktop_stream_ws))
        .route("/api/debug/browser", get(get_browser_state))
        .route("/api/debug/browser/navigate", post(navigate_browser))
}
