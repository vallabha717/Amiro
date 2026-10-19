//! Native account authentication, compatible with existing scrypt password hashes.
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post, put},
    Json, Router,
};
use chrono::Utc;
use rand::RngCore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use subtle::ConstantTimeEq;

/// Amiro is a single-owner application. The owner account is created either by
/// the first-run setup form or, for headless provisioning, from
/// `AMIRO_OWNER_EMAIL` + `AMIRO_OWNER_PASSWORD` (or `AMIRO_OWNER_PASSWORD_FILE`)
/// when the user store is still empty. There is no sign-up and no second owner.
const MIN_PASSWORD_LENGTH: usize = 12;
const MAX_PASSWORD_LENGTH: usize = 4096;
const MAX_IDENTIFIER_LENGTH: usize = 320;
const LOGIN_ATTEMPT_LIMIT: usize = 15;
const LOGIN_WINDOW_MS: i64 = 15 * 60 * 1000;

fn failure(status: StatusCode, message: &str) -> ApiError {
    ApiError(status, message.into())
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut value);
    hex::encode(value)
}
fn users_array(doc: &Value) -> Result<&Vec<Value>, ApiError> {
    doc.get("users").and_then(Value::as_array).ok_or_else(|| {
        failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid users database, refusing to replace existing accounts",
        )
    })
}

pub fn public_user(user: &Value) -> Value {
    let mut public = serde_json::Map::new();
    for key in [
        "id",
        "name",
        "email",
        "role",
        "image",
        "createdAt",
        "lastLogin",
    ] {
        public.insert(key.into(), user.get(key).cloned().unwrap_or(Value::Null));
    }
    Value::Object(public)
}

/// Node crypto.scrypt uses the ASCII salt string, not its decoded hex bytes.
async fn derive(password: String, salt: String) -> Result<Vec<u8>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let params = scrypt::Params::new(14, 8, 1, 64).map_err(|_| {
            failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid password derivation parameters",
            )
        })?;
        let mut key = vec![0u8; 64];
        scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut key).map_err(|_| {
            failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "password derivation failed",
            )
        })?;
        Ok(key)
    })
    .await
    .map_err(|_| failure(StatusCode::INTERNAL_SERVER_ERROR, "password worker failed"))?
}

pub async fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = random_hex(16);
    let hash = derive(password.into(), salt.clone()).await?;
    Ok(format!("{salt}:{}", hex::encode(hash)))
}

pub async fn verify_password(password: &str, stored: &str) -> Result<bool, ApiError> {
    if password.len() > MAX_PASSWORD_LENGTH {
        return Ok(false);
    }
    let Some((salt, encoded)) = stored.split_once(':') else {
        return Ok(false);
    };
    if salt.len() > 256 {
        return Ok(false);
    }
    let Ok(expected) = hex::decode(encoded) else {
        return Ok(false);
    };
    if expected.len() != 64 {
        return Ok(false);
    }
    let actual = derive(password.into(), salt.into()).await?;
    Ok(bool::from(actual.as_slice().ct_eq(expected.as_slice())))
}

/// The owner's login identifier is an email or a username; either is stored in
/// the `email` field and matched case-insensitively at login.
fn identifier(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_LENGTH
        || value.chars().any(char::is_control)
    {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "a valid email or username is required",
        ));
    }
    Ok(value.to_string())
}

