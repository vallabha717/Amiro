//! Minimal Docker Engine API client over the daemon's local socket: the unix
//! socket on Linux and macOS, the `docker_engine` named pipe on Windows.
//!
//! Only what the supervisor needs: inspect, create, start, stop, remove and a
//! non-interactive exec. One HTTP/1.1 connection per request; no TLS, no
//! registry auth, no image pulls (images are built by `scripts/sandbox.sh`).

use std::path::PathBuf;
use std::time::Duration;

use bytes::{Buf, Bytes, BytesMut};
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};

/// A Docker call failed. The message is safe to show the owner.
#[derive(Debug, Clone, PartialEq)]
pub struct DockerError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for DockerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn err(message: impl Into<String>) -> DockerError {
    DockerError { status: None, message: message.into() }
}

/// What one exec produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExecOutput {
    pub exit_code: Option<i64>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Output passed the cap and the rest was dropped.
    pub truncated: bool,
    /// The read deadline passed before the process closed its output.
    pub timed_out: bool,
}

#[derive(Debug, Clone)]
pub struct Docker {
    socket: PathBuf,
}

/// Where the Docker daemon listens unless `DOCKER_SOCKET` says otherwise.
#[cfg(unix)]
pub const DEFAULT_SOCKET: &str = "/var/run/docker.sock";
/// Where the Docker daemon listens unless `DOCKER_SOCKET` says otherwise.
#[cfg(windows)]
pub const DEFAULT_SOCKET: &str = r"\\.\pipe\docker_engine";

