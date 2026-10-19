//! Shared native backend state and atomic JSON persistence.
use axum::{
    extract::FromRequestParts,
    http::{request::Parts, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{io::AsyncWriteExt, sync::Mutex};

#[derive(Clone)]
pub struct AppState {
    pub home: PathBuf,
    pub runtime_home: PathBuf,
    pub runtime_socket: PathBuf,
    pub workspace: PathBuf,
    pub runtime_bin: PathBuf,
    pub token: String,
    pub store: Arc<Mutex<()>>,
}
fn expand_path(value: impl AsRef<Path>) -> PathBuf {
    let value = value.as_ref();
    match value.to_str().and_then(|s| s.strip_prefix("~/")) {
        Some(rest) => crate::config::user_home().join(rest),
        None => value.to_owned(),
    }
}
impl AppState {
    pub fn from_env() -> Self {
        let user_home = crate::config::user_home();
        let home = std::env::var_os("AMIRO_HOME")
            .map(expand_path)
            .unwrap_or_else(|| user_home.join(".amiro"));
        let runtime_home = std::env::var_os("AMIRO_RUNTIME_HOME")
            .map(expand_path)
            .unwrap_or_else(|| home.join("runtime"));
        let runtime_socket = std::env::var_os("AMIRO_API_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|| runtime_home.join("amiro-api.sock"));
        // Where the runtime executable lives, in the order a packaged app and a
        // developer checkout need: an explicit override, a sidecar staged next
        // to this executable (Tauri places external binaries there), then the
        // runtime workspace's own build output.
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime/target");
        let executable = if cfg!(windows) {
            "amiro-runtime.exe"
        } else {
            "amiro-runtime"
        };
        let sibling = |name: &str| {
            std::env::current_exe().ok().and_then(|current| {
                current.parent().map(|dir| {
                    dir.join(if cfg!(windows) {
                        format!("{name}.exe")
                    } else {
                        name.to_string()
                    })
                })
            })
        };
        let runtime_bin = std::env::var_os("AMIRO_RUNTIME_BIN")
            .map(expand_path)
            .or_else(|| {
                ["runtime", "amiro-runtime", "amiro"]
                    .iter()
                    .filter_map(|name| sibling(name))
                    .find(|path| path.is_file())
            })
            .or_else(|| {
                [
                    repo.join("release").join(executable),
                    repo.join("debug").join(executable),
                ]
                .into_iter()
                .find(|path| path.is_file())
            })
            .or_else(|| {
                let candidate = PathBuf::from("/root/.local/bin/jcode");
                if candidate.is_file() {
                    Some(candidate)
                } else {
                    None
                }
            })
            .unwrap_or_else(|| PathBuf::from("amiro"));
        Self {
            workspace: home.join("workspace"),
            home,
            runtime_home,
            runtime_socket,
            runtime_bin,
            token: std::env::var("AMIRO_TOKEN").unwrap_or_default(),
            store: Arc::new(Mutex::new(())),
        }
    }
    pub fn out_dir(&self) -> PathBuf {
        out_dir(self)
    }
}
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn out_dir(_state: &AppState) -> PathBuf {
    std::env::var_os("AMIRO_OUT_DIR")
        .map(expand_path)
        .unwrap_or_else(|| {
            let packaged = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("ui")));
            packaged
                .filter(|p| p.is_dir())
                .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../out"))
        })
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.1)
    }
}
impl std::error::Error for ApiError {}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        let status = match error.kind() {
            std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
            std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(status, error.to_string())
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("invalid persisted JSON: {error}"),
        )
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct AuthUser(pub Value);
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Ok(user) = crate::auth::authenticate(state, &parts.headers).await {
            return Ok(Self(user));
        }
        if let Some(query) = parts.uri.query() {
            for pair in query.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    if (k == "token" || k == "bearer") && !v.trim().is_empty() {
                        let mut fake_headers = HeaderMap::new();
                        if let Ok(val) = HeaderValue::from_str(&format!("Bearer {}", v.trim())) {
                            fake_headers.insert(axum::http::header::AUTHORIZATION, val);
                            if let Ok(user) = crate::auth::authenticate(state, &fake_headers).await
                            {
                                return Ok(Self(user));
                            }
                        }
                    }
                }
            }
        }
        crate::auth::authenticate(state, &parts.headers)
            .await
            .map(Self)
    }
}
/// Missing data has a fallback. Corrupt or unreadable data is never silently reset.
pub async fn read_json(path: &Path, fallback: Value) -> Result<Value, ApiError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(error) => Err(error.into()),
    }
}
/// Callers serialize read-modify-write operations using AppState::store.
pub async fn write_json(path: &Path, value: &Value) -> Result<(), ApiError> {
    let parent = path.parent().ok_or_else(|| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "state file has no parent".into(),
        )
    })?;
    tokio::fs::create_dir_all(parent).await?;
    let temporary = parent.join(format!(".amiro-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = async {
        let mut file = options.open(&temporary).await?;
        let mut bytes = serde_json::to_vec_pretty(value)?;
        bytes.push(b'\n');
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path).await?;
        Ok::<(), ApiError>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn corrupt_and_empty_existing_files_are_not_replaced_with_defaults() {
        let directory =
            std::env::temp_dir().join(format!("amiro-state-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let file = directory.join("users.json");
        for content in ["", "broken JSON", "   "] {
            tokio::fs::write(&file, content).await.unwrap();
            assert!(read_json(&file, json!({"users":[]})).await.is_err());
            assert_eq!(tokio::fs::read_to_string(&file).await.unwrap(), content);
        }
        assert_eq!(
            read_json(&directory.join("absent.json"), json!({"missing":true}))
                .await
                .unwrap(),
            json!({"missing":true})
        );
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn atomic_state_writes_roundtrip_with_private_permissions() {
        let directory =
            std::env::temp_dir().join(format!("amiro-state-test-{}", uuid::Uuid::new_v4()));
        let file = directory.join("private.json");
        write_json(&file, &json!({"value":1})).await.unwrap();
        write_json(&file, &json!({"value":2})).await.unwrap();
        assert_eq!(
            read_json(&file, Value::Null).await.unwrap(),
            json!({"value":2})
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                tokio::fs::metadata(&file)
                    .await
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