/// A basic strength check for locally chosen owner passwords: at least 12
/// characters, with a letter and at least one number or symbol.
pub fn validate_password(password: &str) -> Result<(), ApiError> {
    if password.len() < MIN_PASSWORD_LENGTH {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "password must be at least 12 characters",
        ));
    }
    if password.len() > MAX_PASSWORD_LENGTH {
        return Err(failure(StatusCode::BAD_REQUEST, "password is too long"));
    }
    let has_letter = password.chars().any(|c| c.is_alphabetic());
    let has_number = password.chars().any(|c| c.is_ascii_digit());
    let has_symbol = password.chars().any(|c| !c.is_alphanumeric());
    if !(has_letter && (has_number || has_symbol)) {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "password must include a letter and at least one number or symbol",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Sign-in rate limiting
//
// The owner account is the only one that can exist, so an unauthenticated
// attacker has exactly one target. Bound brute-force attempts per identifier
// over a rolling window. In-memory is sufficient: the whole app is one process
// on one host, and a restart clearing the counter grants nothing an attacker
// did not already have.
// ---------------------------------------------------------------------------

struct LoginAttempts {
    count: usize,
    until: i64,
}

fn login_attempts() -> &'static Mutex<HashMap<String, LoginAttempts>> {
    static ATTEMPTS: OnceLock<Mutex<HashMap<String, LoginAttempts>>> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn login_allowed(key: &str) -> bool {
    let now = Utc::now().timestamp_millis();
    let mut attempts = login_attempts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    attempts.retain(|_, entry| entry.until > now);
    let entry = attempts.entry(key.to_string()).or_insert(LoginAttempts {
        count: 0,
        until: now + LOGIN_WINDOW_MS,
    });
    entry.count += 1;
    entry.count <= LOGIN_ATTEMPT_LIMIT
}

/// Headless provisioning: create the owner at boot when both the email and a
/// password source are present and the store is still empty.
fn owner_credentials() -> Result<Option<(String, String)>, ApiError> {
    let Some(email) = std::env::var("AMIRO_OWNER_EMAIL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let password = match std::env::var("AMIRO_OWNER_PASSWORD") {
        Ok(value) if !value.is_empty() => value,
        _ => match std::env::var("AMIRO_OWNER_PASSWORD_FILE") {
            Ok(path) if !path.trim().is_empty() => {
                let contents = std::fs::read_to_string(path.trim()).map_err(|error| {
                    failure(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        &format!("AMIRO_OWNER_PASSWORD_FILE could not be read: {error}"),
                    )
                })?;
                contents.trim_end_matches(['\n', '\r']).to_string()
            }
            _ => return Ok(None),
        },
    };
    if password.is_empty() {
        return Ok(None);
    }
    if let Err(error) = validate_password(&password) {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            &format!("AMIRO_OWNER_PASSWORD is not strong enough: {}", error.1),
        ));
    }
    Ok(Some((email, password)))
}

pub async fn init(state: &AppState) -> Result<(), ApiError> {
    tokio::fs::create_dir_all(&state.home).await?;
    tokio::fs::create_dir_all(&state.workspace).await?;
    let owner = owner_credentials()?;
    let _guard = state.store.lock().await;
    let file = state.home.join("users.json");
    let mut document = read_json(&file, json!({"users":[]})).await?;
    // Check all persisted account state before provisioning the owner.
    let sessions = read_json(&state.home.join("sessions.json"), json!({"sessions":{}})).await?;
    if !sessions["sessions"].is_object() {
        return Err(failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid sessions database",
        ));
    }
    if users_array(&document)?.is_empty() {
        if let Some((email, password)) = owner {
            let email = identifier(&email)?;
            let timestamp = now();
            let name = std::env::var("AMIRO_OWNER_NAME").map(Value::String).unwrap_or(Value::Null);
            let user = json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "name": body_name_or_owner(name),
                "email": email,
                "role": "admin",
                "passwordHash": hash_password(&password).await?,
                "createdAt": timestamp,
                "lastLogin": Value::Null
            });
            tracing::info!(%email, "provisioned the owner account from AMIRO_OWNER_EMAIL/AMIRO_OWNER_PASSWORD");
            document["users"] = json!([user]);
            write_json(&file, &document).await?;
            if let Ok(tz) = std::env::var("AMIRO_OWNER_TIMEZONE") {
                let uid = user["id"].as_str().unwrap_or_default();
                if let Err(error) = crate::onboarding::save_timezone(state, uid, tz.trim()).await {
                    tracing::warn!(error = %error.1, "AMIRO_OWNER_TIMEZONE ignored");
                }
            }
        }
    }
    Ok(())
}

