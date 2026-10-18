//! Composio API-key resolution and endpoint configuration.
//!
//! Resolution precedence mirrors what a user can actually configure, from the
//! most specific/overrideable to the least:
//!
//! 1. the key saved from the UI, now sealed in the encrypted credential store at
//!    `$AMIRO_HOME/protected/credentials.enc` (`composio`/`api_key`),
//! 2. `COMPOSIO_API_KEY` from the environment, or from `$AMIRO_HOME/.env`,
//! 3. `$AMIRO_HOME/amiro.toml` under `[composio] api_key = "..."`.
//!
//! The store is adapter-compatible: it still reports the `ui` source label, so
//! existing clients keep working while the value is encrypted at rest. A legacy
//! plaintext `store/composio.json` is migrated into the store and removed on
//! first resolve. The full key never leaves this module toward clients: routes
//! only ever see [`ApiKey::hint`] and the [`KeySource`] label.

use serde::Serialize;
use serde_json::{json, Value};

use crate::credentials;
use crate::state::{read_json, ApiError, AppState};

/// Default Composio API origin. Overridable so tests (and self-hosted
/// deployments) can point at a mock or a proxy.
pub const DEFAULT_BASE_URL: &str = "https://backend.composio.dev";

/// Environment variable holding the Composio API key.
pub const API_KEY_ENV: &str = "COMPOSIO_API_KEY";

/// Where a resolved key came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    Ui,
    Env,
    Toml,
}

impl KeySource {
    pub fn as_str(self) -> &'static str {
        match self {
            KeySource::Ui => "ui",
            KeySource::Env => "env",
            KeySource::Toml => "toml",
        }
    }
}

/// A resolved API key plus its provenance.
#[derive(Debug, Clone)]
pub struct ApiKey {
    pub value: String,
    pub source: KeySource,
}

impl ApiKey {
    /// Client-safe hint: only the last four characters are revealed.
    pub fn hint(&self) -> String {
        hint_of(&self.value)
    }
}

