//! Native bridge to the owned Amiro runtime.
//!
//! Every session, turn and history read here goes through the real harness API
//! using the Amiro-owned `amiro-sdk` crate (protocol v1: NDJSON frames with
//! `v`/`id`/`reply_to` correlation, `Hello` negotiation, `Create`/`Attach`,
//! `SendMessage`, and streamed events). There is no invented frame shape and no
//! second agent loop: the runtime owns model execution, tools and transcripts.
//!
//! Failure policy: a missing runtime, a refused capability, a busy session or a
//! rejected turn is reported as an error. Nothing here reports success it did
//! not observe.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use amiro_sdk::{
    AmiroClient, ApiEvent, ConnectOptions, CreateSessionOptions, RunOptions, ToolConfiguration,
};
use axum::http::StatusCode;
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

use crate::state::{ApiError, AppState};

/// Identity reported to the runtime. The runtime records this in session
/// metadata, so it names the process actually connecting.
const RUNTIME_CLIENT_NAME: &str = concat!("amiro-backend/", env!("CARGO_PKG_VERSION"));

/// Capability a session needs before its tool policy can be enforced.
const SESSION_TOOLS: &str = "session_tools";

/// How long one harness request may wait for its reply.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for a runtime bridge to publish its socket after spawn.
const BRIDGE_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a turn may run before the stream gives up on it.
const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Bounded reconnect schedule for a capability that the bridge withholds for a
/// few seconds after a previous turn connection closes.
const CAPABILITY_DELAYS_MS: &[u64] = &[200, 400, 700, 1100, 1700, 2500, 2500];

fn runtime_home(state: &AppState) -> PathBuf {
    state.runtime_home.clone()
}

fn runtime_dir(state: &AppState) -> PathBuf {
    state
        .runtime_socket
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| runtime_home(state).join("run"))
}

/// Environment for every runtime child process: Amiro's own home/socket
/// variables, telemetry off, and no pre-rename variables inherited from the
/// parent process. The runtime resolves `AMIRO_HOME` before any legacy name, so
/// setting it is enough and a stale `JCODE_HOME` in the parent cannot relocate
/// the instance.
fn runtime_env(state: &AppState) -> HashMap<OsString, OsString> {
    let mut env: HashMap<OsString, OsString> = std::env::vars_os().collect();
    let home = runtime_home(state).to_string_lossy().to_string();
    env.insert("AMIRO_HOME".into(), OsString::from(&home));
    env.insert("AMIRO_RUNTIME_HOME".into(), OsString::from(&home));
    env.insert(
        "AMIRO_RUNTIME_DIR".into(),
        OsString::from(runtime_dir(state).to_string_lossy().to_string()),
    );
    env.entry("AMIRO_NO_TELEMETRY".into())
        .or_insert_with(|| OsString::from("1"));
    env.insert(
        "AMIRO_API_SOCKET".into(),
        OsString::from(state.runtime_socket.to_string_lossy().to_string()),
    );
    // The host shell exports the upstream engine's provider profile
    // (JCODE_OPENROUTER_* pointing at a real gateway, plus its API keys).
    // Inherited, those hijack the runtime's provider selection: sessions
    // silently run against the host gateway instead of the configured
    // Amiro provider. Strip everything except the Amiro namespace.
    let keys: Vec<OsString> = env.keys().cloned().collect();
    for key in keys {
        let name = key.to_string_lossy();
        let legacy = name.starts_with("JCODE_")
            || name.starts_with("OPENROUTER_")
            || name.starts_with("META_MUSE_")
            || name.starts_with("OPENAI_COMPAT_");
        if legacy {
            env.remove(&key);
        }
    }
    for legacy in [
        "JCODE_HOME",
        "JCODE_RUNTIME_DIR",
        "JCODE_API_SOCKET",
        "JCODE_SOCKET",
        "JCODE_NO_TELEMETRY",
    ] {
        env.remove(&OsString::from(legacy));
    }
    env
}