impl Docker {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Docker { socket: socket.into() }
    }

    #[cfg(unix)]
    async fn connect(&self) -> std::io::Result<tokio::net::UnixStream> {
        tokio::net::UnixStream::connect(&self.socket).await
    }

    #[cfg(windows)]
    async fn connect(&self) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
        tokio::net::windows::named_pipe::ClientOptions::new().open(&self.socket)
    }

    async fn send(&self, method: Method, path: &str, body: Option<&Value>) -> Result<hyper::Response<hyper::body::Incoming>, DockerError> {
        let stream = self
            .connect()
            .await
            .map_err(|e| err(format!("cannot reach Docker at {}: {e}", self.socket.display())))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| err(format!("Docker handshake failed: {e}")))?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let payload = body.map(|b| Bytes::from(b.to_string())).unwrap_or_default();
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "docker")
            .header("content-type", "application/json")
            .body(Full::new(payload))
            .map_err(|e| err(format!("bad Docker request: {e}")))?;
        sender
            .send_request(request)
            .await
            .map_err(|e| err(format!("Docker request failed: {e}")))
    }

    async fn call(&self, method: Method, path: &str, body: Option<&Value>) -> Result<(StatusCode, Value), DockerError> {
        let response = self.send(method, path, body).await?;
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|e| err(format!("Docker response failed: {e}")))?
            .to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Ok((status, value))
    }

    fn fail(status: StatusCode, value: &Value, what: &str) -> DockerError {
        let detail = value.get("message").and_then(Value::as_str).unwrap_or("no detail");
        DockerError { status: Some(status.as_u16()), message: format!("{what}: {detail}") }
    }

    /// Whether the daemon answers.
    pub async fn ping(&self) -> bool {
        matches!(self.call(Method::GET, "/_ping", None).await, Ok((s, _)) if s.is_success())
    }

    /// `GET /containers/{name}/json`, `None` when it does not exist.
    pub async fn inspect(&self, name: &str) -> Result<Option<Value>, DockerError> {
        let (status, value) = self.call(Method::GET, &format!("/containers/{name}/json"), None).await?;
        match status {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => Ok(Some(value)),
            s => Err(Self::fail(s, &value, "inspect failed")),
        }
    }

    /// Create a container; returns its id.
    pub async fn create(&self, name: &str, spec: &Value) -> Result<String, DockerError> {
        let (status, value) = self.call(Method::POST, &format!("/containers/create?name={name}"), Some(spec)).await?;
        if !status.is_success() {
            return Err(Self::fail(status, &value, "create failed"));
        }
        value["Id"].as_str().map(str::to_string).ok_or_else(|| err("create returned no id"))
    }

    pub async fn start(&self, id: &str) -> Result<(), DockerError> {
        let (status, value) = self.call(Method::POST, &format!("/containers/{id}/start"), None).await?;
        // 304: already running.
        if status.is_success() || status == StatusCode::NOT_MODIFIED {
            Ok(())
        } else {
            Err(Self::fail(status, &value, "start failed"))
        }
    }

    pub async fn stop(&self, id: &str) -> Result<(), DockerError> {
        let (status, value) = self.call(Method::POST, &format!("/containers/{id}/stop?t=5"), None).await?;
        if status.is_success() || status == StatusCode::NOT_MODIFIED || status == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(Self::fail(status, &value, "stop failed"))
        }
    }

    pub async fn remove(&self, id: &str) -> Result<(), DockerError> {
        let (status, value) = self.call(Method::DELETE, &format!("/containers/{id}?force=true"), None).await?;
        if status.is_success() || status == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(Self::fail(status, &value, "remove failed"))
        }
    }

    /// Run `argv` in the container as its configured user, collecting at most
    /// `cap` bytes of stdout+stderr and waiting at most `wait`.
    pub async fn exec(&self, id: &str, argv: &[String], cap: usize, wait: Duration) -> Result<ExecOutput, DockerError> {
        let create = json!({"AttachStdout": true, "AttachStderr": true, "AttachStdin": false, "Tty": false, "Cmd": argv});
        let (status, value) = self.call(Method::POST, &format!("/containers/{id}/exec"), Some(&create)).await?;
        if !status.is_success() {
            return Err(Self::fail(status, &value, "exec failed"));
        }
        let exec_id = value["Id"].as_str().ok_or_else(|| err("exec returned no id"))?.to_string();
        let response = self
            .send(Method::POST, &format!("/exec/{exec_id}/start"), Some(&json!({"Detach": false, "Tty": false})))
            .await?;
        if !response.status().is_success() {
            return Err(DockerError { status: Some(response.status().as_u16()), message: "exec start failed".into() });
        }
        let mut out = ExecOutput::default();
        let mut body = response.into_body();
        let mut pending = BytesMut::new();
        let read = async {
            while let Some(frame) = body.frame().await {
                let Ok(frame) = frame else { break };
                let Ok(data) = frame.into_data() else { continue };
                pending.extend_from_slice(&data);
                demux(&mut pending, &mut out, cap);
                if out.truncated {
                    break;
                }
            }
        };
        if tokio::time::timeout(wait, read).await.is_err() {
            out.timed_out = true;
        }
        if !out.timed_out && !out.truncated {
            let (status, value) = self.call(Method::GET, &format!("/exec/{exec_id}/json"), None).await?;
            if status.is_success() {
                out.exit_code = value["ExitCode"].as_i64();
            }
        }
        Ok(out)
    }

    /// Create an interactive TTY exec inside `id` and return its `exec_id`.
    pub async fn create_tty_exec(&self, id: &str, argv: &[String]) -> Result<String, DockerError> {
        let create = json!({
            "AttachStdout": true,
            "AttachStderr": true,
            "AttachStdin": true,
            "Tty": true,
            "WorkingDir": "/home/agent",
            "Env": ["TERM=xterm-256color", "HOME=/home/agent"],
            "Cmd": argv,
        });
        let (status, value) = self
            .call(Method::POST, &format!("/containers/{id}/exec"), Some(&create))
            .await?;
        if !status.is_success() {
            return Err(Self::fail(status, &value, "exec create failed"));
        }
        value["Id"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| err("exec returned no id"))
    }

    /// Upgrade `/exec/{exec_id}/start` with `Tty: true` into a raw bidirectional
    /// byte stream (`TokioIo<hyper::upgrade::Upgraded>`).
    pub async fn start_tty_exec(
        &self,
        exec_id: &str,
    ) -> Result<TokioIo<hyper::upgrade::Upgraded>, DockerError> {
        let stream = self
            .connect()
            .await
            .map_err(|e| err(format!("cannot reach Docker at {}: {e}", self.socket.display())))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| err(format!("Docker handshake failed: {e}")))?;
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });
        let payload = Bytes::from(json!({"Detach": false, "Tty": true}).to_string());
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/exec/{exec_id}/start"))
            .header("host", "docker")
            .header("content-type", "application/json")
            .header("connection", "Upgrade")
            .header("upgrade", "tcp")
            .body(Full::new(payload))
            .map_err(|e| err(format!("bad Docker request: {e}")))?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|e| err(format!("Docker exec start failed: {e}")))?;
        if response.status() != StatusCode::SWITCHING_PROTOCOLS && !response.status().is_success() {
            return Err(DockerError {
                status: Some(response.status().as_u16()),
                message: format!("exec tty start failed ({})", response.status()),
            });
        }
        let upgraded = hyper::upgrade::on(response)
            .await
            .map_err(|e| err(format!("Docker exec upgrade failed: {e}")))?;
        Ok(TokioIo::new(upgraded))
    }

    /// Resize a running TTY exec (`POST /exec/{exec_id}/resize?h={rows}&w={cols}`).
    pub async fn resize_tty_exec(
        &self,
        exec_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), DockerError> {
        let cols = cols.clamp(1, 1000);
        let rows = rows.clamp(1, 1000);
        let (status, value) = self
            .call(
                Method::POST,
                &format!("/exec/{exec_id}/resize?h={rows}&w={cols}"),
                None,
            )
            .await?;
        if status.is_success() {
            Ok(())
        } else {
            Err(Self::fail(status, &value, "exec resize failed"))
        }
    }

    /// Create a raw non-TTY bidirectional stream exec (`AttachStdin: true,
    /// AttachStdout: true, AttachStderr: false, Tty: false`) and return its `exec_id`.
    pub async fn create_stream_exec(
        &self,
        id: &str,
        argv: &[String],
    ) -> Result<String, DockerError> {
        let create = json!({
            "AttachStdout": true,
            "AttachStderr": false,
            "AttachStdin": true,
            "Tty": false,
            "WorkingDir": "/home/agent",
            "Cmd": argv,
        });
        let (status, value) = self
            .call(Method::POST, &format!("/containers/{id}/exec"), Some(&create))
            .await?;
        if !status.is_success() {
            return Err(Self::fail(status, &value, "stream exec create failed"));
        }
        value["Id"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| err("exec returned no id"))
    }

    /// Upgrade `/exec/{exec_id}/start` with `Tty: false` into a raw bidirectional
    /// stream (`TokioIo<hyper::upgrade::Upgraded>`).
    pub async fn start_non_tty_stream_exec(
        &self,
        exec_id: &str,
    ) -> Result<TokioIo<hyper::upgrade::Upgraded>, DockerError> {
        let stream = self
            .connect()
            .await
            .map_err(|e| err(format!("cannot reach Docker at {}: {e}", self.socket.display())))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| err(format!("Docker handshake failed: {e}")))?;
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });
        let payload = Bytes::from(json!({"Detach": false, "Tty": false}).to_string());
        let request = Request::builder()
            .method(Method::POST)
            .uri(format!("/exec/{exec_id}/start"))
            .header("host", "docker")
            .header("content-type", "application/json")
            .header("connection", "Upgrade")
            .header("upgrade", "tcp")
            .body(Full::new(payload))
            .map_err(|e| err(format!("bad Docker request: {e}")))?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|e| err(format!("Docker exec start failed: {e}")))?;
        if response.status() != StatusCode::SWITCHING_PROTOCOLS && !response.status().is_success() {
            return Err(DockerError {
                status: Some(response.status().as_u16()),
                message: format!("exec stream start failed ({})", response.status()),
            });
        }
        let upgraded = hyper::upgrade::on(response)
            .await
            .map_err(|e| err(format!("Docker exec upgrade failed: {e}")))?;
        Ok(TokioIo::new(upgraded))
    }
}

