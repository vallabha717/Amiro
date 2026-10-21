//! The supervisor's HTTP API (`/health`, `/v1/agents/{id}/…`).
//!
//! Every `/v1` route needs the supervisor token; every agent route also needs
//! that agent's derived credential. Callers name an agent and an action, never
//! an image, mount, user or Docker option.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::credential;
use crate::docker::{Docker, DockerError, ExecOutput};
use crate::paths::clean_relative;
use crate::spec::{container_spec, SandboxConfig, LABEL_SPEC};
use crate::{valid_agent_id, CREDENTIAL_HEADER};

/// Shell output returned to the agent.
pub const SHELL_OUTPUT_CAP: usize = 64 * 1024;
/// Longest shell command, in seconds. Below the runtime's 120 s tool callback
/// timeout so a slow command ends here with a message, not there.
pub const MAX_SHELL_SECS: u64 = 110;
pub const DEFAULT_SHELL_SECS: u64 = 60;
pub const READ_CAP: usize = 256 * 1024;
pub const WRITE_CAP: usize = 1024 * 1024;
pub const LIST_CAP: usize = 500;
/// Base64 characters per write exec; well under Linux's 128 KiB single-argument limit.
const WRITE_CHUNK_B64: usize = 96 * 1024;

pub struct Supervisor {
    pub cfg: SandboxConfig,
    pub docker: Docker,
    token: String,
    master: String,
    /// One lock per agent so concurrent ensures don't race on create.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Supervisor {
    pub fn new(cfg: SandboxConfig, docker: Docker, token: String, master: String) -> Result<Self, String> {
        if token.len() < credential::MIN_SECRET_LEN || master.len() < credential::MIN_SECRET_LEN {
            return Err(format!(
                "AMIRO_SANDBOX_TOKEN and AMIRO_SANDBOX_MASTER must each be at least {} characters",
                credential::MIN_SECRET_LEN
            ));
        }
        if credential::secrets_equal(&token, &master) {
            return Err("AMIRO_SANDBOX_TOKEN and AMIRO_SANDBOX_MASTER must differ".into());
        }
        Ok(Supervisor { cfg, docker, token, master, locks: Mutex::new(HashMap::new()) })
    }

    async fn lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        self.locks.lock().await.entry(id.to_string()).or_default().clone()
    }

    /// Create (if needed) and start the agent's container; returns its id.
    pub async fn ensure(&self, id: &str) -> Result<String, ApiError> {
        let lock = self.lock_for(id).await;
        let _guard = lock.lock().await;
        let name = self.cfg.container_name(id);
        let spec = container_spec(&self.cfg, id);
        let want = spec["Labels"][LABEL_SPEC].as_str().unwrap_or_default().to_string();
        if let Some(info) = self.docker.inspect(&name).await.map_err(docker_error)? {
            let cid = info["Id"].as_str().unwrap_or(&name).to_string();
            if info["Config"]["Labels"][LABEL_SPEC].as_str() == Some(want.as_str()) {
                if info["State"]["Running"].as_bool() != Some(true) {
                    self.docker.start(&cid).await.map_err(docker_error)?;
                }
                return Ok(cid);
            }
            // Settings changed since it was made: replace it. The folder is on
            // the host, so nothing the agent wrote is lost.
            self.docker.remove(&cid).await.map_err(docker_error)?;
        }
        let cid = self.docker.create(&name, &spec).await.map_err(|e| self.create_error(e))?;
        self.docker.start(&cid).await.map_err(docker_error)?;
        Ok(cid)
    }

    fn create_error(&self, error: DockerError) -> ApiError {
        let text = error.message.to_lowercase();
        if text.contains("no such image") {
            return ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("the agent image {} is not built; run scripts/sandbox.sh up", self.cfg.image),
            );
        }
        if text.contains("bind source path does not exist") {
            return ApiError(StatusCode::NOT_FOUND, "this agent's folder does not exist".into());
        }
        if text.contains("unknown or invalid runtime") {
            return ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("the container runtime {:?} is not installed", self.cfg.runtime.as_deref().unwrap_or("")),
            );
        }
        docker_error(error)
    }

    async fn exec(&self, id: &str, argv: Vec<String>, cap: usize, wait: Duration) -> Result<ExecOutput, ApiError> {
        let cid = self.ensure(id).await?;
        self.docker.exec(&cid, &argv, cap, wait).await.map_err(docker_error)
    }
}

/// An HTTP error with a message safe to show the owner.
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

fn docker_error(error: DockerError) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, error.message)
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

type Shared = Arc<Supervisor>;

/// Check the supervisor token, and for `id` the agent's credential.
fn authorize(sup: &Supervisor, headers: &HeaderMap, id: Option<&str>) -> Result<(), ApiError> {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !credential::secrets_equal(presented, &sup.token) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "supervisor token required".into()));
    }
    if let Some(id) = id {
        if !valid_agent_id(id) {
            return Err(bad("unknown agent id"));
        }
        let cred = headers.get(CREDENTIAL_HEADER).and_then(|v| v.to_str().ok()).unwrap_or("");
        if !credential::verify(&sup.master, id, cred) {
            return Err(ApiError(StatusCode::FORBIDDEN, "credential does not match this agent".into()));
        }
    }
    Ok(())
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| p.to_string()).collect()
}