/// Whether something accepts connections on `path` right now.
fn socket_ready(path: &Path) -> bool {
    #[cfg(unix)]
    {
        match std::os::unix::net::UnixStream::connect(path) {
            Ok(_) => true,
            Err(error) => matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
            ),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

fn set_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Start the runtime bridge for this instance when nothing is listening yet.
///
/// The desktop app may already run the bridge as a managed sidecar; in that case
/// the socket is live and this is a no-op. `AMIRO_NO_RUNTIME_SPAWN=1` disables
/// spawning for deployments that supervise the runtime themselves.
pub async fn ensure_bridge(state: &AppState) -> Result<(), ApiError> {
    if socket_ready(&state.runtime_socket) {
        return Ok(());
    }
    if std::env::var("AMIRO_NO_RUNTIME_SPAWN").as_deref() == Ok("1") {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "Amiro runtime is not running (no socket at {})",
                state.runtime_socket.display()
            ),
        ));
    }
    if !state.runtime_bin.is_file() && state.runtime_bin.components().count() > 1 {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "Amiro runtime executable not found at {} (set AMIRO_RUNTIME_BIN)",
                state.runtime_bin.display()
            ),
        ));
    }
    set_private_dir(&runtime_dir(state)).map_err(|error| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not prepare runtime directory: {error}"),
        )
    })?;
    remove_stale_socket(&state.runtime_socket);
    let socket = state.runtime_socket.to_string_lossy().to_string();
    let mut command = std::process::Command::new(&state.runtime_bin);
    command
        .arg("--no-update")
        .arg("api-bridge")
        .arg("--api-socket")
        .arg(&socket)
        .envs(runtime_env(state))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group so the bridge and its daemon are not torn down
        // with an unrelated parent signal.
        command.process_group(0);
    }
    let child = command.spawn().map_err(|error| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "could not start Amiro runtime {}: {error}",
                state.runtime_bin.display()
            ),
        )
    })?;
    // Detach: the runtime outlives this request. It is reaped by the app, by
    // the supervisor on restart, or by the OS.
    remember_bridge_child(child);
    let deadline = std::time::Instant::now() + BRIDGE_STARTUP_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if socket_ready(&state.runtime_socket) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        format!(
            "Amiro runtime did not accept connections at {} within {}s",
            state.runtime_socket.display(),
            BRIDGE_STARTUP_TIMEOUT.as_secs()
        ),
    ))
}

static BRIDGE_CHILD: std::sync::OnceLock<std::sync::Mutex<Option<std::process::Child>>> =
    std::sync::OnceLock::new();

fn bridge_child_slot() -> &'static std::sync::Mutex<Option<std::process::Child>> {
    BRIDGE_CHILD.get_or_init(|| std::sync::Mutex::new(None))
}

fn remember_bridge_child(child: std::process::Child) {
    if let Ok(mut slot) = bridge_child_slot().lock() {
        *slot = Some(child);
    }
}

/// Stop the bridge this backend started. A bridge that another supervisor owns
/// (the desktop sidecar) is left alone.
fn stop_spawned_bridge() {
    let Ok(mut slot) = bridge_child_slot().lock() else {
        return;
    };
    if let Some(mut child) = slot.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Remove a socket file nothing is accepting on, so a restarted bridge can bind
/// it again.
fn remove_stale_socket(path: &Path) {
    if !socket_ready(path) {
        let _ = std::fs::remove_file(path);
    }
}

/// Start the runtime bridge synchronously, for the supervisor thread.
fn ensure_bridge_blocking(state: &AppState) -> Result<(), ApiError> {
    if socket_ready(&state.runtime_socket) {
        return Ok(());
    }
    if std::env::var("AMIRO_NO_RUNTIME_SPAWN").as_deref() == Ok("1") {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "Amiro runtime is not running (no socket at {})",
                state.runtime_socket.display()
            ),
        ));
    }
    set_private_dir(&runtime_dir(state)).map_err(|error| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not prepare runtime directory: {error}"),
        )
    })?;
    remove_stale_socket(&state.runtime_socket);
    let socket = state.runtime_socket.to_string_lossy().to_string();
    let mut command = std::process::Command::new(&state.runtime_bin);
    command
        .arg("--no-update")
        .arg("api-bridge")
        .arg("--api-socket")
        .arg(&socket)
        .envs(runtime_env(state))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn().map_err(|error| {
        ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "could not start Amiro runtime {}: {error}",
                state.runtime_bin.display()
            ),
        )
    })?;
    remember_bridge_child(child);
    let deadline = std::time::Instant::now() + BRIDGE_STARTUP_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if socket_ready(&state.runtime_socket) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    stop_spawned_bridge();
    remove_stale_socket(&state.runtime_socket);
    Err(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        format!(
            "Amiro runtime did not accept connections at {} within {}s",
            state.runtime_socket.display(),
            BRIDGE_STARTUP_TIMEOUT.as_secs()
        ),
    ))
}

