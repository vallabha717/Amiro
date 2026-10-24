//! The backend's client for the supervisor.
//!
//! Holds the supervisor token and the master; sends each agent's derived
//! credential, never the master, with agent-scoped calls.

use std::time::Duration;

use serde_json::{json, Value};

use crate::credential::agent_credential;
use crate::CREDENTIAL_HEADER;

/// A supervisor call failed. `status` is `None` when it could not be reached.
#[derive(Debug, Clone, PartialEq)]
pub struct ClientError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Clone)]
pub struct SandboxClient {
    base: String,
    token: String,
    master: String,
    http: reqwest::Client,
}

impl std::fmt::Debug for SandboxClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the secrets.
        f.debug_struct("SandboxClient").field("base", &self.base).finish_non_exhaustive()
    }
}

impl SandboxClient {
    pub fn new(base: impl Into<String>, token: impl Into<String>, master: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(150))
            .build()
            .unwrap_or_default();
        SandboxClient {
            base: base.into().trim_end_matches('/').to_string(),
            token: token.into(),
            master: master.into(),
            http,
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    async fn finish(response: Result<reqwest::Response, reqwest::Error>) -> Result<Value, ClientError> {
        let response = response.map_err(|e| ClientError {
            status: None,
            message: if e.is_timeout() {
                "the sandbox supervisor did not answer in time".into()
            } else {
                "the sandbox supervisor is not reachable".into()
            },
        })?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(body)
        } else {
            Err(ClientError {
                status: Some(status.as_u16()),
                message: body["error"].as_str().unwrap_or("the sandbox supervisor refused the request").to_string(),
            })
        }
    }

    /// `GET /health` (no auth). `Ok` means reachable; check `docker` in it.
    pub async fn health(&self) -> Result<Value, ClientError> {
        let request = self.http.get(format!("{}/health", self.base)).timeout(Duration::from_secs(3));
        Self::finish(request.send().await).await
    }

    fn agent(&self, method: reqwest::Method, id: &str, action: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}/v1/agents/{id}/{action}", self.base))
            .bearer_auth(&self.token)
            .header(CREDENTIAL_HEADER, agent_credential(&self.master, id))
    }

    async fn post(&self, id: &str, action: &str, body: Value) -> Result<Value, ClientError> {
        Self::finish(self.agent(reqwest::Method::POST, id, action).json(&body).send().await).await
    }

    async fn get(&self, id: &str, action: &str) -> Result<Value, ClientError> {
        Self::finish(self.agent(reqwest::Method::GET, id, action).send().await).await
    }

    pub async fn ensure(&self, id: &str) -> Result<Value, ClientError> {
        self.post(id, "ensure", json!({})).await
    }

    pub async fn stop(&self, id: &str) -> Result<Value, ClientError> {
        self.post(id, "stop", json!({})).await
    }

    pub async fn status(&self, id: &str) -> Result<Value, ClientError> {
        self.get(id, "status").await
    }

    pub async fn selfcheck(&self, id: &str) -> Result<Value, ClientError> {
        self.get(id, "selfcheck").await
    }

    pub async fn exec(&self, id: &str, command: &str, timeout_secs: Option<u64>) -> Result<Value, ClientError> {
        self.post(id, "exec", json!({"command": command, "timeoutSecs": timeout_secs})).await
    }

    pub async fn read_file(&self, id: &str, path: &str) -> Result<Value, ClientError> {
        self.post(id, "files/read", json!({"path": path})).await
    }

    pub async fn write_file(&self, id: &str, path: &str, content: &str) -> Result<Value, ClientError> {
        self.post(id, "files/write", json!({"path": path, "content": content})).await
    }

    pub async fn list_files(&self, id: &str, path: &str) -> Result<Value, ClientError> {
        self.post(id, "files/list", json!({"path": path})).await
    }

    pub async fn create_terminal_session(
        &self,
        id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Value, ClientError> {
        self.post(id, "terminal/sessions", json!({"cols": cols, "rows": rows}))
            .await
    }

    pub async fn terminal_session_input(
        &self,
        id: &str,
        session_id: &str,
        data: &str,
    ) -> Result<Value, ClientError> {
        self.post(
            id,
            &format!("terminal/sessions/{session_id}/input"),
            json!({"data": data}),
        )
        .await
    }

    pub async fn terminal_session_resize(
        &self,
        id: &str,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Value, ClientError> {
        self.post(
            id,
            &format!("terminal/sessions/{session_id}/resize"),
            json!({"cols": cols, "rows": rows}),
        )
        .await
    }

    pub async fn terminal_session_destroy(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<Value, ClientError> {
        Self::finish(
            self.agent(
                reqwest::Method::DELETE,
                id,
                &format!("terminal/sessions/{session_id}"),
            )
            .send()
            .await,
        )
        .await
    }

    pub async fn terminal_session_events(
        &self,
        id: &str,
        session_id: &str,
        after_seq: u64,
    ) -> Result<Value, ClientError> {
        self.get(
            id,
            &format!("terminal/sessions/{session_id}/events?after_seq={after_seq}"),
        )
        .await
    }

    pub async fn create_desktop_session(
        &self,
        id: &str,
        label: &str,
        accent_hex: &str,
    ) -> Result<Value, ClientError> {
        self.post(
            id,
            "desktop/sessions",
            json!({"label": label, "accentHex": accent_hex}),
        )
        .await
    }

    pub async fn desktop_session_input(
        &self,
        id: &str,
        session_id: &str,
        base64_bytes: &str,
    ) -> Result<Value, ClientError> {
        self.post(
            id,
            &format!("desktop/sessions/{session_id}/input"),
            json!({"data": base64_bytes}),
        )
        .await
    }

    pub async fn desktop_session_read(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<Value, ClientError> {
        self.get(id, &format!("desktop/sessions/{session_id}/read"))
            .await
    }

    pub async fn desktop_session_destroy(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<Value, ClientError> {
        Self::finish(
            self.agent(
                reqwest::Method::DELETE,
                id,
                &format!("desktop/sessions/{session_id}"),
            )
            .send()
            .await,
        )
        .await
    }
}