/// Rename an account (onboarding's profile step).
pub async fn set_user_name(state: &AppState, user_id: &str, name: &str) -> Result<(), ApiError> {
    let _guard = state.store.lock().await;
    let file = state.home.join("users.json");
    let mut document = read_json(&file, json!({"users":[]})).await?;
    let users = document["users"]
        .as_array_mut()
        .ok_or_else(|| failure(StatusCode::INTERNAL_SERVER_ERROR, "invalid users database"))?;
    let user = users
        .iter_mut()
        .find(|u| u["id"] == user_id)
        .ok_or_else(|| failure(StatusCode::NOT_FOUND, "account not found"))?;
    user["name"] = json!(body_name_or_owner(json!(name)));
    write_json(&file, &document).await
}

/// Offline recovery (`amiro-backend reset-password`): set the owner's
/// password, optionally its login, and sign out every session. Creates the
/// owner when none exists yet. Returns the login identifier.
pub async fn reset_owner_password(
    state: &AppState,
    new_identifier: Option<&str>,
    password: &str,
) -> Result<String, ApiError> {
    validate_password(password)?;
    let new_identifier = new_identifier.map(identifier).transpose()?;
    let hash = hash_password(password).await?;
    let _guard = state.store.lock().await;
    tokio::fs::create_dir_all(&state.home).await?;
    let file = state.home.join("users.json");
    let mut document = read_json(&file, json!({"users":[]})).await?;
    users_array(&document)?;
    let users = document["users"].as_array_mut().expect("checked above");
    let login = if let Some(owner) = users
        .iter_mut()
        .find(|u| u["role"] == "admin")
    {
        if let Some(id) = &new_identifier {
            owner["email"] = json!(id);
        }
        owner["passwordHash"] = json!(hash);
        owner["email"].as_str().unwrap_or_default().to_string()
    } else {
        let login = new_identifier.unwrap_or_else(|| "owner".to_string());
        users.push(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "name": body_name_or_owner(Value::Null),
            "email": login,
            "role": "admin",
            "passwordHash": hash,
            "createdAt": now(),
            "lastLogin": Value::Null
        }));
        login
    };
    write_json(&file, &document).await?;
    write_json(&state.home.join("sessions.json"), &json!({"sessions":{}})).await?;
    // A stale bootstrap password file would only mislead.
    let _ = tokio::fs::remove_file(state.home.join("admin-initial-password")).await;
    Ok(login)
}

fn body_name_or_owner(body: Value) -> String {
    body.as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Owner")
        .chars()
        .take(128)
        .collect()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let header = headers.get("authorization")?.to_str().ok()?;
    let (scheme, token) = header.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty()).then_some(token.trim())
}

fn expired(session: &Value) -> bool {
    let days = std::env::var("AMIRO_SESSION_TTL_DAYS")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(7.0);
    expired_with_ttl(session, days)
}

fn expired_with_ttl(session: &Value, days: f64) -> bool {
    if days <= 0.0 {
        return false;
    }
    let Some(created) = session["createdAt"]
        .as_str()
        .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
    else {
        return true;
    };
    (Utc::now().timestamp_millis() - created.timestamp_millis()) as f64 > days * 86_400_000.0
}

pub async fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Value, ApiError> {
    let token = bearer(headers)
        .ok_or_else(|| failure(StatusCode::UNAUTHORIZED, "authentication required"))?;
    let document = read_json(&state.home.join("sessions.json"), json!({"sessions":{}})).await?;
    let session = &document["sessions"][token];
    if session.is_null() || expired(session) {
        return Err(failure(
            StatusCode::UNAUTHORIZED,
            "invalid or expired session",
        ));
    }
    let user_id = session["userId"]
        .as_str()
        .ok_or_else(|| failure(StatusCode::UNAUTHORIZED, "invalid session"))?;
    let users = read_json(&state.home.join("users.json"), json!({"users":[]})).await?;
    users_array(&users)?
        .iter()
        .find(|user| user["id"] == user_id)
        .cloned()
        .ok_or_else(|| failure(StatusCode::UNAUTHORIZED, "invalid session"))
}