/// Whether the runtime answers a protocol ping right now.
fn runtime_healthy(state: &AppState) -> bool {
    match connect_client(state, false) {
        Ok(client) => client.ping().is_ok(),
        Err(_) => false,
    }
}

/// Recover a dead runtime: stop our own stale bridge, clear its socket and
/// start a fresh one.
fn restart_bridge_blocking(state: &AppState) -> Result<(), ApiError> {
    stop_spawned_bridge();
    remove_stale_socket(&state.runtime_socket);
    ensure_bridge_blocking(state)
}

/// Keep the runtime alive and recover it when it dies.
///
/// The daemon exits after five minutes with no clients. Without a keepalive the
/// first chat after an idle pause would fail ("harness connection closed") even
/// though the app is running. This thread holds one cheap client and pings it,
/// and restarts the bridge it owns if the daemon still goes away.
/// `AMIRO_NO_RUNTIME_KEEPALIVE=1` disables it for callers that supervise the
/// runtime themselves.
pub fn spawn_supervisor(state: AppState) {
    if std::env::var("AMIRO_NO_RUNTIME_KEEPALIVE").as_deref() == Ok("1") {
        return;
    }
    let thread = std::thread::Builder::new()
        .name("amiro-runtime-supervisor".into())
        .spawn(move || loop {
            if !socket_ready(&state.runtime_socket) || !runtime_healthy(&state) {
                if let Err(error) = restart_bridge_blocking(&state) {
                    eprintln!("amiro runtime supervisor: {}", error.1);
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                }
            }
            let Ok(client) = connect_client(&state, false) else {
                std::thread::sleep(Duration::from_secs(5));
                continue;
            };
            loop {
                std::thread::sleep(Duration::from_secs(15));
                if client.ping().is_err() {
                    break;
                }
            }
        });
    if thread.is_err() {
        eprintln!("amiro runtime supervisor could not start");
    }
}

fn runtime_error(message: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, message.to_string())
}

/// Connect and complete the protocol handshake.
///
/// `require_session_tools` reconnects while the bridge withholds the capability
/// it needs to enforce the session tool policy. This is not a retry of a failed
/// turn: without the capability the turn would run with unknown tools, so
/// failing closed is the only safe option.
fn connect_client(state: &AppState, require_session_tools: bool) -> Result<AmiroClient, ApiError> {
    let options = || ConnectOptions {
        socket_path: Some(state.runtime_socket.clone()),
        client_name: RUNTIME_CLIENT_NAME.to_string(),
        request_timeout: Some(REQUEST_TIMEOUT),
        // The bridge is started by `ensure_bridge`, which runs before this and
        // needs to know the real failure if it did not come up.
        ensure_runtime: false,
        supports_user_response: false,
    };
    for (attempt, delay) in std::iter::once(&0u64)
        .chain(CAPABILITY_DELAYS_MS.iter())
        .enumerate()
    {
        if *delay > 0 {
            std::thread::sleep(Duration::from_millis(*delay));
        }
        match AmiroClient::connect(options()) {
            Ok(client) => {
                if !require_session_tools || client.supports(SESSION_TOOLS) {
                    return Ok(client);
                }
                if attempt == CAPABILITY_DELAYS_MS.len() {
                    return Err(runtime_error(format!(
                        "Amiro runtime did not offer the {SESSION_TOOLS} capability; refusing to send a turn with unknown tools"
                    )));
                }
            }
            Err(error) => return Err(runtime_error(error)),
        }
    }
    Err(runtime_error(
        "Amiro runtime capabilities could not be negotiated",
    ))
}

/// Run one blocking harness interaction on a worker thread.
async fn blocking<T, F>(label: &'static str, work: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ApiError> + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(error) => Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{label} worker failed: {error}"),
        )),
    }
}

// ---------------------------------------------------------------------------
// CLI surface: provider auth status and model catalogs.
//
// These are read-only catalog commands; the harness API has no equivalent for
// provider login state, so the owned runtime CLI answers them.
// ---------------------------------------------------------------------------

