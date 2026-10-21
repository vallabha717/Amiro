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
    AmiroClient, ApiEvent, ConnectOptions, CreateSessionOptions, RunOptions, RuntimeCommand,
    ToolConfiguration,
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
    // The owner's agent home is the workspace root; the runtime loads
    // IDENTITY/SOUL/USER/NOW/BOOTSTRAP.md from here into every turn.
    let _ = std::fs::create_dir_all(&state.workspace);
    let agent_home =
        std::fs::canonicalize(&state.workspace).unwrap_or_else(|_| state.workspace.clone());
    env.insert(
        "AMIRO_AGENT_HOME".into(),
        OsString::from(agent_home.to_string_lossy().to_string()),
    );
    // Team agents: a session working inside this folder loads that agent's
    // persona files instead of the owner's (runtime `agent_home.rs`).
    let agents_root = crate::routes::agents::agents_root(state);
    let _ = std::fs::create_dir_all(&agents_root);
    env.insert(
        "AMIRO_AGENTS_ROOT".into(),
        OsString::from(agents_root.to_string_lossy().to_string()),
    );
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
    // The runtime expands `${COMPOSIO_API_KEY}` in MCP headers, so the mcp.json
    // written by the Composio sync never has to carry the plaintext key. Supply
    // the resolved key (encrypted store > env > toml) to every runtime child.
    if let Some(key) = crate::composio_config::resolve_key_sync(&state.home) {
        env.insert("COMPOSIO_API_KEY".into(), OsString::from(key));
    }
    // Every stored credential is also exported as `AMIRO_CRED_<SERVICE>_<FIELD>`
    // (plus well-known aliases such as `GITHUB_TOKEN`). The model can then
    // reference `${AMIRO_CRED_...}` in bash commands, `mcp.json` headers, or a
    // custom search provider's `header_env` without the raw value ever reaching
    // its prompt or transcript.
    for (name, value) in crate::credentials::runtime_env_vars_sync(&state.home) {
        env.insert(OsString::from(name), OsString::from(value));
    }
    // Token for the built-in `amiro` MCP server (mcp.json carries only the
    // `${AMIRO_AGENT_MCP_TOKEN}` placeholder).
    if let Some(token) = crate::agent_mcp::read_token_sync(&state.home) {
        env.insert(
            crate::agent_mcp::TOKEN_ENV_VAR.into(),
            OsString::from(token),
        );
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
    #[cfg(windows)]
    {
        // The runtime listens on a named pipe derived from the socket path
        // (amiro-transport's `path_to_pipe_name`). Opening it succeeds, or
        // reports ERROR_PIPE_BUSY (231), when a server is up.
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(windows_pipe_name(path))
        {
            Ok(_) => true,
            Err(error) => error.raw_os_error() == Some(231),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        false
    }
}

/// Mirrors `amiro_transport::windows::path_to_pipe_name`.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_pipe_name(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let stem: String = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("jcode")
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(32)
        .collect();
    let stem = if stem.is_empty() { "jcode" } else { &stem };
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let hash = hex::encode(Sha256::digest(normalized.as_bytes()));
    format!(r"\\.\pipe\{}-{}", stem, &hash[..16])
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
    remember_bridge_child(&state.runtime_socket, child);
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

/// Bridges this backend started, keyed by socket: the main runtime and one
/// per team agent that has been used (`AppState::for_agent`).
type BridgeChildren = std::collections::HashMap<PathBuf, std::process::Child>;

static BRIDGE_CHILD: std::sync::OnceLock<std::sync::Mutex<BridgeChildren>> =
    std::sync::OnceLock::new();

fn bridge_child_slot() -> &'static std::sync::Mutex<BridgeChildren> {
    BRIDGE_CHILD.get_or_init(|| std::sync::Mutex::new(BridgeChildren::new()))
}

fn remember_bridge_child(socket: &Path, child: std::process::Child) {
    if let Ok(mut slot) = bridge_child_slot().lock() {
        slot.insert(socket.to_path_buf(), child);
    }
}