/// Move complete multiplexed frames (`[stream, 0, 0, 0, len u32 BE] payload`)
/// from `pending` into `out`, honouring the byte cap.
fn demux(pending: &mut BytesMut, out: &mut ExecOutput, cap: usize) {
    while pending.len() >= 8 {
        let len = u32::from_be_bytes([pending[4], pending[5], pending[6], pending[7]]) as usize;
        if pending.len() < 8 + len {
            return;
        }
        let stream = pending[0];
        pending.advance(8);
        let payload = pending.split_to(len);
        let used = out.stdout.len() + out.stderr.len();
        let room = cap.saturating_sub(used);
        let take = payload.len().min(room);
        let target = if stream == 2 { &mut out.stderr } else { &mut out.stdout };
        target.extend_from_slice(&payload[..take]);
        if take < payload.len() {
            out.truncated = true;
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(stream: u8, data: &[u8]) -> Vec<u8> {
        let mut f = vec![stream, 0, 0, 0];
        f.extend_from_slice(&(data.len() as u32).to_be_bytes());
        f.extend_from_slice(data);
        f
    }

    #[test]
    fn demux_splits_streams_and_waits_for_whole_frames() {
        let mut all = frame(1, b"out ");
        all.extend(frame(2, b"err"));
        all.extend(frame(1, b"more"));
        let mut out = ExecOutput::default();
        let mut pending = BytesMut::from(&all[..5]);
        demux(&mut pending, &mut out, 1024);
        assert!(out.stdout.is_empty());
        pending.extend_from_slice(&all[5..]);
        demux(&mut pending, &mut out, 1024);
        assert_eq!(out.stdout, b"out more");
        assert_eq!(out.stderr, b"err");
        assert!(!out.truncated);
    }

    #[test]
    fn demux_stops_at_the_cap() {
        let mut out = ExecOutput::default();
        let mut pending = BytesMut::from(&frame(1, &[b'x'; 100])[..]);
        demux(&mut pending, &mut out, 10);
        assert_eq!(out.stdout.len(), 10);
        assert!(out.truncated);
    }
}