pub async fn exec_json(state: &AppState, args: &[&str]) -> Result<Value, ApiError> {
    let output = Command::new(&state.runtime_bin)
        .args(args)
        .envs(runtime_env(state))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| {
            ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                format!(
                    "could not run Amiro runtime {}: {error}",
                    state.runtime_bin.display()
                ),
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "runtime {:?} failed: {}",
                args,
                stderr.trim().to_string()
            ),
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("runtime {:?} produced no output", args),
        ));
    }
    serde_json::from_str(&text).map_err(|error| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("invalid json from runtime {:?}: {error}", args),
        )
    })
}

pub async fn auth_status(state: &AppState) -> Result<Value, ApiError> {
    exec_json(state, &["auth", "status", "--json"]).await
}

pub async fn model_list(state: &AppState, provider: &str) -> Result<Value, ApiError> {
    exec_json(state, &["model", "list", "-p", provider, "--json"]).await
}

// ---------------------------------------------------------------------------
// Session surface
// ---------------------------------------------------------------------------

/// One runtime session, as the backend needs to record it.
#[derive(Debug, Clone)]
pub struct SessionHandle {
    pub session_id: String,
    pub working_dir: Option<String>,
    pub created: bool,
}

fn session_handle(
    state: &AppState,
    info: amiro_sdk::SessionInfo,
    created: bool,
    requested_working_dir: &str,
) -> Result<SessionHandle, ApiError> {
    let applied = info.working_dir.clone();
    // The daemon echoes the directory it used. Running a turn in a different
    // folder than the user chose is a silent data-placement bug, so refuse it.
    if !requested_working_dir.is_empty() {
        if let Some(applied) = applied.as_deref() {
            let normalise = |value: &str| value.trim_end_matches(['/', '\\']).to_string();
            if normalise(applied) != normalise(requested_working_dir) {
                return Err(ApiError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!(
                        "session started in {applied} instead of the selected folder {requested_working_dir}"
                    ),
                ));
            }
        }
    }
    let _ = state;
    Ok(SessionHandle {
        session_id: info.session_id,
        working_dir: applied,
        created,
    })
}

/// Create a session pinned to `working_dir`, with the tool policy applied.
pub async fn create_session(
    state: &AppState,
    working_dir: &str,
    expose_tools: bool,
) -> Result<SessionHandle, ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let working_dir = working_dir.to_string();
    blocking("create_session", move || {
        let client = connect_client(&state, !expose_tools)?;
        let info = client
            .create_session_with_options(CreateSessionOptions {
                working_dir: Some(working_dir.clone()),
                system_prompt: None,
            })
            .map_err(runtime_error)?;
        if !expose_tools {
            client
                .configure_tools(&info.session_id, no_tools())
                .map_err(runtime_error)?;
        }
        session_handle(&state, info, true, &working_dir)
    })
    .await
}

/// Attach to an existing session on its own connection.
pub async fn attach_session(
    state: &AppState,
    session_id: &str,
) -> Result<SessionHandle, ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let session_id = session_id.to_string();
    blocking("attach_session", move || {
        let client = connect_client(&state, false)?;
        let info = client.attach_session(&session_id).map_err(runtime_error)?;
        session_handle(&state, info, false, "")
    })
    .await
}

/// Tool configuration for the default, untrusted profile: no tools at all.
/// A client may never widen its own access; only a trusted operator deployment
/// (`AMIRO_TRUSTED_OPERATOR=1` with `AMIRO_TOOL_PROFILE=full`) inherits the
/// daemon defaults.
pub fn no_tools() -> ToolConfiguration {
    ToolConfiguration {
        enabled: Some(Vec::new()),
        disabled: Vec::new(),
        custom: Vec::new(),
    }
}

/// Whether this deployment runs with the runtime's own tool defaults.
pub fn expose_tools() -> bool {
    std::env::var("AMIRO_TRUSTED_OPERATOR").as_deref() == Ok("1")
        && std::env::var("AMIRO_TOOL_PROFILE").as_deref() == Ok("full")
}

