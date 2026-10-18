//! Encrypted credential store (Vellum-style).
//!
//! Secrets live encrypted at rest under `$AMIRO_HOME/protected/`:
//!
//! - `store.key` is 32 random bytes, generated on first use, created atomically
//!   with mode `0600`, and never overwritten.
//! - `credentials.enc` is a JSON map keyed `credential/{service}/{field}` whose
//!   values hold an AES-256-GCM nonce + ciphertext (both base64), a display
//!   `label`, and `createdAt`/`updatedAt` timestamps. There is no plaintext API
//!   for clients: routes only ever see metadata plus a masked four-character
//!   hint.
//!
//! Each value is sealed with a fresh random 12-byte nonce and the associated
//! data `"service/field"`, so a ciphertext copied to another key fails to open.
//! Writes are atomic (temp file + rename) and serialized with `AppState::store`;
//! the directory is `0700` and files are `0600`. Plaintext is carried in
//! zeroizing buffers and never logged: [`Secret`] and the on-disk record both
//! have `Debug` implementations that redact.

use std::io::Write;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use serde_json::{json, Map, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::state::{read_json, write_json, ApiError, AppState};

/// Directory (relative to `$AMIRO_HOME`) holding the key and the store.
pub const PROTECTED_DIR: &str = "protected";
/// File name of the encrypted store.
pub const STORE_FILE: &str = "credentials.enc";
/// File name of the random master key.
pub const KEY_FILE: &str = "store.key";
/// Maximum accepted plaintext length for one credential.
pub const MAX_VALUE_LEN: usize = 8192;
/// Maximum length of a service or field name.
pub const MAX_NAME_LEN: usize = 64;

fn internal(message: &str) -> ApiError {
    ApiError(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        message.to_string(),
    )
}

fn bad_request(message: &str) -> ApiError {
    ApiError(axum::http::StatusCode::BAD_REQUEST, message.to_string())
}

/// A plaintext secret held in a buffer that is scrubbed on drop.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    /// Borrow the plaintext. Callers must not log or serialize the result.
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never let a secret reach a log line, even by accident.
        f.write_str("Secret(<redacted>)")
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // `Zeroizing` already scrubs; this keeps the intent explicit and scrubs
        // any future non-Zeroizing representation too.
        self.0.zeroize();
    }
}

/// The master key, scrubbed on drop.
struct MasterKey(Zeroizing<[u8; 32]>);

impl MasterKey {
    fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Client-safe metadata for one stored credential. Never carries the value.
///
/// Beyond the identity fields it carries the Vellum-style *policy* metadata a
/// broker or prompt builder needs: the environment variable the secret is
/// exported under (`AMIRO_CRED_<SERVICE>_<FIELD>`), a human `usage_description`,
/// the tools the secret may be handed to, and the domains a brokered request may
/// target. None of this is secret material.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialMetadata {
    pub id: String,
    pub service: String,
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub hint: String,
    pub updated_at: String,
    /// `AMIRO_CRED_<SERVICE>_<FIELD>`: the name the value is injected under.
    pub env_var: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_domains: Vec<String>,
}