async fn issue_token(state: &AppState, user_id: &str) -> Result<String, ApiError> {
    let token = random_hex(32);
    let file = state.home.join("sessions.json");
    let mut document = read_json(&file, json!({"sessions":{}})).await?;
    if !document["sessions"].is_object() {
        return Err(failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid sessions database",
        ));
    }
    document["sessions"][&token] = json!({"userId":user_id,"createdAt":now()});
    write_json(&file, &document).await?;
    Ok(token)
}

async fn status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let document = read_json(&state.home.join("users.json"), json!({"users":[]})).await?;
    let needs_setup = users_array(&document)?.is_empty();
    // `isFirstUser` is retained as an alias so older clients keep working.
    // `mode` lets the first-run wizard say where Amiro is running
    // (desktop / this computer / a server); nothing account-specific.
    let mode = crate::routes::system::deployment_info()["mode"].clone();
    Ok(Json(
        json!({"needsSetup": needs_setup, "isFirstUser": needs_setup, "mode": mode}),
    ))
}

/// Create the one owner account. This is the only account-creation path, it
/// requires an empty user store, and it holds the store lock across the
/// emptiness check and the write so two concurrent setup requests cannot both
/// succeed. Once any user exists it answers 403 forever.
async fn setup(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let email = identifier(body["email"].as_str().unwrap_or(""))?;
    let password = body["password"].as_str().unwrap_or("");
    validate_password(password)?;
    let name = body_name_or_owner(body.get("name").cloned().unwrap_or(Value::Null));
    let timezone = body["timezone"]
        .as_str()
        .map(str::trim)
        .filter(|tz| crate::onboarding::valid_timezone(tz))
        .map(str::to_string);
    let _guard = state.store.lock().await;
    let file = state.home.join("users.json");
    let mut document = read_json(&file, json!({"users":[]})).await?;
    if !users_array(&document)?.is_empty() {
        return Err(failure(
            StatusCode::FORBIDDEN,
            "setup has already been completed",
        ));
    }
    let timestamp = now();
    let user = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "name": name,
        "email": email,
        "role": "admin",
        "passwordHash": hash_password(password).await?,
        "createdAt": timestamp,
        "lastLogin": timestamp
    });
    document["users"] = json!([user]);
    write_json(&file, &document).await?;
    let token = issue_token(
        &state,
        user["id"]
            .as_str()
            .ok_or_else(|| failure(StatusCode::INTERNAL_SERVER_ERROR, "account has no id"))?,
    )
    .await?;
    drop(_guard);
    // Before seeding, so USER.md is written with the owner's timezone.
    if let (Some(tz), Some(uid)) = (&timezone, user["id"].as_str()) {
        crate::onboarding::save_timezone(&state, uid, tz).await?;
    }
    // Seed the agent home (SOUL/USER/NOW/HEARTBEAT, first-run BOOTSTRAP).
    let seed_state = state.clone();
    tokio::spawn(async move {
        crate::agent_home::seed(&seed_state).await;
        crate::agent::ensure_owner_identity_file(&seed_state).await;
        crate::onboarding::apply_config(&seed_state).await;
    });
    Ok(Json(json!({"user":public_user(&user),"token":token})))
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let email = body["email"].as_str().unwrap_or("").trim();
    let password = body["password"].as_str().unwrap_or("");
    if !login_allowed(&email.to_ascii_lowercase()) {
        return Err(failure(
            StatusCode::TOO_MANY_REQUESTS,
            "too many login attempts, try again in 15 minutes",
        ));
    }
    let _guard = state.store.lock().await;
    let file = state.home.join("users.json");
    let mut document = read_json(&file, json!({"users":[]})).await?;
    let index = users_array(&document)?.iter().position(|user| {
        user["email"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(email))
    });
    let Some(index) = index else {
        return Err(failure(
            StatusCode::UNAUTHORIZED,
            "invalid email or password",
        ));
    };
    if !verify_password(
        password,
        document["users"][index]["passwordHash"]
            .as_str()
            .unwrap_or(""),
    )
    .await?
    {
        return Err(failure(
            StatusCode::UNAUTHORIZED,
            "invalid email or password",
        ));
    }
    document["users"][index]["lastLogin"] = Value::String(now());
    let user = public_user(&document["users"][index]);
    write_json(&file, &document).await?;
    let token = issue_token(
        &state,
        user["id"]
            .as_str()
            .ok_or_else(|| failure(StatusCode::INTERNAL_SERVER_ERROR, "account has no id"))?,
    )
    .await?;
    Ok(Json(json!({"user":user,"token":token})))
}