/// Runtime history for a session, as the frontend message shape's source rows.
pub async fn get_history(state: &AppState, session_id: &str) -> Result<Vec<Value>, ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let session_id = session_id.to_string();
    blocking("get_history", move || {
        let client = connect_client(&state, false)?;
        client.attach_session(&session_id).map_err(runtime_error)?;
        let messages = client.get_history(&session_id).map_err(runtime_error)?;
        Ok(messages
            .into_iter()
            .map(|message| serde_json::to_value(message).unwrap_or(Value::Null))
            .collect())
    })
    .await
}

pub async fn archive_session(state: &AppState, session_id: &str) -> Result<(), ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let session_id = session_id.to_string();
    blocking("archive_session", move || {
        let client = connect_client(&state, false)?;
        client.attach_session(&session_id).map_err(runtime_error)?;
        client.archive_session(&session_id).map_err(runtime_error)
    })
    .await
}

pub async fn restore_session(state: &AppState, session_id: &str) -> Result<(), ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let session_id = session_id.to_string();
    blocking("restore_session", move || {
        let client = connect_client(&state, false)?;
        client.restore_session(&session_id).map_err(runtime_error)
    })
    .await
}

pub async fn rename_session(
    state: &AppState,
    session_id: &str,
    title: &str,
) -> Result<(), ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let (session_id, title) = (session_id.to_string(), title.to_string());
    blocking("rename_session", move || {
        let client = connect_client(&state, false)?;
        client.attach_session(&session_id).map_err(runtime_error)?;
        client
            .rename_session(&session_id, Some(title))
            .map_err(runtime_error)
    })
    .await
}

pub async fn rewind_session(
    state: &AppState,
    session_id: &str,
    message_index: usize,
) -> Result<(), ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let session_id = session_id.to_string();
    blocking("rewind_session", move || {
        let client = connect_client(&state, false)?;
        client.attach_session(&session_id).map_err(runtime_error)?;
        client
            .rewind(&session_id, message_index)
            .map_err(runtime_error)
    })
    .await
}

/// One-shot turn in a throwaway session (title generation, structured prompts).
pub async fn run_once(
    state: &AppState,
    working_dir: &str,
    prompt: &str,
) -> Result<String, ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let (working_dir, prompt) = (working_dir.to_string(), prompt.to_string());
    blocking("run_once", move || {
        let client = connect_client(&state, true)?;
        let session = client
            .create_session_with_options(CreateSessionOptions {
                working_dir: Some(working_dir),
                system_prompt: None,
            })
            .map_err(runtime_error)?;
        let session_id = session.session_id.clone();
        let outcome = (|| -> Result<String, ApiError> {
            client
                .configure_tools(&session_id, no_tools())
                .map_err(runtime_error)?;
            let turn = client
                .run(&session_id, &prompt, RunOptions::default())
                .map_err(runtime_error)?;
            Ok(turn.final_text)
        })();
        // Best-effort cleanup of the throwaway session; the turn result is the
        // answer either way.
        let _ = client.detach_session(&session_id);
        let _ = client.archive_session(&session_id);
        outcome
    })
    .await
}

// ---------------------------------------------------------------------------
// Streaming turns
// ---------------------------------------------------------------------------

/// Everything needed to start one user turn.
#[derive(Debug, Clone)]
pub struct TurnPlan {
    /// Existing runtime session, or `None` to create one for this thread.
    pub session_id: Option<String>,
    pub working_dir: String,
    /// `true` when this deployment inherits the runtime's own tool defaults.
    pub expose_tools: bool,
    /// Provider-qualified model, e.g. `openai:gpt-5`.
    pub model: Option<String>,
    pub prompt: String,
    pub images: Vec<(String, String)>,
    /// Tool results answered by the client for the previous assistant turn.
    pub tool_results: Vec<(String, String)>,
    pub system_reminder: Option<String>,
}