async fn health(State(sup): State<Shared>) -> Json<Value> {
    Json(json!({"ok": true, "docker": sup.docker.ping().await}))
}

async fn ensure(State(sup): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, Some(&id))?;
    sup.ensure(&id).await?;
    Ok(Json(json!({"state": "running"})))
}

async fn stop(State(sup): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, Some(&id))?;
    let name = sup.cfg.container_name(&id);
    if sup.docker.inspect(&name).await.map_err(docker_error)?.is_some() {
        sup.docker.stop(&name).await.map_err(docker_error)?;
    }
    Ok(Json(json!({"state": "stopped"})))
}

async fn status(State(sup): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, Some(&id))?;
    let info = sup.docker.inspect(&sup.cfg.container_name(&id)).await.map_err(docker_error)?;
    let state = match &info {
        None => "missing",
        Some(info) if info["State"]["Running"].as_bool() == Some(true) => "running",
        Some(_) => "stopped",
    };
    Ok(Json(json!({
        "state": state,
        "image": sup.cfg.image,
        "network": sup.cfg.network,
        "runtime": sup.cfg.runtime.clone().unwrap_or_else(|| "runc".into()),
    })))
}

async fn exec(
    State(sup): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, Some(&id))?;
    let command = body["command"].as_str().unwrap_or("").trim();
    if command.is_empty() {
        return Err(bad("command is required"));
    }
    if command.len() > 16 * 1024 {
        return Err(bad("command is too long"));
    }
    let secs = body["timeoutSecs"].as_u64().unwrap_or(DEFAULT_SHELL_SECS).clamp(1, MAX_SHELL_SECS);
    // `timeout -s KILL` ends the process inside the container; the read
    // deadline below only stops waiting for it.
    let argv = vec![
        "timeout".into(), "-s".into(), "KILL".into(), secs.to_string(),
        "sh".into(), "-c".into(), command.to_string(),
    ];
    let out = sup.exec(&id, argv, SHELL_OUTPUT_CAP, Duration::from_secs(secs + 5)).await?;
    Ok(Json(json!({
        "exitCode": out.exit_code,
        "stdout": text(&out.stdout),
        "stderr": text(&out.stderr),
        "truncated": out.truncated,
        // 137 is `timeout -s KILL` (or the memory limit) ending the command.
        "timedOut": out.timed_out || out.exit_code == Some(137),
        "timeoutSecs": secs,
    })))
}

fn path_arg(body: &Value) -> Result<String, ApiError> {
    clean_relative(body["path"].as_str().unwrap_or("")).map_err(bad)
}

async fn read_file(
    State(sup): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, Some(&id))?;
    let path = path_arg(&body)?;
    if path.is_empty() {
        return Err(bad("path is required"));
    }
    let script = r#"if [ -d "$1" ]; then echo "$1 is a folder" >&2; exit 21; fi; exec head -c "$2" -- "$1""#;
    let argv = args(&["sh", "-c", script, "sh", &path, &(READ_CAP + 1).to_string()]);
    let out = sup.exec(&id, argv, READ_CAP + 1 + 4096, Duration::from_secs(20)).await?;
    if out.exit_code != Some(0) {
        let reason = text(&out.stderr).trim().to_string();
        return Err(ApiError(StatusCode::NOT_FOUND, if reason.is_empty() { "file not found".into() } else { reason }));
    }
    let truncated = out.stdout.len() > READ_CAP;
    let content = &out.stdout[..out.stdout.len().min(READ_CAP)];
    Ok(Json(json!({"content": text(content), "truncated": truncated})))
}

async fn write_file(
    State(sup): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, Some(&id))?;
    let path = path_arg(&body)?;
    if path.is_empty() {
        return Err(bad("path is required"));
    }
    let content = body["content"].as_str().ok_or_else(|| bad("content is required"))?;
    if content.len() > WRITE_CAP {
        return Err(bad(format!("content is larger than {} KiB", WRITE_CAP / 1024)));
    }
    // Written by the agent's own user inside its container, in chunks, to a
    // part file that is renamed at the end.
    let part = format!("{path}.amiro-part");
    let encoded = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let chunks: Vec<&str> = if encoded.is_empty() {
        vec![""]
    } else {
        encoded.as_bytes().chunks(WRITE_CHUNK_B64).map(|c| std::str::from_utf8(c).unwrap_or("")).collect()
    };
    for (index, chunk) in chunks.iter().enumerate() {
        let script = if index == 0 {
            r#"mkdir -p -- "$(dirname -- "$1")" && printf %s "$2" | base64 -d > "$1""#
        } else {
            r#"printf %s "$2" | base64 -d >> "$1""#
        };
        let out = sup.exec(&id, args(&["sh", "-c", script, "sh", &part, chunk]), 4096, Duration::from_secs(20)).await?;
        if out.exit_code != Some(0) {
            return Err(ApiError(StatusCode::CONFLICT, format!("could not write {path}: {}", text(&out.stderr).trim())));
        }
    }
    let out = sup
        .exec(&id, args(&["mv", "-f", "--", &part, &path]), 4096, Duration::from_secs(10))
        .await?;
    if out.exit_code != Some(0) {
        return Err(ApiError(StatusCode::CONFLICT, format!("could not write {path}: {}", text(&out.stderr).trim())));
    }
    Ok(Json(json!({"bytes": content.len()})))
}

