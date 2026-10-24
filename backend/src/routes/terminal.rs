//! Admin Debug Terminal sessions, scoped per agent (`main` or team agent `<id>`).
//!
//! - For the main agent (`agent_id: "main"` or absent), spawns a host PTY
//!   (`openpty`) rooted at `state.workspace` (`~/.amiro/workspace`).
//! - For a team agent (`32-hex` id), follows the OpenDots / `sandboxd`
//!   architecture: delegates the interactive PTY session to `amiro-sandboxd`
//!   using that agent's derived `HMAC-SHA256` credential inside its isolated
//!   container (`<ns>-agent-<id>` at `/home/agent`). If the agent's `shell`
//!   tool switch is off or the sandbox supervisor is unreachable, creation
//!   fails closed with a clear message and never falls back to the host.
//!
//! Endpoints (owner/admin only, matching Vellum's terminal session shape):
//! - `POST   /api/terminal/sessions`
//! - `DELETE /api/terminal/sessions/{session_id}`
//! - `POST   /api/terminal/sessions/{session_id}/input`
//! - `POST   /api/terminal/sessions/{session_id}/resize`
//! - `GET    /api/terminal/sessions/{session_id}/events` (SSE stream of `{seq, data}`)

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

#[cfg(unix)]
use std::os::fd::RawFd;
#[cfg(unix)]
use std::path::Path;
#[cfg(not(unix))]
type RawFd = i32;

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine as _;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::routes::agents::{self, AGENT_HEADER, MAIN_AGENT_ID};
use crate::sandbox;
use crate::state::{ApiError, AppState, AuthUser};

#[derive(Clone, Debug)]
pub struct TerminalEvent {
    pub seq: u64,
    pub data: String,
}

enum SessionBackend {
    HostPty {
        master_fd: RawFd,
        child_pid: i32,
        input_tx: mpsc::Sender<Vec<u8>>,
        output_tx: broadcast::Sender<TerminalEvent>,
        history: Mutex<Vec<TerminalEvent>>,
        closed: Arc<AtomicBool>,
    },
    ContainerProxy {
        agent_id: String,
        remote_session_id: String,
    },
}

struct ActiveTerminalSession {
    backend: SessionBackend,
}

fn sessions_registry() -> &'static Mutex<HashMap<String, Arc<ActiveTerminalSession>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<ActiveTerminalSession>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resolve_requested_agent_id(headers: &HeaderMap, body: Option<&Value>) -> String {
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

#[cfg(unix)]
fn spawn_host_pty(
    workspace: &Path,
    agent_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(RawFd, i32), ApiError> {
    use std::ffi::CString;

    let _ = std::fs::create_dir_all(workspace);
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let mut ws = libc::winsize {
        ws_row: rows.clamp(1, 1000),
        ws_col: cols.clamp(1, 1000),
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut ws,
        )
    };
    if rc != 0 || master < 0 || slave < 0 {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to allocate PTY on host".into(),
        ));
    }

    let shell_str = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty() && Path::new(s).exists())
        .unwrap_or_else(|| {
            if Path::new("/bin/bash").exists() {
                "/bin/bash".to_string()
            } else {
                "/bin/sh".to_string()
            }
        });
    let shell_c = CString::new(shell_str.as_str()).unwrap_or_else(|_| CString::new("/bin/sh").unwrap());
    let arg0_c = CString::new(shell_str.as_str()).unwrap_or_else(|_| CString::new("sh").unwrap());
    let arg1_c = CString::new("-i").unwrap();
    let cwd_c = CString::new(workspace.to_string_lossy().as_bytes()).ok();

    let mut env_strings: Vec<CString> = std::env::vars()
        .filter(|(k, _)| k != "TERM" && k != "AMIRO_AGENT_ID")
        .filter_map(|(k, v)| CString::new(format!("{k}={v}")).ok())
        .collect();
    if let Ok(c) = CString::new("TERM=xterm-256color") {
        env_strings.push(c);
    }
    if let Ok(c) = CString::new(format!("AMIRO_AGENT_ID={agent_id}")) {
        env_strings.push(c);
    }
    let mut envp: Vec<*const libc::c_char> = env_strings.iter().map(|s| s.as_ptr()).collect();
    envp.push(std::ptr::null());

    let argv: [*const libc::c_char; 3] = [arg0_c.as_ptr(), arg1_c.as_ptr(), std::ptr::null()];

    let pid = unsafe { libc::fork() };
    if pid < 0 {
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fork PTY process".into(),
        ));
    }

    if pid == 0 {
        unsafe {
            libc::close(master);
            libc::setsid();
            libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
            libc::dup2(slave, 0);
            libc::dup2(slave, 1);
            libc::dup2(slave, 2);
            if slave > 2 {
                libc::close(slave);
            }
            if let Some(ref dir) = cwd_c {
                let _ = libc::chdir(dir.as_ptr());
            }
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            libc::signal(libc::SIGHUP, libc::SIG_DFL);
            libc::execve(shell_c.as_ptr(), argv.as_ptr(), envp.as_ptr());
            libc::_exit(127);
        }
    }

    unsafe {
        libc::close(slave);
    }

    Ok((master, pid))
}