/// A message from the runtime turn worker.
#[derive(Debug)]
pub enum TurnUpdate {
    Event(ApiEvent),
    Error(String),
    Done(Option<TurnUsage>),
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct TurnUsage {
    #[serde(rename = "promptTokens")]
    pub prompt_tokens: u64,
    #[serde(rename = "completionTokens")]
    pub completion_tokens: u64,
    #[serde(rename = "totalTokens")]
    pub total_tokens: u64,
}

/// Handles for a running turn.
pub struct TurnStart {
    /// Resolves once the session is known, so the caller can persist the thread
    /// mapping before any content arrives. `Err` means the turn never started.
    pub session: oneshot::Receiver<Result<SessionHandle, String>>,
    pub updates: mpsc::UnboundedReceiver<TurnUpdate>,
}

/// Start a turn. The session is created or attached on the same connection that
/// streams the turn, exactly as the protocol requires.
pub async fn start_turn(state: AppState, plan: TurnPlan) -> Result<TurnStart, ApiError> {
    ensure_bridge(&state).await?;
    let (session_tx, session_rx) = oneshot::channel();
    let (updates_tx, updates_rx) = mpsc::unbounded_channel();
    tokio::task::spawn_blocking(move || {
        run_turn_worker(state, plan, session_tx, updates_tx);
    });
    Ok(TurnStart {
        session: session_rx,
        updates: updates_rx,
    })
}

fn run_turn_worker(
    state: AppState,
    plan: TurnPlan,
    session_tx: oneshot::Sender<Result<SessionHandle, String>>,
    updates_tx: mpsc::UnboundedSender<TurnUpdate>,
) {
    let mut session_tx = Some(session_tx);
    let require_tools = !plan.expose_tools;
    let prepare = |state: &AppState| -> Result<(AmiroClient, SessionHandle), String> {
        let client = connect_client(state, require_tools).map_err(|error| error.1)?;
        let handle = match plan.session_id.as_deref() {
            Some(session_id) => {
                let info = client.attach_session(session_id).map_err(|error| error.to_string())?;
                session_handle(state, info, false, "").map_err(|error| error.1)?
            }
            None => {
                let info = client
                    .create_session_with_options(CreateSessionOptions {
                        working_dir: Some(plan.working_dir.clone()),
                        system_prompt: None,
                    })
                    .map_err(|error| error.to_string())?;
                session_handle(state, info, true, &plan.working_dir).map_err(|error| error.1)?
            }
        };
        Ok((client, handle))
    };

    // A runtime that died while idle is restarted once before the turn is
    // reported as failed. Nothing has been sent to the model at this point, so
    // a retry cannot duplicate the user's message.
    let prepared = prepare(&state).or_else(|first| {
        if runtime_healthy(&state) {
            return Err(first);
        }
        restart_bridge_blocking(&state).map_err(|error| error.1)?;
        prepare(&state)
    });

    let (client, handle) = match prepared {
        Ok(prepared) => prepared,
        Err(message) => {
            if let Some(tx) = session_tx.take() {
                let _ = tx.send(Err(message.clone()));
            }
            let _ = updates_tx.send(TurnUpdate::Error(message));
            let _ = updates_tx.send(TurnUpdate::Done(None));
            return;
        }
    };
    if let Some(tx) = session_tx.take() {
        if tx.send(Ok(handle.clone())).is_err() {
            let _ = client.detach_session(&handle.session_id);
            if handle.created {
                let _ = client.archive_session(&handle.session_id);
            }
            return;
        }
    }
    let session_id = handle.session_id.clone();

    let result = drive_turn(&client, &plan, &session_id, &updates_tx);
    match result {
        Ok(usage) => {
            let _ = updates_tx.send(TurnUpdate::Done(usage));
        }
        Err(message) => {
            let _ = updates_tx.send(TurnUpdate::Error(message));
            let _ = updates_tx.send(TurnUpdate::Done(None));
        }
    }
    let _ = client.detach_session(&session_id);
}

fn drive_turn(
    client: &AmiroClient,
    plan: &TurnPlan,
    session_id: &str,
    updates_tx: &mpsc::UnboundedSender<TurnUpdate>,
) -> Result<Option<TurnUsage>, String> {
    if !plan.expose_tools {
        client
            .configure_tools(session_id, no_tools())
            .map_err(|error| error.to_string())?;
    }
    if let Some(model) = plan.model.as_deref().filter(|model| !model.is_empty()) {
        client
            .set_model(session_id, model)
            .map_err(|error| error.to_string())?;
    }

    let sender = updates_tx.clone();
    let forward = move |event: &ApiEvent| {
        let _ = sender.send(TurnUpdate::Event(event.clone()));
    };

    if !plan.tool_results.is_empty() {
        for (call_id, output) in &plan.tool_results {
            client
                .submit_tool_result(session_id, call_id, output, None)
                .map_err(|error| error.to_string())?;
        }
        return consume_events(client, session_id, &forward);
    }

    let options = RunOptions {
        images: plan.images.clone(),
        on_event: Some(Box::new(forward)),
        auto_approve: plan.expose_tools,
    };
    let turn = if let Some(reminder) = plan
        .system_reminder
        .as_deref()
        .map(str::trim)
        .filter(|reminder| !reminder.is_empty())
    {
        run_with_reminder(client, session_id, plan, reminder, options)?
    } else {
        client
            .run(session_id, &plan.prompt, options)
            .map_err(|error| error.to_string())?
    };
    Ok(turn.usage.map(usage_of))
}

/// `AmiroClient::run` has no reminder parameter, so the reminder is attached to
/// the message frame directly and the turn is then collected from the stream.
fn run_with_reminder(
    client: &AmiroClient,
    session_id: &str,
    plan: &TurnPlan,
    reminder: &str,
    options: RunOptions,
) -> Result<amiro_sdk::TurnResult, String> {
    let stream = client.events(Some(session_id));
    client
        .send_message_with_reminder(
            session_id,
            &plan.prompt,
            plan.images.clone(),
            Some(reminder),
            Some(Duration::from_secs(30)),
        )
        .map_err(|error| error.to_string())?;
    let _ = stream;
    // The reminder path cannot reuse `run`'s collector, so collect the streamed
    // result here with the same terminal conditions.
    let mut result = amiro_sdk::TurnResult::default();
    let deadline = std::time::Instant::now() + TURN_TIMEOUT;
    while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
        let Some(event) = events_next(client, session_id, &stream, remaining) else {
            return Err("Amiro runtime closed before the turn finished".to_string());
        };
        if let Some(on_event) = &options.on_event {
            on_event(&event);
        }
        match event {
            ApiEvent::TextDelta { text, .. } => result.text.push_str(&text),
            ApiEvent::TurnStopped { reason, message, .. } => {
                result.stop_reason = Some(reason);
                result.stop_message = Some(message);
            }
            ApiEvent::TurnDone { .. } => {
                result.final_text = result.text.clone();
                return Ok(result);
            }
            ApiEvent::Error { code, message } => {
                return Err(format!("{code:?}: {message}"));
            }
            _ => {}
        }
    }
    Err("Amiro runtime turn timed out".to_string())
}