/// Uppercase an identifier fragment and replace every non-alphanumeric byte with
/// `_`, so it is safe to splice into an environment variable name. `github` ->
/// `GITHUB`, `tts.openai` -> `TTS_OPENAI`, `api-key` -> `API_KEY`.
pub fn sanitize_env_part(name: &str) -> String {
    name.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// The environment variable a credential is exported under, e.g. `github` +
/// `token` -> `AMIRO_CRED_GITHUB_TOKEN`, `tts.openai` + `api_key` ->
/// `AMIRO_CRED_TTS_OPENAI_API_KEY`.
pub fn env_var_name(service: &str, field: &str) -> String {
    format!(
        "AMIRO_CRED_{}_{}",
        sanitize_env_part(service),
        sanitize_env_part(field)
    )
}

/// The optional policy carried alongside a credential. Kept separate from the
/// client-facing [`CredentialMetadata`] so write paths can preserve it.
#[derive(Debug, Clone, Default)]
struct Policy {
    usage_description: Option<String>,
    allowed_tools: Vec<String>,
    allowed_domains: Vec<String>,
}

/// One sealed value, as persisted. `Debug` redacts the sealed material.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct StoredCredential {
    nonce: String,
    ciphertext: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(
        rename = "usageDescription",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    usage_description: Option<String>,
    #[serde(rename = "allowedTools", default, skip_serializing_if = "Vec::is_empty")]
    allowed_tools: Vec<String>,
    #[serde(
        rename = "allowedDomains",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    allowed_domains: Vec<String>,
}

impl std::fmt::Debug for StoredCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredCredential")
            .field("nonce", &"<redacted>")
            .field("ciphertext", &"<redacted>")
            .field("label", &self.label)
            .field("createdAt", &self.created_at)
            .field("updatedAt", &self.updated_at)
            .field("usageDescription", &self.usage_description)
            .field("allowedTools", &self.allowed_tools)
            .field("allowedDomains", &self.allowed_domains)
            .finish()
    }
}

/// Whether a name is a valid service/field identifier: `[a-z0-9._-]{1,64}`.
pub fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

/// The associated data binding a ciphertext to its logical slot.
pub fn associated_data(service: &str, field: &str) -> String {
    format!("{service}/{field}")
}

fn entry_key(service: &str, field: &str) -> String {
    format!("credential/{service}/{field}")
}

/// Mask a secret to its last four characters.
pub fn masked_hint(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 4 {
        return "••••".to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("••••{tail}")
}

pub fn protected_dir(state: &AppState) -> PathBuf {
    state.home.join(PROTECTED_DIR)
}

/// The encrypted store file, exposed for tests.
pub fn store_file(state: &AppState) -> PathBuf {
    protected_dir(state).join(STORE_FILE)
}

/// The master key file, exposed for tests.
pub fn key_file(state: &AppState) -> PathBuf {
    protected_dir(state).join(KEY_FILE)
}

fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    // Tighten an existing directory too: another process may have created it
    // with a looser mode before this store existed.
    set_mode(dir, 0o700)
}

fn read_key_bytes(path: &Path) -> std::io::Result<[u8; 32]> {
    let bytes = std::fs::read(path)?;
    if bytes.len() != 32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "store key is not 32 bytes",
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Return the master key, creating it atomically on first use. An existing key
/// is never overwritten or regenerated.
fn load_or_create_key(home: &Path) -> Result<MasterKey, ApiError> {
    let dir = home.join(PROTECTED_DIR);
    ensure_private_dir(&dir)?;
    let path = dir.join(KEY_FILE);
    match read_key_bytes(&path) {
        Ok(key) => return Ok(MasterKey(Zeroizing::new(key))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let mut generated = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut generated);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => {
            file.write_all(&generated)?;
            file.sync_all()?;
            set_mode(&path, 0o600)?;
            Ok(MasterKey(Zeroizing::new(generated)))
        }
        // Lost the creation race: the winner's key is the real one.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let key = read_key_bytes(&path)?;
            Ok(MasterKey(Zeroizing::new(key)))
        }
        Err(error) => Err(error.into()),
    }
}

/// Read the existing master key without creating one. Used by read-only callers
/// (for example the runtime environment) that must not bring a key into being.
fn load_existing_key(home: &Path) -> Option<MasterKey> {
    read_key_bytes(&home.join(PROTECTED_DIR).join(KEY_FILE))
        .ok()
        .map(|key| MasterKey(Zeroizing::new(key)))
}

fn encrypt(key: &[u8; 32], aad: &str, plaintext: &[u8]) -> Result<(String, String), ApiError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| internal("failed to encrypt credential"))?;
    Ok((BASE64.encode(nonce_bytes), BASE64.encode(ciphertext)))
}

/// Raw decrypt: returns `Err(())` on authentication failure so tests can assert
/// that a wrong AAD or a tampered ciphertext is rejected.
fn decrypt_raw(key: &[u8; 32], aad: &str, nonce_b64: &str, ct_b64: &str) -> Result<Vec<u8>, ()> {
    let nonce = BASE64.decode(nonce_b64).map_err(|_| ())?;
    if nonce.len() != 12 {
        return Err(());
    }
    let ciphertext = BASE64.decode(ct_b64).map_err(|_| ())?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| ())
}