#[cfg(unix)]
fn resize_fd(fd: RawFd, cols: u16, rows: u16) {
    let ws = libc::winsize {
        ws_row: rows.clamp(1, 1000),
        ws_col: cols.clamp(1, 1000),
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        let _ = libc::ioctl(fd, libc::TIOCSWINSZ, &ws);
    }
}

#[cfg(unix)]
fn terminate_host_pty(master_fd: RawFd, child_pid: i32, closed: &AtomicBool) {
    if !closed.swap(true, Ordering::SeqCst) {
        unsafe {
            if child_pid > 0 {
                let _ = libc::kill(-child_pid, libc::SIGHUP);
                let _ = libc::kill(child_pid, libc::SIGHUP);
            }
            let _ = libc::close(master_fd);
        }
        tokio::task::spawn_blocking(move || unsafe {
            if child_pid > 0 {
                let mut status: libc::c_int = 0;
                let _ = libc::waitpid(child_pid, &mut status, 0);
            }
        });
    }
}

#[cfg(not(unix))]
fn resize_fd(_fd: RawFd, _cols: u16, _rows: u16) {}

#[cfg(not(unix))]
fn terminate_host_pty(_master_fd: RawFd, _child_pid: i32, closed: &AtomicBool) {
    closed.store(true, Ordering::SeqCst);
}

async fn create_session(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    agents::require_admin(&user)?;
    let body_val = body.map(|b| b.0).unwrap_or_else(|| json!({}));
    let cols = body_val["cols"].as_u64().unwrap_or(80).clamp(1, 1000) as u16;
    let rows = body_val["rows"].as_u64().unwrap_or(24).clamp(1, 1000) as u16;
    let agent_id = resolve_requested_agent_id(&headers, Some(&body_val));

    // Team agent: fail-closed container terminal via sandboxd (OpenDots architecture).
    if agent_id != MAIN_AGENT_ID && agent_id != "amiro" {
        let tools = agents::agent_tools(&state, &agent_id)
            .await?
            .ok_or_else(agents::not_found)?;
        if !tools["shell"].as_bool().unwrap_or(false) {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "Shell access is disabled for this team agent. Enable Shell on the agent's Computer tab first.".into(),
            ));
        }
        let _ = agents::working_dir_for(&state, &agent_id).await?;
        let client = sandbox::client(&state).await.ok_or_else(|| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                sandbox::UNAVAILABLE.into(),
            )
        })?;
        let created = client
            .create_terminal_session(&agent_id, cols, rows)
            .await
            .map_err(|e| match e.status {
                None => ApiError(StatusCode::SERVICE_UNAVAILABLE, sandbox::UNAVAILABLE.into()),
                Some(code) => ApiError(
                    StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
                    e.message,
                ),
            })?;
        let remote_sid = created["session_id"]
            .as_str()
            .or_else(|| created["id"].as_str())
            .ok_or_else(|| {
                ApiError(
                    StatusCode::BAD_GATEWAY,
                    "sandbox supervisor did not return a terminal session ID".into(),
                )
            })?
            .to_string();

        let session_id = uuid::Uuid::new_v4().simple().to_string();
        let active = Arc::new(ActiveTerminalSession {
            backend: SessionBackend::ContainerProxy {
                agent_id: agent_id.clone(),
                remote_session_id: remote_sid,
            },
        });
        sessions_registry()
            .lock()
            .await
            .insert(session_id.clone(), active);

        return Ok((
            StatusCode::CREATED,
            Json(json!({
                "session_id": session_id,
                "id": session_id,
                "agent_id": agent_id,
                "isolation": "container",
                "cwd": "/home/agent",
            })),
        ));
    }

    // Main agent ("main" / "amiro"): host PTY rooted in `state.workspace`.
    create_host_pty_session(&state, cols, rows).await
}

#[cfg(not(unix))]
async fn create_host_pty_session(
    _state: &AppState,
    _cols: u16,
    _rows: u16,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Err(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "Host PTY requires a Unix host; use the container terminal on Windows.".into(),
    ))
}