/// Blocking next-event wait that never exceeds the turn deadline.
fn events_next(
    client: &AmiroClient,
    session_id: &str,
    stream: &amiro_sdk::EventStream,
    remaining: Duration,
) -> Option<ApiEvent> {
    loop {
        let wait = remaining.min(Duration::from_secs(30));
        match stream.next_timeout(wait) {
            Some(event) => {
                if let Some(other) = event_session(&event) {
                    if other != session_id {
                        continue;
                    }
                }
                return Some(event);
            }
            None => {
                if client.is_closed() {
                    return None;
                }
                return None;
            }
        }
    }
}

fn event_session(event: &ApiEvent) -> Option<&str> {
    match event {
        ApiEvent::TextDelta { session_id, .. }
        | ApiEvent::TextDone { session_id, .. }
        | ApiEvent::TextReplace { session_id, .. }
        | ApiEvent::ReasoningDelta { session_id, .. }
        | ApiEvent::ReasoningDone { session_id, .. }
        | ApiEvent::ToolStart { session_id, .. }
        | ApiEvent::ToolInputDelta { session_id, .. }
        | ApiEvent::ToolDone { session_id, .. }
        | ApiEvent::ToolCall { session_id, .. }
        | ApiEvent::ToolExec { session_id, .. }
        | ApiEvent::TurnStopped { session_id, .. }
        | ApiEvent::TurnDone { session_id, .. }
        | ApiEvent::MessageAccepted { session_id }
        | ApiEvent::SessionStatus { session_id, .. } => Some(session_id),
        _ => None,
    }
}