async fn list_files(
    State(sup): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, Some(&id))?;
    let path = path_arg(&body)?;
    let dir = if path.is_empty() { ".".to_string() } else { path };
    let script = r#"find "$1" -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%f\n' | head -n "$2""#;
    let argv = args(&["sh", "-c", script, "sh", &dir, &(LIST_CAP + 1).to_string()]);
    let out = sup.exec(&id, argv, 256 * 1024, Duration::from_secs(20)).await?;
    if out.exit_code != Some(0) || !out.stderr.is_empty() && out.stdout.is_empty() {
        let reason = text(&out.stderr).trim().to_string();
        return Err(ApiError(StatusCode::NOT_FOUND, if reason.is_empty() { "folder not found".into() } else { reason }));
    }
    let mut entries: Vec<Value> = text(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let (kind, size, name) = (parts.next()?, parts.next()?, parts.next()?);
            let kind = match kind {
                "d" => "folder",
                "f" => "file",
                "l" => "link",
                _ => "other",
            };
            Some(json!({"name": name, "kind": kind, "size": size.parse::<u64>().unwrap_or(0)}))
        })
        .collect();
    let truncated = entries.len() > LIST_CAP;
    entries.truncate(LIST_CAP);
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(Json(json!({"entries": entries, "truncated": truncated})))
}

/// Measured from inside the container, so the owner sees the boundary as the
/// agent does.
const SELFCHECK: &str = r#"echo "uid=$(id -u)"; echo "gid=$(id -g)"
grep -E '^(CapEff|NoNewPrivs):' /proc/self/status | tr -d ' \t' | sed 's/:/=/'
if [ -e /var/run/docker.sock ] || [ -e /run/docker.sock ]; then echo docker=1; else echo docker=0; fi
if touch /.amiro-probe 2>/dev/null; then rm -f /.amiro-probe; echo rootro=0; else echo rootro=1; fi
if touch "$HOME/.amiro-probe" 2>/dev/null; then rm -f "$HOME/.amiro-probe"; echo homerw=1; else echo homerw=0; fi
echo "mounts=$(awk '$5 ~ /^\/home/ {print $5}' /proc/self/mountinfo | sort -u | tr '\n' ',')"
echo "homeEntries=$(ls -A "$HOME" | wc -l)""#;

async fn selfcheck(State(sup): State<Shared>, Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, Some(&id))?;
    let out = sup.exec(&id, args(&["sh", "-c", SELFCHECK]), 16 * 1024, Duration::from_secs(20)).await?;
    let fields: HashMap<String, String> = text(&out.stdout)
        .lines()
        .filter_map(|line| line.split_once('=').map(|(k, v)| (k.to_string(), v.trim().to_string())))
        .collect();
    let field = |k: &str| fields.get(k).cloned().unwrap_or_default();
    let mounts: Vec<String> = field("mounts").split(',').filter(|m| !m.is_empty()).map(str::to_string).collect();
    Ok(Json(json!({
        "uid": field("uid").parse::<u64>().ok(),
        "gid": field("gid").parse::<u64>().ok(),
        "capEff": field("CapEff"),
        "noCapabilities": field("CapEff").trim_start_matches('0').is_empty() && !field("CapEff").is_empty(),
        "noNewPrivs": field("NoNewPrivs") == "1",
        "dockerSocket": field("docker") == "1",
        "readOnlyRoot": field("rootro") == "1",
        "homeWritable": field("homerw") == "1",
        "homeMounts": mounts,
        "homeEntries": field("homeEntries").parse::<u64>().ok(),
        "network": sup.cfg.network,
        "runtime": sup.cfg.runtime.clone().unwrap_or_else(|| "runc".into()),
        "noNewPrivilegesConfigured": sup.cfg.no_new_privileges,
    })))
}

async fn index(State(sup): State<Shared>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    authorize(&sup, &headers, None)?;
    Ok(Json(json!({"namespace": sup.cfg.namespace})))
}

pub fn router(sup: Arc<Supervisor>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1", get(index))
        .route("/v1/agents/{id}/ensure", post(ensure))
        .route("/v1/agents/{id}/stop", post(stop))
        .route("/v1/agents/{id}/status", get(status))
        .route("/v1/agents/{id}/exec", post(exec))
        .route("/v1/agents/{id}/files/read", post(read_file))
        .route("/v1/agents/{id}/files/write", post(write_file))
        .route("/v1/agents/{id}/files/list", post(list_files))
        .route("/v1/agents/{id}/selfcheck", get(selfcheck))
        .with_state(sup)
}