#[cfg(unix)]
async fn create_host_pty_session(
    state: &AppState,
    cols: u16,
    rows: u16,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (master_fd, child_pid) = spawn_host_pty(&state.workspace, MAIN_AGENT_ID, cols, rows)?;
    let write_fd = unsafe { libc::dup(master_fd) };
    if write_fd < 0 {
        unsafe {
            libc::close(master_fd);
            libc::kill(child_pid, libc::SIGHUP);
        }
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to dup PTY descriptor".into(),
        ));
    }

    let session_id = uuid::Uuid::new_v4().simple().to_string();
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(128);
    let (output_tx, _) = broadcast::channel::<TerminalEvent>(256);
    let closed = Arc::new(AtomicBool::new(false));

    let active = Arc::new(ActiveTerminalSession {
        backend: SessionBackend::HostPty {
            master_fd,
            child_pid,
            input_tx,
            output_tx: output_tx.clone(),
            history: Mutex::new(Vec::new()),
            closed: closed.clone(),
        },
    });

    sessions_registry()
        .lock()
        .await
        .insert(session_id.clone(), active.clone());

    // Writer task for host PTY stdin
    let closed_writer = closed.clone();
    tokio::spawn(async move {
        while let Some(bytes) = input_rx.recv().await {
            if closed_writer.load(Ordering::SeqCst) {
                break;
            }
            let write_res = tokio::task::spawn_blocking(move || {
                let mut offset = 0;
                while offset < bytes.len() {
                    let n = unsafe {
                        libc::write(
                            write_fd,
                            bytes[offset..].as_ptr() as *const libc::c_void,
                            bytes.len() - offset,
                        )
                    };
                    if n <= 0 {
                        return Err(());
                    }
                    offset += n as usize;
                }
                Ok(())
            })
            .await;
            if !matches!(write_res, Ok(Ok(()))) {
                break;
            }
        }
        unsafe {
            let _ = libc::close(write_fd);
        }
    });

    // Reader thread for host PTY stdout/stderr
    let active_reader = active.clone();
    let sid_cleanup = session_id.clone();
    let closed_reader = closed.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut seq: u64 = 0;
        loop {
            if closed_reader.load(Ordering::SeqCst) {
                break;
            }
            let n = unsafe {
                libc::read(
                    master_fd,
                    buf.as_mut_ptr() as *mut libc::c_void,
                    buf.len(),
                )
            };
            if n <= 0 {
                break;
            }
            seq += 1;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n as usize]);
            let event = TerminalEvent { seq, data: encoded };
            if let SessionBackend::HostPty {
                ref history,
                ref output_tx,
                ..
            } = active_reader.backend
            {
                if let Ok(mut hist) = history.try_lock() {
                    if hist.len() >= 128 {
                        hist.remove(0);
                    }
                    hist.push(event.clone());
                }
                let _ = output_tx.send(event);
            }
        }
        terminate_host_pty(master_fd, child_pid, &closed_reader);
        if let Ok(mut reg) = sessions_registry().try_lock() {
            reg.remove(&sid_cleanup);
        }
    });

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "session_id": session_id,
            "id": session_id,
            "agent_id": MAIN_AGENT_ID,
            "isolation": "host",
            "cwd": state.workspace.to_string_lossy(),
        })),
    ))
}

async fn send_input(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(session_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    agents::require_admin(&user)?;
    let data = body["data"].as_str().unwrap_or("");
    let session = sessions_registry()
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "terminal session not found".into()))?;

    match &session.backend {
        SessionBackend::HostPty { input_tx, closed, .. } => {
            if closed.load(Ordering::SeqCst) {
                return Err(ApiError(StatusCode::GONE, "terminal session closed".into()));
            }
            if !data.is_empty() {
                input_tx
                    .send(data.as_bytes().to_vec())
                    .await
                    .map_err(|_| ApiError(StatusCode::GONE, "terminal session closed".into()))?;
            }
        }
        SessionBackend::ContainerProxy {
            agent_id,
            remote_session_id,
        } => {
            let client = sandbox::client(&state).await.ok_or_else(|| {
                ApiError(StatusCode::SERVICE_UNAVAILABLE, sandbox::UNAVAILABLE.into())
            })?;
            client
                .terminal_session_input(agent_id, remote_session_id, data)
                .await
                .map_err(|e| match e.status {
                    None => ApiError(StatusCode::SERVICE_UNAVAILABLE, sandbox::UNAVAILABLE.into()),
                    Some(code) => ApiError(
                        StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
                        e.message,
                    ),
                })?;
        }
    }

    Ok(Json(json!({"ok": true})))
}