fn consume_events(
    client: &AmiroClient,
    session_id: &str,
    forward: &impl Fn(&ApiEvent),
) -> Result<Option<TurnUsage>, String> {
    let stream = client.events(Some(session_id));
    let mut usage = None;
    let deadline = std::time::Instant::now() + TURN_TIMEOUT;
    while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
        let Some(event) = events_next(client, session_id, &stream, remaining) else {
            return Err("Amiro runtime closed before the turn finished".to_string());
        };
        match &event {
            ApiEvent::TokenUsage {
                input,
                output,
                cache_read_input,
                ..
            } => {
                let read = cache_read_input.unwrap_or(0);
                usage = Some(TurnUsage {
                    prompt_tokens: *input + read,
                    completion_tokens: *output,
                    total_tokens: *input + read + *output,
                });
            }
            ApiEvent::TurnDone { .. } => {
                forward(&event);
                return Ok(usage);
            }
            ApiEvent::Error { code, message } => {
                forward(&event);
                return Err(format!("{code:?}: {message}"));
            }
            _ => {}
        }
        forward(&event);
    }
    Err("Amiro runtime turn timed out".to_string())
}

fn usage_of(usage: amiro_sdk::Usage) -> TurnUsage {
    let read = usage.cache_read_input.unwrap_or(0);
    TurnUsage {
        prompt_tokens: usage.input + read,
        completion_tokens: usage.output,
        total_tokens: usage.input + read + usage.output,
    }
}

/// Cancel an in-flight turn for a session. Used when the browser disconnects.
pub fn cancel_session(state: AppState, session_id: String) {
    std::thread::spawn(move || {
        if let Ok(client) = connect_client(&state, false) {
            let _ = client.attach_session(&session_id);
            let _ = client.cancel(&session_id);
        }
    });
}

/// Best-effort cancel that also drops the session's attachment.
pub fn cancel_and_detach(state: AppState, session_id: String) {
    std::thread::spawn(move || {
        if let Ok(client) = connect_client(&state, false) {
            let _ = client.attach_session(&session_id);
            let _ = client.cancel(&session_id);
            let _ = client.detach_session(&session_id);
        }
    });
}

/// Model route string the runtime expects: `<provider>:<model>`, with the
/// legacy `openai-compatible:` prefix stripped exactly as the adapter did.
pub fn resolve_model(provider: &str, model: &str) -> Option<String> {
    let model = model.trim().trim_start_matches("openai-compatible:");
    if model.is_empty() {
        return None;
    }
    let provider = provider.trim().trim_start_matches("openai-compatible:");
    if provider.is_empty() || model.contains(':') {
        return Some(model.to_string());
    }
    Some(format!("{provider}:{model}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_routes_are_provider_qualified_without_legacy_prefix() {
        assert_eq!(
            resolve_model("openai-compatible:opencode-go", "deepseek-v4.1-flash").as_deref(),
            Some("opencode-go:deepseek-v4.1-flash")
        );
        assert_eq!(resolve_model("", "gpt-5").as_deref(), Some("gpt-5"));
        assert_eq!(
            resolve_model("claude", "claude-opus-4-6[1m]").as_deref(),
            Some("claude:claude-opus-4-6[1m]")
        );
        assert_eq!(resolve_model("claude", "   ").as_deref(), None);
    }

    #[test]
    fn no_tools_profile_is_explicitly_empty() {
        let tools = no_tools();
        assert_eq!(tools.enabled, Some(Vec::new()));
    }

    #[test]
    fn runtime_env_strips_host_legacy_provider_vars() {
        let root = std::env::temp_dir().join(format!("amiro-env-{}", uuid::Uuid::new_v4()));
        let state = AppState {
            home: root.join("home"),
            workspace: root.join("workspace"),
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("run/amiro-api.sock"),
            runtime_bin: root.join("amiro-runtime"),
            token: "test-token".to_string(),
            store: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        };
        let env = runtime_env(&state);
        for key in env.keys() {
            let name = key.to_string_lossy();
            assert!(!name.starts_with("JCODE_"), "legacy var leaked: {name}");
            assert!(!name.starts_with("META_MUSE_"), "host provider var leaked: {name}");
            assert!(!name.starts_with("OPENROUTER_"), "host provider var leaked: {name}");
            assert!(!name.starts_with("OPENAI_COMPAT_"), "host provider var leaked: {name}");
        }
        assert!(env.contains_key(std::ffi::OsStr::new("AMIRO_HOME")));
        assert!(env.contains_key(std::ffi::OsStr::new("AMIRO_API_SOCKET")));
    }
}