fn decrypt(
    key: &[u8; 32],
    service: &str,
    field: &str,
    nonce_b64: &str,
    ct_b64: &str,
) -> Result<Secret, ApiError> {
    let aad = associated_data(service, field);
    let bytes = decrypt_raw(key, &aad, nonce_b64, ct_b64).map_err(|_| {
        internal("credential could not be decrypted (missing, tampered, or wrong key)")
    })?;
    let value = String::from_utf8(bytes).map_err(|_| internal("credential is not valid UTF-8"))?;
    Ok(Secret::new(value))
}

fn validate(service: &str, field: &str, value: &str) -> Result<(), ApiError> {
    if !is_valid_name(service) {
        return Err(bad_request("service must match [a-z0-9._-]{1,64}"));
    }
    if !is_valid_name(field) {
        return Err(bad_request("field must match [a-z0-9._-]{1,64}"));
    }
    if value.is_empty() {
        return Err(bad_request("value is required"));
    }
    if value.len() > MAX_VALUE_LEN {
        return Err(bad_request("value is too long (max 8192 bytes)"));
    }
    Ok(())
}

fn parse_store(document: Value) -> Result<Map<String, Value>, ApiError> {
    match document {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map),
        _ => Err(internal("credential store is not a JSON object")),
    }
}

fn stored_from(value: &Value) -> Result<StoredCredential, ApiError> {
    serde_json::from_value(value.clone())
        .map_err(|error| internal(&format!("invalid credential record: {error}")))
}

fn metadata_from(
    service: &str,
    field: &str,
    stored: &StoredCredential,
    key: &[u8; 32],
) -> Result<CredentialMetadata, ApiError> {
    let secret = decrypt(key, service, field, &stored.nonce, &stored.ciphertext)?;
    Ok(CredentialMetadata {
        id: format!("{service}/{field}"),
        service: service.to_string(),
        field: field.to_string(),
        label: stored.label.clone(),
        hint: masked_hint(secret.expose()),
        updated_at: stored.updated_at.clone(),
        env_var: env_var_name(service, field),
        usage_description: stored.usage_description.clone(),
        allowed_tools: stored.allowed_tools.clone(),
        allowed_domains: stored.allowed_domains.clone(),
    })
}

async fn load_document(state: &AppState) -> Result<Value, ApiError> {
    read_json(&store_file(state), json!({})).await
}

fn normalize_label(label: Option<&str>) -> Result<Option<String>, ApiError> {
    let label = label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty());
    if let Some(label) = &label {
        if label.len() > 256 {
            return Err(bad_request("label is too long (max 256 bytes)"));
        }
    }
    Ok(label)
}

/// Trim, cap and de-duplicate a policy list, dropping blanks silently.
fn clean_policy_list(items: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() || trimmed.len() > 256 {
            continue;
        }
        if !out.contains(&trimmed) {
            out.push(trimmed);
        }
    }
    out
}

fn normalize_policy(
    usage_description: Option<&str>,
    allowed_tools: Vec<String>,
    allowed_domains: Vec<String>,
) -> Result<Policy, ApiError> {
    let usage_description = usage_description
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(description) = &usage_description {
        if description.len() > 1024 {
            return Err(bad_request("usageDescription is too long (max 1024 bytes)"));
        }
    }
    Ok(Policy {
        usage_description,
        allowed_tools: clean_policy_list(allowed_tools),
        allowed_domains: clean_policy_list(allowed_domains),
    })
}

/// Read the policy already stored for a slot without creating a key or taking the
/// write lock. Used by [`set`] so a plain re-save cannot silently drop policy.
async fn read_policy(state: &AppState, service: &str, field: &str) -> Policy {
    if !is_valid_name(service) || !is_valid_name(field) {
        return Policy::default();
    }
    let Ok(document) = load_document(state).await else {
        return Policy::default();
    };
    let Ok(map) = parse_store(document) else {
        return Policy::default();
    };
    let Some(value) = map.get(&entry_key(service, field)) else {
        return Policy::default();
    };
    match stored_from(value) {
        Ok(stored) => Policy {
            usage_description: stored.usage_description,
            allowed_tools: stored.allowed_tools,
            allowed_domains: stored.allowed_domains,
        },
        Err(_) => Policy::default(),
    }
}