async fn resize_session(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(session_id): UrlPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    agents::require_admin(&user)?;
    let cols = body["cols"].as_u64().unwrap_or(80).clamp(1, 1000) as u16;
    let rows = body["rows"].as_u64().unwrap_or(24).clamp(1, 1000) as u16;
    let session = sessions_registry()
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "terminal session not found".into()))?;

    match &session.backend {
        SessionBackend::HostPty { master_fd, .. } => {
            resize_fd(*master_fd, cols, rows);
        }
        SessionBackend::ContainerProxy {
            agent_id,
            remote_session_id,
        } => {
            let client = sandbox::client(&state).await.ok_or_else(|| {
                ApiError(StatusCode::SERVICE_UNAVAILABLE, sandbox::UNAVAILABLE.into())
            })?;
            client
                .terminal_session_resize(agent_id, remote_session_id, cols, rows)
                .await
                .map_err(|e| match e.status {
                    None => ApiError(StatusCode::SERVICE_UNAVAILABLE, sandbox::UNAVAILABLE.into()),
                    Some(code) => ApiError(
                        StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY),
                        e.message,
                    ),
                })?;
        }
    }

    Ok(Json(json!({"ok": true})))
}

async fn destroy_session(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(session_id): UrlPath<String>,
) -> Result<Json<Value>, ApiError> {
    agents::require_admin(&user)?;
    if let Some(session) = sessions_registry().lock().await.remove(&session_id) {
        match &session.backend {
            SessionBackend::HostPty {
                master_fd,
                child_pid,
                closed,
                ..
            } => {
                terminate_host_pty(*master_fd, *child_pid, closed);
            }
            SessionBackend::ContainerProxy {
                agent_id,
                remote_session_id,
            } => {
                if let Some(client) = sandbox::client(&state).await {
                    let _ = client
                        .terminal_session_destroy(agent_id, remote_session_id)
                        .await;
                }
            }
        }
    }
    Ok(Json(json!({"ok": true})))
}

async fn stream_events(
    State(state): State<AppState>,
    user: AuthUser,
    UrlPath(session_id): UrlPath<String>,
) -> Result<Response, ApiError> {
    agents::require_admin(&user)?;
    let session = sessions_registry()
        .lock()
        .await
        .get(&session_id)
        .cloned()
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "terminal session not found".into()))?;

    let stream = async_stream::stream! {
        match &session.backend {
            SessionBackend::HostPty {
                output_tx,
                history,
                closed,
                ..
            } => {
                let mut rx = output_tx.subscribe();
                let mut last_seq = 0u64;
                {
                    let hist = history.lock().await;
                    for item in hist.iter() {
                        last_seq = item.seq;
                        let payload = json!({"seq": item.seq, "data": item.data}).to_string();
                        yield Ok::<_, std::convert::Infallible>(format!("data: {payload}\n\n"));
                    }
                }
                loop {
                    if closed.load(Ordering::SeqCst) {
                        break;
                    }
                    match tokio::time::timeout(Duration::from_secs(15), rx.recv()).await {
                        Ok(Ok(event)) => {
                            if event.seq > last_seq {
                                last_seq = event.seq;
                                let payload = json!({"seq": event.seq, "data": event.data}).to_string();
                                yield Ok(format!("data: {payload}\n\n"));
                            }
                        }
                        Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                        Ok(Err(broadcast::error::RecvError::Closed)) => break,
                        Err(_) => {
                            yield Ok(": keepalive\n\n".to_string());
                        }
                    }
                }
            }
            SessionBackend::ContainerProxy {
                agent_id,
                remote_session_id,
            } => {
                let Some(client) = sandbox::client(&state).await else {
                    return;
                };
                let mut after_seq = 0u64;
                loop {
                    match client.terminal_session_events(agent_id, remote_session_id, after_seq).await {
                        Ok(resp) => {
                            if let Some(events) = resp["events"].as_array() {
                                for ev in events {
                                    let seq = ev["seq"].as_u64().unwrap_or(0);
                                    let data = ev["data"].as_str().unwrap_or("");
                                    if seq > after_seq && !data.is_empty() {
                                        after_seq = seq;
                                        let payload = json!({"seq": seq, "data": data}).to_string();
                                        yield Ok::<_, std::convert::Infallible>(format!("data: {payload}\n\n"));
                                    }
                                }
                            }
                            if resp["closed"].as_bool() == Some(true) {
                                break;
                            }
                            yield Ok(": keepalive\n\n".to_string());
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/terminal/sessions", post(create_session))
        .route("/api/terminal/sessions/{session_id}", delete(destroy_session))
        .route("/api/terminal/sessions/{session_id}/input", post(send_input))
        .route(
            "/api/terminal/sessions/{session_id}/resize",
            post(resize_session),
        )
        .route(
            "/api/terminal/sessions/{session_id}/events",
            get(stream_events),
        )
        .route("/api/terminal/sessions/{session_id}/events/", get(stream_events))
}