/// Change the owner's login email and/or password. Requires the current
/// password and invalidates every other session for the account.
async fn change_credentials(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let current_password = body["currentPassword"].as_str().unwrap_or("");
    let new_email = body["newEmail"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(identifier)
        .transpose()?;
    let new_password = body["newPassword"]
        .as_str()
        .filter(|value| !value.is_empty());
    if current_password.is_empty() {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "currentPassword is required",
        ));
    }
    if new_email.is_none() && new_password.is_none() {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "provide a new email or password",
        ));
    }
    if let Some(password) = new_password {
        validate_password(password)?;
    }
    let uid = user.0["id"].as_str().unwrap_or("").to_string();
    let current_token = bearer(&headers).map(str::to_string);
    let _guard = state.store.lock().await;
    let users_file = state.home.join("users.json");
    let mut document = read_json(&users_file, json!({"users":[]})).await?;
    let index = users_array(&document)?
        .iter()
        .position(|candidate| candidate["id"] == uid.as_str())
        .ok_or_else(|| failure(StatusCode::UNAUTHORIZED, "account no longer exists"))?;
    let stored = document["users"][index]["passwordHash"]
        .as_str()
        .unwrap_or("")
        .to_string();
    if !verify_password(current_password, &stored).await? {
        return Err(failure(
            StatusCode::UNAUTHORIZED,
            "current password is incorrect",
        ));
    }
    if let Some(email) = new_email {
        let taken = document["users"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .enumerate()
            .any(|(other, candidate)| {
                other != index
                    && candidate["email"]
                        .as_str()
                        .is_some_and(|value| value.eq_ignore_ascii_case(&email))
            });
        if taken {
            return Err(failure(
                StatusCode::CONFLICT,
                "that email or username is already in use",
            ));
        }
        document["users"][index]["email"] = json!(email);
    }
    if let Some(password) = new_password {
        document["users"][index]["passwordHash"] = json!(hash_password(password).await?);
        document["users"][index]["mustChangePassword"] = json!(false);
    }
    document["users"][index]["updatedAt"] = json!(now());
    let updated = public_user(&document["users"][index]);
    write_json(&users_file, &document).await?;
    let sessions_file = state.home.join("sessions.json");
    let mut sessions = read_json(&sessions_file, json!({"sessions":{}})).await?;
    if let Some(map) = sessions["sessions"].as_object_mut() {
        map.retain(|token, session| {
            session["userId"].as_str() != Some(uid.as_str())
                || current_token.as_deref() == Some(token.as_str())
        });
    }
    write_json(&sessions_file, &sessions).await?;
    Ok(Json(json!({"user": updated})))
}