async fn write_credential(
    state: &AppState,
    service: &str,
    field: &str,
    value: &str,
    label: Option<&str>,
    policy: Policy,
) -> Result<CredentialMetadata, ApiError> {
    validate(service, field, value)?;
    let label = normalize_label(label)?;

    let _guard = state.store.lock().await;
    let key = load_or_create_key(&state.home)?;
    let mut document = load_document(state).await?;
    let mut map = parse_store(std::mem::replace(&mut document, Value::Null))?;

    let id = entry_key(service, field);
    let now = crate::state::now_iso();
    let created_at = map
        .get(&id)
        .and_then(|existing| existing.get("createdAt"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| now.clone());

    let aad = associated_data(service, field);
    let (nonce, ciphertext) = encrypt(key.bytes(), &aad, value.as_bytes())?;
    let stored = StoredCredential {
        nonce,
        ciphertext,
        label,
        created_at,
        updated_at: now,
        usage_description: policy.usage_description,
        allowed_tools: policy.allowed_tools,
        allowed_domains: policy.allowed_domains,
    };
    let stored_value = serde_json::to_value(&stored)?;
    map.insert(id, stored_value);

    write_json(&store_file(state), &Value::Object(map)).await?;
    sync_runtime_credential_env_logged(state);
    metadata_from(service, field, &stored, key.bytes())
}

/// Store (or replace) a credential. Returns client-safe metadata only. Any
/// policy already stored for the slot is preserved, so existing callers (Composio
/// migration, voice keys, GitHub migration) never wipe broker policy.
pub async fn set(
    state: &AppState,
    service: &str,
    field: &str,
    value: &str,
    label: Option<&str>,
) -> Result<CredentialMetadata, ApiError> {
    let policy = read_policy(state, service, field).await;
    write_credential(state, service, field, value, label, policy).await
}

/// Store (or replace) a credential together with its Vellum-style policy. The
/// supplied policy fully replaces whatever was stored for the slot.
pub async fn set_with_policy(
    state: &AppState,
    service: &str,
    field: &str,
    value: &str,
    label: Option<&str>,
    usage_description: Option<&str>,
    allowed_tools: Vec<String>,
    allowed_domains: Vec<String>,
) -> Result<CredentialMetadata, ApiError> {
    let policy = normalize_policy(usage_description, allowed_tools, allowed_domains)?;
    write_credential(state, service, field, value, label, policy).await
}

/// Snapshot every credential's client-safe metadata, newest updates first.
pub async fn list_metadata(state: &AppState) -> Result<Vec<CredentialMetadata>, ApiError> {
    let _guard = state.store.lock().await;
    let document = load_document(state).await?;
    let map = parse_store(document)?;
    let key = load_or_create_key(&state.home)?;

    let mut items = Vec::new();
    for (id, value) in &map {
        let Some((service, field)) = id
            .strip_prefix("credential/")
            .and_then(|rest| rest.split_once('/'))
        else {
            continue;
        };
        let stored = stored_from(value)?;
        items.push(metadata_from(service, field, &stored, key.bytes())?);
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    Ok(items)
}

/// Decrypt one credential for server-side use only. `None` when absent.
pub async fn get_plaintext(
    state: &AppState,
    service: &str,
    field: &str,
) -> Result<Option<Secret>, ApiError> {
    if !is_valid_name(service) || !is_valid_name(field) {
        return Ok(None);
    }
    let _guard = state.store.lock().await;
    let document = load_document(state).await?;
    let map = parse_store(document)?;
    let Some(value) = map.get(&entry_key(service, field)) else {
        return Ok(None);
    };
    let stored = stored_from(value)?;
    let key = load_or_create_key(&state.home)?;
    Ok(Some(decrypt(
        key.bytes(),
        service,
        field,
        &stored.nonce,
        &stored.ciphertext,
    )?))
}

/// Delete a credential. `true` when something was removed.
pub async fn delete(state: &AppState, service: &str, field: &str) -> Result<bool, ApiError> {
    if !is_valid_name(service) || !is_valid_name(field) {
        return Ok(false);
    }
    let _guard = state.store.lock().await;
    let document = load_document(state).await?;
    let mut map = parse_store(document)?;
    if map.remove(&entry_key(service, field)).is_none() {
        return Ok(false);
    }
    write_json(&store_file(state), &Value::Object(map)).await?;
    sync_runtime_credential_env_logged(state);
    Ok(true)
}

/// Strictly synchronous decrypt for callers that cannot await (the runtime
/// process environment). Never creates a key and never takes the store lock:
/// atomic renames make a concurrent read safe, and a lost update is picked up
/// by the next process start.
pub fn get_plaintext_sync(home: &Path, service: &str, field: &str) -> Option<Secret> {
    if !is_valid_name(service) || !is_valid_name(field) {
        return None;
    }
    let key = load_existing_key(home)?;
    let bytes = std::fs::read(home.join(PROTECTED_DIR).join(STORE_FILE)).ok()?;
    let document: Value = serde_json::from_slice(&bytes).ok()?;
    let map = document.as_object()?;
    let value = map.get(&entry_key(service, field))?;
    let stored = stored_from(value).ok()?;
    decrypt(
        key.bytes(),
        service,
        field,
        &stored.nonce,
        &stored.ciphertext,
    )
    .ok()
}

/// Split a store key `credential/<service>/<field>` into its parts.
fn split_entry_id(id: &str) -> Option<(&str, &str)> {
    id.strip_prefix("credential/")?.split_once('/')
}

/// Read the raw store document synchronously. Never creates the file or the key.
fn load_store_sync(home: &Path) -> Option<Map<String, Value>> {
    let bytes = std::fs::read(home.join(PROTECTED_DIR).join(STORE_FILE)).ok()?;
    let document: Value = serde_json::from_slice(&bytes).ok()?;
    document.as_object().cloned()
}

/// Synchronously list every credential's client-safe metadata (including policy
/// and the exported environment variable name). Never creates the master key, so
/// a process that has never stored a credential sees an empty catalog rather
/// than minting one. Used by the agent prompt/reminder builder.
pub fn list_metadata_sync(home: &Path) -> Vec<CredentialMetadata> {
    let Some(map) = load_store_sync(home) else {
        return Vec::new();
    };
    let Some(key) = load_existing_key(home) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for (id, value) in &map {
        let Some((service, field)) = split_entry_id(id) else {
            continue;
        };
        let Ok(stored) = stored_from(value) else {
            continue;
        };
        if let Ok(metadata) = metadata_from(service, field, &stored, key.bytes()) {
            items.push(metadata);
        }
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    items
}

/// Synchronously decrypt every credential for injection into a runtime process
/// environment, returning `(env_var, plaintext)` pairs. Never creates a key.
///
/// Also exposes well-known aliases (for example `github/token` also becomes
/// `GITHUB_TOKEN` and `GH_TOKEN`) when those names are not already present, so
/// tools that read the conventional variable keep working without the model
/// ever seeing the secret in its prompt or transcript.
pub fn runtime_env_vars_sync(home: &Path) -> Vec<(String, String)> {
    let Some(map) = load_store_sync(home) else {
        return Vec::new();
    };
    let Some(key) = load_existing_key(home) else {
        return Vec::new();
    };

    let mut pairs: Vec<(String, String)> = Vec::new();
    for (id, value) in &map {
        let Some((service, field)) = split_entry_id(id) else {
            continue;
        };
        let Ok(stored) = stored_from(value) else {
            continue;
        };
        let Ok(secret) = decrypt(key.bytes(), service, field, &stored.nonce, &stored.ciphertext)
        else {
            continue;
        };
        pairs.push((env_var_name(service, field), secret.expose().to_string()));
    }

    // Well-known aliases. Only added when nothing already defines the name.
    if let Some((_, token)) = pairs
        .iter()
        .find(|(key, _)| key == "AMIRO_CRED_GITHUB_TOKEN")
        .cloned()
    {
        for alias in ["GITHUB_TOKEN", "GH_TOKEN"] {
            let already_present = pairs.iter().any(|(key, _)| key == alias);
            if !already_present && std::env::var(alias).is_err() {
                pairs.push((alias.to_string(), token.clone()));
            }
        }
    }

    pairs
}

/// File the runtime reads (`$AMIRO_RUNTIME_HOME/credential-env.json`) to
/// resolve `${VAR}` placeholders in `mcp.json` without a restart.
pub fn credential_env_file(state: &AppState) -> PathBuf {
    state.runtime_home.join("credential-env.json")
}

/// Write every exported credential env var (`runtime_env_vars_sync`) to
/// `credential-env.json` as a flat `name -> value` object, atomically with 0600
/// permissions. Never takes the store lock (the sync reader does not either).
pub fn sync_runtime_credential_env(state: &AppState) -> std::io::Result<()> {
    let mut object = Map::new();
    for (name, value) in runtime_env_vars_sync(&state.home) {
        object.insert(name, Value::String(value));
    }
    let dir = state.runtime_home.clone();
    std::fs::create_dir_all(&dir)?;
    let target = credential_env_file(state);
    let temporary = dir.join(format!(".amiro-credenv-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        let mut bytes = serde_json::to_vec_pretty(&Value::Object(object))
            .map_err(std::io::Error::other)?;
        bytes.push(b'\n');
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Best-effort wrapper: a failed export must not fail the credential write.
pub fn sync_runtime_credential_env_logged(state: &AppState) {
    if let Err(error) = sync_runtime_credential_env(state) {
        tracing::warn!("could not sync runtime credential-env.json: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn fixture() -> (AppState, PathBuf) {
        let root = std::env::temp_dir().join(format!("amiro-cred-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let state = AppState {
            home,
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("amiro-api.sock"),
            workspace: root.join("workspace"),
            runtime_bin: root.join("amiro-runtime"),
            token: String::new(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        };
        (state, root)
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn names_are_validated() {
        assert!(is_valid_name("composio"));
        assert!(is_valid_name("api_key"));
        assert!(is_valid_name("openai.api-key_1"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("Upper"));
        assert!(!is_valid_name("with space"));
        assert!(!is_valid_name("slash/inside"));
        assert!(!is_valid_name(&"a".repeat(65)));
        assert!(is_valid_name(&"a".repeat(64)));
    }

    #[tokio::test]
    async fn roundtrip_and_metadata() {
        let (state, root) = fixture();
        let metadata = set(
            &state,
            "composio",
            "api_key",
            "sk-secret-1234",
            Some("Composio"),
        )
        .await
        .unwrap();
        assert_eq!(metadata.id, "composio/api_key");
        assert_eq!(metadata.service, "composio");
        assert_eq!(metadata.field, "api_key");
        assert_eq!(metadata.label.as_deref(), Some("Composio"));
        assert_eq!(metadata.hint, "••••1234");

        let secret = get_plaintext(&state, "composio", "api_key")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(secret.expose(), "sk-secret-1234");

        let listed = list_metadata(&state).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].hint, "••••1234");

        // Replacing keeps createdAt and updates the value.
        set(
            &state,
            "composio",
            "api_key",
            "sk-rotated-5678",
            Some("Composio"),
        )
        .await
        .unwrap();
        let secret = get_plaintext(&state, "composio", "api_key")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(secret.expose(), "sk-rotated-5678");

        assert!(delete(&state, "composio", "api_key").await.unwrap());
        assert!(!delete(&state, "composio", "api_key").await.unwrap());
        assert!(get_plaintext(&state, "composio", "api_key")
            .await
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn wrong_aad_is_rejected() {
        let key = [7u8; 32];
        let (nonce, ct) = encrypt(&key, "composio/api_key", b"top-secret").unwrap();
        assert!(decrypt_raw(&key, "composio/api_key", &nonce, &ct).is_ok());
        assert!(decrypt_raw(&key, "other/api_key", &nonce, &ct).is_err());
        assert!(decrypt_raw(&key, "composio/other", &nonce, &ct).is_err());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let key = [9u8; 32];
        let (nonce, ct) = encrypt(&key, "composio/api_key", b"top-secret").unwrap();
        let mut raw = BASE64.decode(&ct).unwrap();
        raw[0] ^= 0x01;
        let tampered = BASE64.encode(&raw);
        assert!(decrypt_raw(&key, "composio/api_key", &nonce, &tampered).is_err());
        // A different key cannot open it either.
        let other = [10u8; 32];
        assert!(decrypt_raw(&other, "composio/api_key", &nonce, &ct).is_err());
    }

    #[tokio::test]
    async fn files_are_private_and_key_is_stable() {
        let (state, root) = fixture();
        set(&state, "composio", "api_key", "sk-value-0001", None)
            .await
            .unwrap();
        let key_a = std::fs::read(key_file(&state)).unwrap();
        #[cfg(unix)]
        {
            assert_eq!(mode_of(&protected_dir(&state)), 0o700);
            assert_eq!(mode_of(&key_file(&state)), 0o600);
            assert_eq!(mode_of(&store_file(&state)), 0o600);
        }
        set(&state, "other", "token", "sk-value-0002", None)
            .await
            .unwrap();
        let key_b = std::fs::read(key_file(&state)).unwrap();
        assert_eq!(key_a, key_b, "master key must not be regenerated");
        assert_eq!(key_a.len(), 32);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn plaintext_never_hits_the_disk() {
        let (state, root) = fixture();
        let secret = "sk-super-secret-value-9999";
        set(&state, "composio", "api_key", secret, Some("label"))
            .await
            .unwrap();
        let on_disk = std::fs::read(store_file(&state)).unwrap();
        let text = String::from_utf8_lossy(&on_disk);
        assert!(!text.contains(secret), "store file leaked plaintext");
        // The JSON document structurally exposes only sealed fields.
        let document: Value = serde_json::from_slice(&on_disk).unwrap();
        let entry = &document["credential/composio/api_key"];
        assert!(entry["nonce"].is_string());
        assert!(entry["ciphertext"].is_string());
        assert!(entry.get("value").is_none());
        let rendered = format!("{:?}", stored_from(entry).unwrap());
        assert!(!rendered.contains(secret));
        assert!(rendered.contains("redacted"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn secret_debug_redacts_and_validation_rejects_bad_input() {
        let secret = Secret::new("sk-do-not-print".to_string());
        assert_eq!(format!("{secret:?}"), "Secret(<redacted>)");
        let (state, root) = fixture();
        assert!(set(&state, "Bad Name", "api_key", "x", None).await.is_err());
        assert!(set(&state, "composio", "api_key", "", None).await.is_err());
        assert!(set(
            &state,
            "composio",
            "api_key",
            &"x".repeat(MAX_VALUE_LEN + 1),
            None
        )
        .await
        .is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn sync_read_matches_async_read() {
        let (state, root) = fixture();
        set(&state, "composio", "api_key", "sk-sync-4321", None)
            .await
            .unwrap();
        let secret = get_plaintext_sync(&state.home, "composio", "api_key").unwrap();
        assert_eq!(secret.expose(), "sk-sync-4321");
        assert!(get_plaintext_sync(&state.home, "composio", "missing").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn env_var_names_are_derived_from_the_slot() {
        assert_eq!(env_var_name("github", "token"), "AMIRO_CRED_GITHUB_TOKEN");
        assert_eq!(
            env_var_name("composio", "api_key"),
            "AMIRO_CRED_COMPOSIO_API_KEY"
        );
        assert_eq!(
            env_var_name("tts.openai", "api_key"),
            "AMIRO_CRED_TTS_OPENAI_API_KEY"
        );
        assert_eq!(env_var_name("api-key", "x"), "AMIRO_CRED_API_KEY_X");
        assert_eq!(sanitize_env_part("MiXeD.dot-dash_under"), "MIXED_DOT_DASH_UNDER");
    }

    #[tokio::test]
    async fn policy_metadata_roundtrips() {
        let (state, root) = fixture();
        let metadata = set_with_policy(
            &state,
            "github",
            "token",
            "ghp-secret-4321",
            Some("GitHub PAT"),
            Some("Call the GitHub REST API"),
            vec!["bash".to_string(), "http".to_string(), "bash".to_string()],
            vec!["api.github.com".to_string(), "*.github.com".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(metadata.env_var, "AMIRO_CRED_GITHUB_TOKEN");
        assert_eq!(
            metadata.usage_description.as_deref(),
            Some("Call the GitHub REST API")
        );
        assert_eq!(metadata.allowed_tools, vec!["bash", "http"]);
        assert_eq!(
            metadata.allowed_domains,
            vec!["api.github.com", "*.github.com"]
        );

        let listed = list_metadata(&state).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].env_var, "AMIRO_CRED_GITHUB_TOKEN");
        assert_eq!(listed[0].allowed_domains.len(), 2);

        // The synchronous catalog agrees, and the plaintext never leaks.
        let sync = list_metadata_sync(&state.home);
        assert_eq!(sync.len(), 1);
        assert_eq!(sync[0].usage_description.as_deref(), Some("Call the GitHub REST API"));
        assert!(!serde_json::to_string(&sync[0]).unwrap().contains("ghp-secret"));

        // A plain `set` preserves policy for the slot.
        let plain = set(&state, "github", "token", "ghp-rotated-9999", None)
            .await
            .unwrap();
        assert_eq!(plain.allowed_domains.len(), 2);
        assert_eq!(
            plain.usage_description.as_deref(),
            Some("Call the GitHub REST API")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn runtime_env_vars_include_aliases_and_never_create_a_key() {
        // No store yet: reading must not mint a key or a file.
        let (state, root) = fixture();
        assert!(runtime_env_vars_sync(&state.home).is_empty());
        assert!(!key_file(&state).exists());
        assert!(!store_file(&state).exists());

        set(&state, "github", "token", "ghp-alias-1234", None)
            .await
            .unwrap();
        set_with_policy(
            &state,
            "tts.openai",
            "api_key",
            "sk-tts-5678",
            None,
            None,
            vec![],
            vec![],
        )
        .await
        .unwrap();

        let pairs = runtime_env_vars_sync(&state.home);
        let find = |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(find("AMIRO_CRED_GITHUB_TOKEN").as_deref(), Some("ghp-alias-1234"));
        assert_eq!(find("GITHUB_TOKEN").as_deref(), Some("ghp-alias-1234"));
        assert_eq!(find("GH_TOKEN").as_deref(), Some("ghp-alias-1234"));
        assert_eq!(find("AMIRO_CRED_TTS_OPENAI_API_KEY").as_deref(), Some("sk-tts-5678"));

        // metadata_sync and env export agree on the variable names.
        let names: Vec<String> = list_metadata_sync(&state.home)
            .into_iter()
            .map(|item| item.env_var)
            .collect();
        assert!(names.contains(&"AMIRO_CRED_GITHUB_TOKEN".to_string()));
        assert!(names.contains(&"AMIRO_CRED_TTS_OPENAI_API_KEY".to_string()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn credential_env_file_tracks_set_and_delete() {
        let (state, root) = fixture();
        set(&state, "mcp.my-server", "authorization", "Bearer abc", None)
            .await
            .unwrap();
        let file = credential_env_file(&state);
        let read = || -> Value { serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap() };
        assert_eq!(
            read()["AMIRO_CRED_MCP_MY_SERVER_AUTHORIZATION"],
            "Bearer abc"
        );
        #[cfg(unix)]
        assert_eq!(mode_of(&file), 0o600);
        assert!(delete(&state, "mcp.my-server", "authorization").await.unwrap());
        assert!(read().get("AMIRO_CRED_MCP_MY_SERVER_AUTHORIZATION").is_none());
        let _ = std::fs::remove_dir_all(root);
    }
}