/// Mask everything but the last four characters of a key.
pub fn hint_of(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 4 {
        return "••••".to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("••••{tail}")
}

/// The Composio API origin for this process.
pub fn base_url() -> String {
    base_url_from(std::env::var("AMIRO_COMPOSIO_BASE_URL").ok())
}

/// Testable variant of [`base_url`]: an explicit override wins, an empty or
/// whitespace override falls back to the default, and trailing slashes are
/// trimmed so callers can append `/api/...` safely.
pub fn base_url_from(override_value: Option<String>) -> String {
    let candidate = override_value
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty());
    candidate.unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// Pure precedence resolver: `ui` > `env` > `toml`, ignoring blanks.
pub fn resolve_api_key(
    ui: Option<String>,
    env: Option<String>,
    toml: Option<String>,
) -> Option<ApiKey> {
    let cleaned = |value: Option<String>| value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if let Some(value) = cleaned(ui) {
        return Some(ApiKey { value, source: KeySource::Ui });
    }
    if let Some(value) = cleaned(env) {
        return Some(ApiKey { value, source: KeySource::Env });
    }
    if let Some(value) = cleaned(toml) {
        return Some(ApiKey { value, source: KeySource::Toml });
    }
    None
}

/// The logical service/field names for the Composio key in the store.
pub const SERVICE: &str = "composio";
pub const FIELD: &str = "api_key";

fn ui_key_path(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("composio.json")
}

/// Read the key from the encrypted store (the old UI-key slot).
async fn store_key(state: &AppState) -> Result<Option<String>, ApiError> {
    Ok(credentials::get_plaintext(state, SERVICE, FIELD)
        .await?
        .map(|secret| secret.expose().to_string()))
}

/// Overwrite a legacy plaintext file with zeros, then unlink it.
async fn secure_remove(path: &std::path::Path) {
    use tokio::io::AsyncWriteExt;
    if let Ok(metadata) = tokio::fs::metadata(path).await {
        if let Ok(mut file) = tokio::fs::OpenOptions::new().write(true).open(path).await {
            let zeros = vec![0u8; metadata.len().min(1 << 20) as usize];
            let _ = file.write_all(&zeros).await;
            let _ = file.sync_all().await;
        }
    }
    let _ = tokio::fs::remove_file(path).await;
}

/// Migrate a legacy plaintext `store/composio.json` into the encrypted store and
/// delete it. Idempotent: once the file is gone this is a no-op.
pub async fn migrate_legacy(state: &AppState) -> Result<(), ApiError> {
    let path = ui_key_path(state);
    match tokio::fs::metadata(&path).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    let doc = read_json(&path, json!({})).await?;
    let key = doc
        .get("apiKey")
        .or_else(|| doc.get("api_key"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    match key {
        Some(key) => {
            credentials::set(state, SERVICE, FIELD, &key, Some("Composio API key")).await?;
            tracing::info!(
                "migrated the legacy plaintext Composio key into the encrypted credential store"
            );
        }
        None => {
            tracing::warn!("removed an empty legacy Composio key file");
        }
    }
    secure_remove(&path).await;
    Ok(())
}

/// Parse a `KEY=VALUE` dotenv body, returning `COMPOSIO_API_KEY` if present.
pub fn parse_env_file(contents: &str) -> Option<String> {
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != API_KEY_ENV {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

async fn env_key(state: &AppState) -> Result<Option<String>, ApiError> {
    if let Ok(value) = std::env::var(API_KEY_ENV) {
        if !value.trim().is_empty() {
            return Ok(Some(value));
        }
    }
    let dotenv = state.home.join(".env");
    match tokio::fs::read_to_string(&dotenv).await {
        Ok(contents) => Ok(parse_env_file(&contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Read `[composio] api_key` from a TOML document body.
pub fn parse_toml_key(contents: &str) -> Option<String> {
    let value: toml::Value = contents.parse().ok()?;
    value
        .get("composio")
        .and_then(|section| section.get("api_key"))
        .and_then(|key| key.as_str())
        .map(str::to_string)
}

async fn toml_key(state: &AppState) -> Result<Option<String>, ApiError> {
    let path = state.home.join("amiro.toml");
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => Ok(parse_toml_key(&contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Resolve the effective Composio key for this process, or `None` when the user
/// has not configured one. Corrupt on-disk sources surface as errors rather
/// than being silently ignored. Migrates a legacy plaintext key first.
pub async fn resolve(state: &AppState) -> Result<Option<ApiKey>, ApiError> {
    migrate_legacy(state).await?;
    let store = store_key(state).await?;
    let env = env_key(state).await?;
    let toml = toml_key(state).await?;
    Ok(resolve_api_key(store, env, toml))
}

/// Persist the UI key into the encrypted store (owner-only at rest).
pub async fn save_ui_key(state: &AppState, key: &str) -> Result<(), ApiError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(ApiError(
            axum::http::StatusCode::BAD_REQUEST,
            "apiKey is required".to_string(),
        ));
    }
    credentials::set(state, SERVICE, FIELD, key, Some("Composio API key")).await?;
    refresh_runtime_key(state);
    Ok(())
}

/// Remove the UI key, leaving env/TOML sources untouched.
pub async fn remove_ui_key(state: &AppState) -> Result<(), ApiError> {
    credentials::delete(state, SERVICE, FIELD).await?;
    refresh_runtime_key(state);
    Ok(())
}

/// The resolution used by [`crate::runtime::runtime_env`] to hand the key to a
/// child process synchronously. Mirrors [`resolve`] precedence
/// (store > env > toml) but never creates the store key and never awaits.
pub fn resolve_key_sync(home: &std::path::Path) -> Option<String> {
    let non_empty = |value: String| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    };
    if let Some(secret) = credentials::get_plaintext_sync(home, SERVICE, FIELD) {
        if let Some(value) = non_empty(secret.expose().to_string()) {
            return Some(value);
        }
    }
    if let Ok(value) = std::env::var(API_KEY_ENV) {
        if let Some(value) = non_empty(value) {
            return Some(value);
        }
    }
    if let Ok(contents) = std::fs::read_to_string(home.join(".env")) {
        if let Some(value) = parse_env_file(&contents) {
            return Some(value);
        }
    }
    if let Ok(contents) = std::fs::read_to_string(home.join("amiro.toml")) {
        if let Some(value) = parse_toml_key(&contents) {
            return Some(value);
        }
    }
    None
}

/// A changed Composio key must reach any runtime process the backend supervises.
/// Best-effort and bounded: this restarts only a bridge this backend started, so
/// an externally supervised runtime keeps its own environment (see the module
/// report). The restart runs off the request path.
pub fn refresh_runtime_key(state: &AppState) {
    let state = state.clone();
    tokio::task::spawn_blocking(move || {
        if crate::runtime::restart_for_env_change(&state) {
            tracing::info!("restarted the runtime bridge to apply a changed Composio key");
        }
    });
}

/// Shape a resolved key for a client: never the full secret.
pub fn public_config(key: Option<&ApiKey>) -> Value {
    match key {
        Some(key) => json!({
            "configured": true,
            "source": key.source.as_str(),
            "apiKeyHint": key.hint(),
        }),
        None => json!({
            "configured": false,
            "source": Value::Null,
            "apiKeyHint": Value::Null,
        }),
    }
}

/// The encrypted store file, exposed so tests can assert its permissions. The
/// legacy plaintext path is migrated away and never written again.
pub fn ui_key_file(state: &AppState) -> std::path::PathBuf {
    credentials::store_file(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn precedence_is_ui_then_env_then_toml() {
        let key = resolve_api_key(Some("ui-key".into()), Some("env-key".into()), Some("toml".into()))
            .unwrap();
        assert_eq!(key.value, "ui-key");
        assert_eq!(key.source, KeySource::Ui);

        let key = resolve_api_key(None, Some("env-key".into()), Some("toml".into())).unwrap();
        assert_eq!(key.value, "env-key");
        assert_eq!(key.source, KeySource::Env);

        let key = resolve_api_key(None, None, Some("toml-key".into())).unwrap();
        assert_eq!(key.source, KeySource::Toml);

        assert!(resolve_api_key(None, None, None).is_none());
        // Blank values are treated as absent.
        assert!(resolve_api_key(Some("  ".into()), None, None).is_none());
    }

    #[test]
    fn hints_only_reveal_the_tail() {
        assert_eq!(hint_of("sk-abcdef1234"), "••••1234");
        assert_eq!(hint_of("abc"), "••••");
        assert_eq!(hint_of(""), "••••");
    }

    #[test]
    fn base_url_override_is_normalized() {
        assert_eq!(base_url_from(None), DEFAULT_BASE_URL);
        assert_eq!(base_url_from(Some("  ".into())), DEFAULT_BASE_URL);
        assert_eq!(
            base_url_from(Some("http://127.0.0.1:8080/".into())),
            "http://127.0.0.1:8080"
        );
    }

    #[test]
    fn dotenv_parsing_is_tolerant() {
        let body = "# comment\nOTHER=1\nexport COMPOSIO_API_KEY=\"sk-abc123\"\n";
        assert_eq!(parse_env_file(body).as_deref(), Some("sk-abc123"));
        assert_eq!(parse_env_file("COMPOSIO_API_KEY=plain").as_deref(), Some("plain"));
        assert_eq!(parse_env_file("COMPOSIO_API_KEY='quoted'").as_deref(), Some("quoted"));
        assert_eq!(parse_env_file("NOPE=1"), None);
    }

    #[test]
    fn toml_parsing_reads_composio_section() {
        let body = "[composio]\napi_key = \"sk-toml\"\n";
        assert_eq!(parse_toml_key(body).as_deref(), Some("sk-toml"));
        assert_eq!(parse_toml_key("[other]\nx = 1\n"), None);
        assert_eq!(parse_toml_key("not toml = = ="), None);
    }

    #[test]
    fn public_config_never_exposes_the_key() {
        let key = ApiKey {
            value: "sk-secret-value-9999".into(),
            source: KeySource::Ui,
        };
        let rendered = public_config(Some(&key)).to_string();
        assert!(!rendered.contains("sk-secret-value"));
        assert!(rendered.contains("9999"));
        assert_eq!(
            public_config(None),
            json!({"configured": false, "source": null, "apiKeyHint": null})
        );
    }

    fn fixture() -> (AppState, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("amiro-cfg-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let state = AppState {
            home,
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("amiro-api.sock"),
            workspace: root.join("workspace"),
            runtime_bin: root.join("amiro-runtime"),
            token: String::new(),
            store: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        };
        (state, root)
    }

    #[tokio::test]
    async fn store_key_wins_over_env_and_toml_and_reports_ui() {
        let (state, root) = fixture();
        save_ui_key(&state, "sk-from-store-1234").await.unwrap();
        std::fs::write(state.home.join(".env"), "COMPOSIO_API_KEY=sk-from-env\n").unwrap();
        std::fs::write(
            state.home.join("amiro.toml"),
            "[composio]\napi_key = \"sk-from-toml\"\n",
        )
        .unwrap();

        let key = resolve(&state).await.unwrap().unwrap();
        assert_eq!(key.value, "sk-from-store-1234");
        // Backwards-compatible source label for the store.
        assert_eq!(key.source, KeySource::Ui);
        assert_eq!(key.source.as_str(), "ui");
        assert_eq!(
            resolve_key_sync(&state.home).as_deref(),
            Some("sk-from-store-1234")
        );

        remove_ui_key(&state).await.unwrap();
        let key = resolve(&state).await.unwrap().unwrap();
        assert_eq!(key.value, "sk-from-env");
        assert_eq!(key.source, KeySource::Env);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn legacy_plaintext_key_is_migrated_and_removed() {
        let (state, root) = fixture();
        let legacy = ui_key_path(&state);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, r#"{"apiKey":"sk-legacy-5555"}"#).unwrap();

        let key = resolve(&state).await.unwrap().unwrap();
        assert_eq!(key.value, "sk-legacy-5555");
        assert_eq!(key.source, KeySource::Ui);
        assert!(!legacy.exists(), "legacy plaintext file must be removed");

        // The value now lives only in the encrypted store.
        let stored = credentials::get_plaintext(&state, SERVICE, FIELD)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.expose(), "sk-legacy-5555");
        let on_disk =
            String::from_utf8_lossy(&std::fs::read(credentials::store_file(&state)).unwrap())
                .to_string();
        assert!(!on_disk.contains("sk-legacy-5555"));

        // Migration is idempotent.
        resolve(&state).await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