fn owns_bridge(socket: &Path) -> bool {
    bridge_child_slot()
        .lock()
        .map(|slot| slot.contains_key(socket))
        .unwrap_or(false)
}

/// Stop the bridge this backend started on `socket`. A bridge that another
/// supervisor owns (the desktop sidecar) is left alone.
fn stop_spawned_bridge(socket: &Path) {
    let Ok(mut slot) = bridge_child_slot().lock() else {
        return;
    };
    if let Some(mut child) = slot.remove(socket) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Whether `state`'s runtime is accepting connections right now (without
/// starting one).
pub fn socket_ready_for(state: &AppState) -> bool {
    socket_ready(&state.runtime_socket)
}

/// Stop a runtime this backend started for `state` (a deleted team agent's)
/// and clear its socket.
pub fn stop_runtime(state: &AppState) {
    stop_spawned_bridge(&state.runtime_socket);
    remove_stale_socket(&state.runtime_socket);
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
    remember_bridge_child(&state.runtime_socket, child);
    let deadline = std::time::Instant::now() + BRIDGE_STARTUP_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if socket_ready(&state.runtime_socket) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    stop_spawned_bridge(&state.runtime_socket);
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
    stop_spawned_bridge(&state.runtime_socket);
    remove_stale_socket(&state.runtime_socket);
    ensure_bridge_blocking(state)
}

/// Restart the backend-owned runtime bridge so a changed environment (for
/// example a new `COMPOSIO_API_KEY`) is inherited by a fresh runtime process.
/// Returns `true` when a restart was applied. A no-op when this backend did not
/// start the runtime: an externally supervised runtime owns its own environment,
/// which is documented in the credential-store report.
pub fn restart_for_env_change(state: &AppState) -> bool {
    if !owns_bridge(&state.runtime_socket) {
        return false;
    }
    restart_bridge_blocking(state).is_ok()
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

/// One runtime CLI read: the parsed JSON, plus whatever the CLI wrote to
/// stderr.
///
/// The runtime reports a *failed dynamic catalog refresh* on stderr while still
/// exiting 0 (it answers from its static fallback), so a caller that needs to
/// tell a live catalog from a stub has to read both streams.
pub struct CliRead {
    pub json: Value,
    pub stderr: String,
}

pub async fn exec_json(state: &AppState, args: &[&str]) -> Result<Value, ApiError> {
    Ok(exec_json_with_diagnostics(state, args).await?.json)
}

/// [`exec_json`] keeping the CLI's stderr for callers that care about its
/// warnings (see [`CliRead`]).
pub async fn exec_json_with_diagnostics(
    state: &AppState,
    args: &[&str],
) -> Result<CliRead, ApiError> {
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
            format!("runtime {:?} failed: {}", args, stderr.trim().to_string()),
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("runtime {:?} produced no output", args),
        ));
    }
    let json = serde_json::from_str(&text).map_err(|error| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("invalid json from runtime {:?}: {error}", args),
        )
    })?;
    Ok(CliRead {
        json,
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

pub async fn auth_status(state: &AppState) -> Result<Value, ApiError> {
    exec_json(state, &["auth", "status", "--json"]).await
}

pub async fn model_list(state: &AppState, provider: &str) -> Result<Value, ApiError> {
    exec_json(state, &["model", "list", "-p", provider, "--json"]).await
}

/// A provider's model list read together with the CLI's warnings, so callers
/// can see whether the runtime had to fall back to its static catalog.
pub async fn model_list_with_diagnostics(
    state: &AppState,
    provider: &str,
) -> Result<CliRead, ApiError> {
    exec_json_with_diagnostics(state, &["model", "list", "-p", provider, "--json"]).await
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
pub async fn attach_session(state: &AppState, session_id: &str) -> Result<SessionHandle, ApiError> {
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

/// Result of asking every idle runtime session to reload its MCP config.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct McpReloadOutcome {
    /// Sessions that acknowledged a successful reload.
    pub reloaded_sessions: usize,
    /// Sessions that were mid-turn and were deliberately left alone.
    pub skipped_busy: usize,
}

impl McpReloadOutcome {
    /// Whether at least one session actually reloaded.
    pub fn reloaded(&self) -> bool {
        self.reloaded_sessions > 0
    }
}

/// A session status string that means the daemon is mid-turn and must not be
/// interrupted by an MCP reload.
fn session_is_busy(status: &str) -> bool {
    matches!(status, "running" | "processing" | "busy" | "generating")
}

/// True when any runtime session is mid-turn (used to keep background turns
/// such as the heartbeat out of the owner's way). A missing runtime is not busy.
pub async fn any_session_busy(state: &AppState) -> bool {
    if !socket_ready(&state.runtime_socket) {
        return false;
    }
    let state = state.clone();
    blocking("any_session_busy", move || {
        let client = connect_client(&state, false)?;
        let sessions = client.list_sessions().map_err(runtime_error)?;
        Ok(sessions
            .iter()
            .any(|session| session_is_busy(&session.status)))
    })
    .await
    .unwrap_or(false)
}

/// Ask every idle runtime session to reload MCP config through the supported
/// `McpReload` runtime command (no debug socket, no model turn).
///
/// Busy sessions are skipped: the daemon rejects a reload mid-turn, so there is
/// nothing to wait for and the config change is already durable. A missing
/// runtime or bridge is a no-op, never an error.
pub async fn reload_mcp_idle_sessions(state: &AppState) -> McpReloadOutcome {
    if !socket_ready(&state.runtime_socket) {
        return McpReloadOutcome::default();
    }
    let state = state.clone();
    blocking("reload_mcp", move || Ok(reload_mcp_blocking(&state)))
        .await
        .unwrap_or_default()
}

fn reload_mcp_blocking(state: &AppState) -> McpReloadOutcome {
    let mut outcome = McpReloadOutcome::default();
    let Ok(client) = connect_client(state, false) else {
        return outcome;
    };
    let Ok(sessions) = client.list_sessions() else {
        return outcome;
    };
    for session in sessions {
        if session_is_busy(&session.status) {
            outcome.skipped_busy += 1;
            continue;
        }
        match client.runtime_command(&session.session_id, RuntimeCommand::McpReload, Vec::new()) {
            Ok(_) => outcome.reloaded_sessions += 1,
            Err(error) => {
                // A session can become busy between listing and reloading; the
                // daemon reports it as an error rather than a result.
                if error.to_string().to_ascii_lowercase().contains("busy") {
                    outcome.skipped_busy += 1;
                }
            }
        }
    }
    outcome
}

/// Live MCP server status (`{"servers":[{name,transport,enabled,connected,
/// error,tools}]}`) from the runtime's `McpStatus` command, answered by the
/// most recently active idle session. `None` when no session can answer (no
/// runtime, all sessions busy, or the runtime predates `McpStatus`).
///
pub async fn mcp_status(state: &AppState) -> Option<Value> {
    let command = RuntimeCommand::McpStatus;
    if !socket_ready(&state.runtime_socket) {
        return None;
    }
    let state = state.clone();
    blocking("mcp_status", move || {
        Ok(mcp_status_blocking(&state, command))
    })
    .await
    .ok()
    .flatten()
}

fn mcp_status_blocking(state: &AppState, command: RuntimeCommand) -> Option<Value> {
    let client = connect_client(state, false).ok()?;
    let mut sessions = client.list_sessions().ok()?;
    sessions.sort_by_key(|session| {
        std::cmp::Reverse(
            session
                .last_active_at_ms
                .or(session.updated_at_ms)
                .unwrap_or(0),
        )
    });
    for session in sessions
        .iter()
        .filter(|session| !session.archived && !session_is_busy(&session.status))
    {
        if client.attach_session(&session.session_id).is_err() {
            continue;
        }
        match client.runtime_command(&session.session_id, command, Vec::new()) {
            Ok(output) => return Some(output.data),
            // Busy (or otherwise unable): try the next session.
            Err(_) => continue,
        }
    }
    None
}

/// The session's real context window and how much of it is in use, as the
/// runtime itself sees them (the same figures its compaction decisions use).
///
/// `context_window` comes from the active provider's model metadata, never a
/// guess from the model name. Occupancy is the *last* provider call's input,
/// which is what the next call will carry; summing a turn's calls would count
/// the same history once per step. Providers disagree on cache accounting:
/// Anthropic reports cache reads and writes beside `input_tokens`, OpenAI-style
/// APIs already include them, so they are only added for the former.
pub async fn context_snapshot(state: &AppState, session_id: &str) -> Option<Value> {
    ensure_bridge(state).await.ok()?;
    let state = state.clone();
    let session_id = session_id.to_string();
    blocking("context_snapshot", move || {
        let client = connect_client(&state, false)?;
        // Runtime commands answer for a session this client is attached to;
        // attaching reads state, it does not start a turn.
        client.attach_session(&session_id).map_err(runtime_error)?;
        let out = client
            .runtime_command(&session_id, RuntimeCommand::Info, Vec::new())
            .map_err(runtime_error)?;
        let data = &out.data;
        let window = data
            .get("context_window")
            .and_then(Value::as_u64)
            .filter(|w| *w > 0);
        let usage = data.get("last_usage");
        let field = |name: &str| {
            usage
                .and_then(|u| u.get(name))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        let provider = data
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let anthropic_style = provider.contains("anthropic") || provider.contains("claude");
        let tokens = field("input_tokens")
            + if anthropic_style {
                field("cache_read_input_tokens") + field("cache_creation_input_tokens")
            } else {
                0
            };
        Ok(serde_json::json!({
            "contextWindow": window,
            "contextTokens": if tokens > 0 { Some(tokens) } else { None },
            "provider": data.get("provider"),
            "model": data.get("model"),
        }))
    })
    .await
    .ok()
}

/// Tool configuration that exposes no tools. Retained for the internal
/// non-tool helper turns (thread-title generation) and for the explicit
/// `AMIRO_TOOL_PROFILE=none` opt-out, never applied to a normal owner turn by
/// default.
pub fn no_tools() -> ToolConfiguration {
    ToolConfiguration {
        enabled: Some(Vec::new()),
        disabled: Vec::new(),
        custom: Vec::new(),
    }
}

/// Whether a session runs with the runtime's own tool defaults.
///
/// Amiro is a single-owner app that is meant to run inside a VM or sandbox:
/// the sandbox, not a flag, is the boundary. Tools are therefore on by default
/// and run with the owner's own permissions. `AMIRO_TOOL_PROFILE=none` is the
/// one supported opt-out for people who want chat without tools.
pub fn expose_tools() -> bool {
    !matches!(std::env::var("AMIRO_TOOL_PROFILE").as_deref(), Ok("none"))
}

/// Runtime history for a session, as the frontend message shape's source rows.
pub async fn session_titles(
    state: &AppState,
) -> Result<std::collections::HashMap<String, String>, ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    blocking("session_titles", move || {
        let client = connect_client(&state, false)?;
        Ok(client
            .list_sessions()
            .map_err(runtime_error)?
            .into_iter()
            .filter_map(|session| session.title.map(|title| (session.session_id, title)))
            .collect())
    })
    .await
}

/// Every runtime session as the harness API reports it (snake_case
/// `SessionInfo` rows). The swarm routes read `parent_session_id`,
/// `agent_label` and `swarm_status` from these to rebuild a thread's swarm.
pub async fn list_sessions(state: &AppState) -> Result<Vec<Value>, ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    blocking("list_sessions", move || {
        let client = connect_client(&state, false)?;
        Ok(client
            .list_sessions()
            .map_err(runtime_error)?
            .into_iter()
            .map(|session| serde_json::to_value(session).unwrap_or(Value::Null))
            .collect())
    })
    .await
}

/// Read the runtime's effective title, which already honors explicit renames.
/// Attaching reads session metadata, it does not submit an inference turn.
pub async fn session_title(state: &AppState, session_id: &str) -> Result<Option<String>, ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let session_id = session_id.to_string();
    blocking("session_title", move || {
        let client = connect_client(&state, false)?;
        Ok(client
            .attach_session(&session_id)
            .map_err(runtime_error)?
            .title)
    })
    .await
}

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

/// Name of the custom tool the model test offers, so tool calling can be
/// checked without running any real tool.
pub const PROBE_TOOL: &str = "amiro_probe_echo";

/// What one model-test round trip observed.
#[derive(Debug, Clone, Default)]
pub struct ModelProbe {
    pub text: String,
    pub usage: Option<TurnUsage>,
    /// `(name, arguments)` of the probe tool call, when the model made one.
    pub tool_call: Option<(String, String)>,
}

/// One live round trip against `model` in a throwaway session whose only tool
/// is [`PROBE_TOOL`]. The tool is answered here, so nothing runs on the host.
pub async fn probe_model(
    state: &AppState,
    working_dir: &str,
    model: &str,
) -> Result<ModelProbe, ApiError> {
    ensure_bridge(state).await?;
    let state = state.clone();
    let (working_dir, model) = (working_dir.to_string(), model.to_string());
    blocking("probe_model", move || {
        let client = connect_client(&state, true)?;
        let session = client
            .create_session_with_options(CreateSessionOptions {
                working_dir: Some(working_dir),
                system_prompt: None,
            })
            .map_err(runtime_error)?;
        let session_id = session.session_id.clone();
        let outcome = (|| -> Result<ModelProbe, ApiError> {
            let mut parameters = serde_json::Map::new();
            parameters.insert("type".into(), Value::String("object".into()));
            parameters.insert(
                "properties".into(),
                serde_json::json!({"text": {"type": "string", "description": "Text to echo back."}}),
            );
            parameters.insert("required".into(), serde_json::json!(["text"]));
            client
                .configure_tools(
                    &session_id,
                    ToolConfiguration {
                        enabled: Some(Vec::new()),
                        disabled: Vec::new(),
                        custom: vec![amiro_sdk::SessionToolDefinition {
                            name: PROBE_TOOL.to_string(),
                            description: "Echoes the given text back. Used to check tool calling."
                                .to_string(),
                            parameters,
                        }],
                    },
                )
                .map_err(runtime_error)?;
            client.set_model(&session_id, &model).map_err(runtime_error)?;

            let seen = std::sync::Arc::new(std::sync::Mutex::new(None::<(String, String)>));
            let (seen_cb, responder, sid) = (seen.clone(), client.clone(), session_id.clone());
            let on_event = move |event: &ApiEvent| {
                if let ApiEvent::ToolCall {
                    call_id, name, input, ..
                } = event
                {
                    *seen_cb.lock().unwrap() = Some((name.clone(), input.to_string()));
                    let output = input
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("ok")
                        .to_string();
                    let (responder, sid, call_id) = (responder.clone(), sid.clone(), call_id.clone());
                    // Answered off the event loop so the turn can keep streaming.
                    std::thread::spawn(move || {
                        let _ = responder.submit_tool_result(&sid, &call_id, &output, None);
                    });
                }
            };
            let prompt = format!(
                "This is a connection test. First call the `{PROBE_TOOL}` tool once with text \"pong\". \
                 After it returns, reply with one short sentence confirming you can hear me."
            );
            let turn = client
                .run(
                    &session_id,
                    &prompt,
                    RunOptions {
                        images: Vec::new(),
                        on_event: Some(Box::new(on_event)),
                        auto_approve: false,
                    },
                )
                .map_err(runtime_error)?;
            let tool_call = seen.lock().unwrap().clone();
            let text = if turn.final_text.trim().is_empty() {
                turn.text
            } else {
                turn.final_text
            };
            Ok(ModelProbe {
                text: text.trim().to_string(),
                usage: turn.usage.map(usage_of),
                tool_call,
            })
        })();
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
    /// A team agent's container-backed tools. `Some` replaces every built-in
    /// and MCP tool with only these (possibly none).
    pub agent_tools: Option<crate::sandbox::AgentToolset>,
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
                let info = client
                    .attach_session(session_id)
                    .map_err(|error| error.to_string())?;
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
    let session_dir = handle.working_dir.clone().unwrap_or_else(|| plan.working_dir.clone());
    let in_team_folder = in_agents_root(&state, &session_dir) || in_agents_root(&state, &plan.working_dir);

    let result = drive_turn(&client, &plan, &session_id, in_team_folder, &updates_tx);
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

/// Whether `dir` is a team agent's folder (inside `AMIRO_AGENTS_ROOT`).
fn in_agents_root(state: &AppState, dir: &str) -> bool {
    !dir.is_empty() && std::path::Path::new(dir).starts_with(crate::routes::agents::agents_root(state))
}

/// The tool configuration a turn applies, or `None` for the runtime's own
/// defaults. A team agent's folder never gets the defaults: with no toolset
/// (a caller that did not build one) it gets no tools at all.
pub fn turn_tool_configuration(plan: &TurnPlan, in_team_folder: bool) -> Option<ToolConfiguration> {
    match &plan.agent_tools {
        Some(toolset) => Some(ToolConfiguration {
            enabled: Some(Vec::new()),
            disabled: Vec::new(),
            custom: toolset.definitions.clone(),
        }),
        None if in_team_folder || !plan.expose_tools => Some(no_tools()),
        None => None,
    }
}

fn drive_turn(
    client: &AmiroClient,
    plan: &TurnPlan,
    session_id: &str,
    in_team_folder: bool,
    updates_tx: &mpsc::UnboundedSender<TurnUpdate>,
) -> Result<Option<TurnUsage>, String> {
    if let Some(tools) = turn_tool_configuration(plan, in_team_folder) {
        let custom = tools.custom.clone();
        client
            .configure_tools(session_id, tools)
            .map_err(|error| error.to_string())?;
        // A team agent with its own remote connectors also gets their MCP
        // tools, enabled by exact name. Listing needs the MCP surface
        // briefly on (no turn is running); any failure keeps it off.
        if let Some(toolset) = plan.agent_tools.as_ref().filter(|t| !t.mcp_servers.is_empty()) {
            let probe = ToolConfiguration { enabled: Some(vec!["mcp".into()]), disabled: Vec::new(), custom: custom.clone() };
            let listed = client
                .configure_tools(session_id, probe)
                .and_then(|()| client.list_tools(session_id))
                .map(|tools| tools.into_iter().map(|t| t.name).collect::<Vec<_>>())
                .unwrap_or_default();
            let enabled = crate::sandbox::mcp_enabled_tools(&listed, &toolset.mcp_servers);
            client
                .configure_tools(session_id, ToolConfiguration { enabled: Some(enabled), disabled: Vec::new(), custom })
                .map_err(|error| error.to_string())?;
        }
    }
    if let Some(model) = plan.model.as_deref().filter(|model| !model.is_empty()) {
        client
            .set_model(session_id, model)
            .map_err(|error| error.to_string())?;
    }

    let sender = updates_tx.clone();
    let toolset = plan.agent_tools.clone();
    let (responder, sid) = (client.clone(), session_id.to_string());
    let forward = move |event: &ApiEvent| {
        let _ = sender.send(TurnUpdate::Event(event.clone()));
        // A team agent's tool call runs in its container. Answered off the
        // event loop so the turn keeps streaming, exactly like `probe_model`.
        if let (Some(toolset), ApiEvent::ToolCall { call_id, name, input, .. }) = (&toolset, event) {
            if toolset.handles(name) {
                let (toolset, responder, sid) = (toolset.clone(), responder.clone(), sid.clone());
                let (call_id, name, input) = (call_id.clone(), name.clone(), input.clone());
                std::thread::spawn(move || {
                    let (output, error) = match toolset.run_blocking(&name, &input) {
                        Ok(output) => (output, None),
                        Err(error) => (String::new(), Some(error)),
                    };
                    let _ = responder.submit_tool_result(&sid, &call_id, &output, error);
                });
            }
        }
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
            return Err(stream_end_message(deadline));
        };
        if let Some(on_event) = &options.on_event {
            on_event(&event);
        }
        match event {
            ApiEvent::TextDelta { text, .. } => result.text.push_str(&text),
            ApiEvent::TurnStopped {
                reason, message, ..
            } => {
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
///
/// A quiet stream is not a closed one: a tool can legitimately run for longer
/// than one wait slice (an OAuth discovery, a slow MCP server), so silence only
/// ends the wait once the deadline passes. `None` means the connection closed
/// or the deadline was reached.
fn events_next(
    client: &AmiroClient,
    session_id: &str,
    stream: &amiro_sdk::EventStream,
    remaining: Duration,
) -> Option<ApiEvent> {
    let deadline = std::time::Instant::now() + remaining;
    loop {
        let left = deadline.checked_duration_since(std::time::Instant::now())?;
        let wait = left.min(Duration::from_secs(30));
        let started = std::time::Instant::now();
        match stream.next_timeout(wait) {
            Some(event) => {
                if let Some(other) = event_session(&event) {
                    if other != session_id {
                        continue;
                    }
                }
                return Some(event);
            }
            // An early `None` is a disconnected channel, not a timeout.
            None if client.is_closed() || started.elapsed() < wait => return None,
            None => continue,
        }
    }
}

/// Why [`events_next`] stopped yielding events, for the turn error.
fn stream_end_message(deadline: std::time::Instant) -> String {
    if std::time::Instant::now() >= deadline {
        "Amiro runtime turn timed out".to_string()
    } else {
        "Amiro runtime closed before the turn finished".to_string()
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
            return Err(stream_end_message(deadline));
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

    fn plan(expose_tools: bool) -> TurnPlan {
        TurnPlan {
            session_id: None,
            working_dir: String::new(),
            expose_tools,
            model: None,
            prompt: String::new(),
            images: Vec::new(),
            tool_results: Vec::new(),
            system_reminder: None,
            agent_tools: None,
        }
    }

    #[test]
    fn a_team_folder_never_gets_the_runtime_tools() {
        // Main workspace, tools exposed: the runtime's own defaults.
        assert!(turn_tool_configuration(&plan(true), false).is_none());
        // A team agent's folder without a toolset (a caller that forgot to
        // build one): nothing at all, not the defaults.
        let tools = turn_tool_configuration(&plan(true), true).expect("configured");
        assert_eq!(tools.enabled, Some(Vec::new()));
        assert!(tools.custom.is_empty());
        assert_eq!(turn_tool_configuration(&plan(false), false).unwrap().enabled, Some(Vec::new()));
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
            assert!(
                !name.starts_with("META_MUSE_"),
                "host provider var leaked: {name}"
            );
            assert!(
                !name.starts_with("OPENROUTER_"),
                "host provider var leaked: {name}"
            );
            assert!(
                !name.starts_with("OPENAI_COMPAT_"),
                "host provider var leaked: {name}"
            );
        }
        assert!(env.contains_key(std::ffi::OsStr::new("AMIRO_HOME")));
        assert!(env.contains_key(std::ffi::OsStr::new("AMIRO_AGENT_HOME")));
        assert!(env.contains_key(std::ffi::OsStr::new("AMIRO_API_SOCKET")));
    }

    #[test]
    fn only_mid_turn_statuses_are_busy_for_reload() {
        for busy in ["running", "processing", "busy", "generating"] {
            assert!(session_is_busy(busy), "{busy} should be skipped");
        }
        for idle in ["idle", "attached", "closed", "ready", ""] {
            assert!(!session_is_busy(idle), "{idle} should be reloaded");
        }
        assert!(!McpReloadOutcome::default().reloaded());
        assert!(McpReloadOutcome {
            reloaded_sessions: 1,
            skipped_busy: 3,
        }
        .reloaded());
    }
}
