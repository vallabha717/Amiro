//! Native account authentication, compatible with existing scrypt password hashes.
use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use rand::RngCore;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;

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
    if password.len() > 4096 {
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

async fn insecure_admin(users: &[Value]) -> Result<bool, ApiError> {
    for user in users {
        if user["email"]
            .as_str()
            .is_some_and(|email| email.eq_ignore_ascii_case("admin@local"))
            && verify_password("admin", user["passwordHash"].as_str().unwrap_or("")).await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub async fn init(state: &AppState) -> Result<(), ApiError> {
    tokio::fs::create_dir_all(&state.home).await?;
    tokio::fs::create_dir_all(&state.workspace).await?;
    let _guard = state.store.lock().await;
    let file = state.home.join("users.json");
    let mut document = read_json(&file, json!({"users":[]})).await?;
    let users = users_array(&document)?;
    // Check all persisted account state before creating a bootstrap account.
    let sessions = read_json(&state.home.join("sessions.json"), json!({"sessions":{}})).await?;
    if !sessions["sessions"].is_object() {
        return Err(failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid sessions database",
        ));
    }
    if users.is_empty() && std::env::var("AMIRO_SEED_ADMIN").as_deref() != Ok("0") {
        let password = random_hex(18);
        let timestamp = now();
        let user = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Admin","email":"admin@local","role":"admin","passwordHash":hash_password(&password).await?,"createdAt":timestamp,"mustChangePassword":true});
        document["users"] = json!([user]);
        // Persist the private credential before making its new account visible.
        // A failed bootstrap must not leave an account with an unknown password.
        write_json(
            &state.home.join("admin-initial-password"),
            &json!({"email":"admin@local","password":password,"createdAt":timestamp}),
        )
        .await?;
        write_json(&file, &document).await?;
        tracing::warn!(
            "Generated initial admin credentials in the private admin-initial-password file"
        );
    } else if insecure_admin(users).await? {
        if std::env::var("AMIRO_ALLOW_INSECURE_ADMIN").as_deref() != Ok("1") {
            return Err(failure(
                StatusCode::FORBIDDEN,
                "insecure seeded admin present, refusing startup without resetting its password",
            ));
        }
        tracing::warn!(
            "AMIRO_ALLOW_INSECURE_ADMIN=1: existing insecure account accepted for development only"
        );
    }
    Ok(())
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
    let users = users_array(&document)?;
    Ok(Json(
        json!({"isFirstUser":users.is_empty(),"registrationEnabled":users.is_empty() || std::env::var("AMIRO_ALLOW_REGISTRATION").as_deref()==Ok("1"),"deploymentSafe":!insecure_admin(users).await?}),
    ))
}

async fn login(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let email = body["email"].as_str().unwrap_or("");
    let password = body["password"].as_str().unwrap_or("");
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

async fn register(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let email = body["email"].as_str().unwrap_or("").trim();
    let password = body["password"].as_str().unwrap_or("");
    if email.is_empty() || email.len() > 320 || password.is_empty() || password.len() > 4096 {
        return Err(failure(
            StatusCode::BAD_REQUEST,
            "valid email and password are required",
        ));
    }
    let _guard = state.store.lock().await;
    let file = state.home.join("users.json");
    let mut document = read_json(&file, json!({"users":[]})).await?;
    let users = users_array(&document)?;
    if !users.is_empty() && std::env::var("AMIRO_ALLOW_REGISTRATION").as_deref() != Ok("1") {
        return Err(failure(StatusCode::FORBIDDEN, "registration is disabled"));
    }
    if users.iter().any(|user| {
        user["email"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(email))
    }) {
        return Err(failure(StatusCode::CONFLICT, "email already registered"));
    }
    let timestamp = now();
    let name = body["name"]
        .as_str()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| email.split('@').next().unwrap_or("Member"));
    let user = json!({"id":uuid::Uuid::new_v4().to_string(),"name":name.chars().take(128).collect::<String>(),"email":email,"role":"user","passwordHash":hash_password(password).await?,"createdAt":timestamp,"lastLogin":timestamp});
    document["users"].as_array_mut().unwrap().push(user.clone());
    write_json(&file, &document).await?;
    let token = issue_token(&state, user["id"].as_str().unwrap()).await?;
    Ok(Json(json!({"user":public_user(&user),"token":token})))
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
        .route("/api/auth/login", post(login))
        .route("/api/auth/register", post(register))
        .route("/api/auth/session", get(session))
        .route("/api/auth/logout", post(logout))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn startup_preserves_existing_accounts_and_rejects_corruption() {
        let home = std::env::temp_dir().join(format!("amiro-auth-test-{}", uuid::Uuid::new_v4()));
        let state = AppState {
            runtime_home: home.join("runtime"),
            runtime_socket: home.join("runtime.sock"),
            workspace: home.join("workspace"),
            runtime_bin: "amiro".into(),
            token: String::new(),
            store: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            home: home.clone(),
        };
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
        assert!(!home.join("admin-initial-password").exists());
        tokio::fs::remove_dir_all(home).await.unwrap();
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
    fn public_account_never_includes_password_material() {
        let public = public_user(&json!({"id":"test","passwordHash":"secret","role":"user"}));
        assert!(public.get("passwordHash").is_none());
    }
}