async fn session(AuthUser(user): AuthUser) -> Json<Value> {
    Json(public_user(&user))
}
async fn logout(
    State(state): State<AppState>,
    _user: AuthUser,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    if let Some(token) = bearer(&headers) {
        let _guard = state.store.lock().await;
        let file = state.home.join("sessions.json");
        let mut document = read_json(&file, json!({"sessions":{}})).await?;
        if let Some(sessions) = document["sessions"].as_object_mut() {
            sessions.remove(token);
        }
        write_json(&file, &document).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/setup", post(setup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/session", get(session))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/credentials", put(change_credentials))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state(home: &std::path::Path) -> AppState {
        AppState {
            runtime_home: home.join("runtime"),
            runtime_socket: home.join("runtime.sock"),
            workspace: home.join("workspace"),
            runtime_bin: "amiro".into(),
            token: String::new(),
            store: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            home: home.to_path_buf(),
        }
    }

    #[tokio::test]
    async fn startup_preserves_existing_accounts_and_rejects_corruption() {
        let home = std::env::temp_dir().join(format!("amiro-auth-test-{}", uuid::Uuid::new_v4()));
        let state = test_state(&home);
        let file = home.join("users.json");
        let account = json!({"users":[{"id":"existing-user","email":"member@example.test","role":"user","passwordHash":"existing:untouched"}]});
        write_json(&file, &account).await.unwrap();
        let original = tokio::fs::read(&file).await.unwrap();
        init(&state).await.unwrap();
        assert_eq!(tokio::fs::read(&file).await.unwrap(), original);
        assert!(!home.join("admin-initial-password").exists());
        tokio::fs::write(&file, "corrupt existing state")
            .await
            .unwrap();
        assert!(init(&state).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(&file).await.unwrap(),
            "corrupt existing state"
        );
        tokio::fs::remove_dir_all(home).await.unwrap();
    }

    #[tokio::test]
    async fn startup_on_an_empty_store_creates_no_credentials_file() {
        let home = std::env::temp_dir().join(format!("amiro-auth-test-{}", uuid::Uuid::new_v4()));
        let state = test_state(&home);
        init(&state).await.unwrap();
        // No generated password: first-run setup owns owner creation.
        assert!(!home.join("admin-initial-password").exists());
        let document = read_json(&home.join("users.json"), json!({"users":[]}))
            .await
            .unwrap();
        assert!(users_array(&document).unwrap().is_empty());
        tokio::fs::remove_dir_all(home).await.unwrap();
    }

    #[test]
    fn password_strength_is_enforced() {
        assert!(validate_password("short1A").is_err());
        assert!(validate_password("onlyletterslonger").is_err());
        assert!(validate_password("123456789012").is_err());
        assert!(validate_password("correct-horse-battery").is_ok());
        assert!(validate_password("twelvechars1").is_ok());
    }

    #[tokio::test]
    async fn verifies_independent_node_scrypt_fixture() {
        // Node crypto.scryptSync(password, salt, 64), with its default N/r/p.
        let hash = concat!(
            "00112233445566778899aabbccddeeff:",
            "f51ee0da4a541e7d7dd6e851b071219989a3165875af69d8e93b5c374ddde51f",
            "efa3e83a2b83e3390af39caf832baeac9d46c463da2c354f39c14f7539072d21"
        );
        assert!(verify_password("amiro-interop-test", hash).await.unwrap());
    }

    #[tokio::test]
    async fn password_hash_roundtrip_and_malformed_rejection() {
        let hash = hash_password("native-test-only").await.unwrap();
        assert!(verify_password("native-test-only", &hash).await.unwrap());
        assert!(!verify_password("wrong", &hash).await.unwrap());
        assert!(!verify_password("native-test-only", "corrupt")
            .await
            .unwrap());
    }

    #[test]
    fn malformed_session_timestamp_fails_closed() {
        assert!(expired_with_ttl(
            &json!({"createdAt":"not a timestamp"}),
            7.0
        ));
    }

    #[test]
    fn identifiers_accept_emails_and_usernames_and_reject_junk() {
        assert_eq!(identifier(" owner@example.test ").unwrap(), "owner@example.test");
        assert_eq!(identifier("owner").unwrap(), "owner");
        assert!(identifier("").is_err());
        assert!(identifier(&"a".repeat(400)).is_err());
        assert!(identifier("bad\nname").is_err());
    }

    #[test]
    fn public_account_never_includes_password_material() {
        let public = public_user(&json!({"id":"test","passwordHash":"secret","role":"user"}));
        assert!(public.get("passwordHash").is_none());
    }
}
