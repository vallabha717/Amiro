//! First-run onboarding: what is already set up, what the owner skipped, and
//! applying `amiro.toml` / `.env` settings (owner profile, agent look,
//! provider keys) so a headless install needs no clicks at all.
//!
//! The wizard itself lives in the UI (`/onboarding`); account creation stays
//! in `auth.rs` (`POST /api/auth/setup`, the only account-creation path).
//!
//! Routes (owner session required):
//! - `GET  /api/onboarding`          state of every step + where config came from
//! - `POST /api/onboarding/profile`  `{name?, timezone?}`
//! - `POST /api/onboarding/complete` `{skipped?: [step]}`
//! - `POST /api/onboarding/reset`    show the wizard again

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::state::{read_json, write_json, ApiError, AppState, AuthUser};

pub const STEPS: &[&str] = &["account", "agent", "provider"];

/// `amiro.toml` `[providers]` env var → runtime provider id.
pub const PROVIDER_ENV: &[(&str, &str)] = &[
    ("ANTHROPIC_API_KEY", "anthropic-api"),
    ("OPENAI_API_KEY", "openai-api"),
    ("OPENROUTER_API_KEY", "openrouter"),
    ("GEMINI_API_KEY", "gemini-api"),
];

fn state_file(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("onboarding.json")
}

fn prefs_file(state: &AppState) -> std::path::PathBuf {
    state.home.join("store").join("user-preferences.json")
}

fn truthy_env(name: &str) -> bool {
    std::env::var(name)
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0["role"] == "admin" {
        Ok(())
    } else {
        Err(ApiError(
            StatusCode::FORBIDDEN,
            "only the owner can change setup".into(),
        ))
    }
}

pub fn valid_timezone(tz: &str) -> bool {
    tz.parse::<chrono_tz::Tz>().is_ok()
}

/// Store the owner's IANA timezone (read by USER.md seeding and the heartbeat).
pub async fn save_timezone(state: &AppState, user_id: &str, timezone: &str) -> Result<(), ApiError> {
    if !valid_timezone(timezone) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("unknown timezone {timezone:?}"),
        ));
    }
    let file = prefs_file(state);
    let mut prefs = read_json(&file, json!({})).await?;
    if !prefs.is_object() {
        prefs = json!({});
    }
    if !prefs[user_id].is_object() {
        prefs[user_id] = json!({});
    }
    prefs[user_id]["timezone"] = json!(timezone);
    write_json(&file, &prefs).await
}

/// Which provider a usable key came from: connected in the runtime's
/// credential home (file names are the runtime's own provider keys).
fn connected_providers(state: &AppState) -> Vec<String> {
    let dir = state.runtime_home.join("config").join("jcode");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.strip_suffix(".env").map(str::to_string)
        })
        .collect();
    ids.sort();
    ids
}

/// Provider sign-ins that are not API-key files (OAuth / CLI logins) still
/// count: ask the model list, which only lists connected providers.
async fn has_usable_model(state: &AppState) -> bool {
    if !connected_providers(state).is_empty() {
        return true;
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(8),
        crate::models::connected_provider_count(state),
    )
    .await
    {
        Ok(count) => count > 0,
        Err(_) => false,
    }
}

async fn status(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    let doc = read_json(&state_file(&state), json!({})).await?;
    let loaded = crate::config::loaded();
    let uid = user.0["id"].as_str().unwrap_or("").to_string();

    let identity = crate::agent::get_agent_identity(&state, Some(&uid)).await?;
    let agent_saved = crate::agent::has_saved_identity(&state, &uid);
    let prefs = read_json(&prefs_file(&state), json!({})).await?;
    let timezone = prefs[&uid]["timezone"].as_str().map(str::to_string);
    let providers = connected_providers(&state);
    let provider_ready = has_usable_model(&state).await;

    let source = |var: &str| loaded.source_of(var).filter(|s| *s != "env");
    let completed = doc["completedAt"].is_string() || truthy_env("AMIRO_SKIP_ONBOARDING");
    Ok(Json(json!({
        "completed": completed,
        "completedAt": doc["completedAt"],
        "skipped": doc["skipped"].as_array().cloned().unwrap_or_default(),
        "isOwner": user.0["role"] == "admin",
        "deployment": crate::routes::system::deployment_info(),
        "steps": {
            "account": {
                "done": true,
                "name": user.0["name"],
                "email": user.0["email"],
                "timezone": timezone,
                "source": source("AMIRO_OWNER_EMAIL"),
            },
            "agent": {
                "done": agent_saved,
                "name": identity["name"],
                "traits": identity["traits"],
                "accentHex": identity["accentHex"],
                "source": source("AMIRO_AGENT_NAME").or(source("AMIRO_AGENT_AVATAR")),
            },
            "provider": {
                "done": provider_ready,
                "connected": providers,
                "source": PROVIDER_ENV.iter().find_map(|(var, _)| source(var)),
            },
        },
        "config": loaded.summary(),
    })))
}

/// Re-render owner-specific home files that still read exactly as they were
/// seeded, so a name or timezone chosen after setup reaches USER.md without
/// ever touching a file the agent or the owner has edited.
async fn refresh_seeded_files(state: &AppState, before: (&str, &str, &str), after: (&str, &str, &str)) {
    if before == after {
        return;
    }
    let _guard = crate::agent_home::file_lock().lock().await;
    for (file, template) in crate::agent_home::owner_templates() {
        let path = state.workspace.join(file);
        let Ok(current) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let seeded = crate::agent_home::fill_placeholders(template, before.0, before.1, before.2);
        if current == seeded {
            let next = crate::agent_home::fill_placeholders(template, after.0, after.1, after.2);
            let _ = tokio::fs::write(&path, next).await;
        }
    }
}

async fn profile(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let uid = user.0["id"].as_str().unwrap_or("").to_string();
    let doc = crate::agent_home::load_state(&state).await?;
    let old_name = crate::agent_home::owner_display_name(&user.0);
    let email = user.0["email"].as_str().unwrap_or("").to_string();
    let old_tz = crate::agent_home::owner_timezone(&state, Some(&user.0), &doc).await;

    let name = body["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(128).collect::<String>());
    let timezone = body["timezone"].as_str().map(str::trim).filter(|t| !t.is_empty());
    if let Some(tz) = timezone {
        save_timezone(&state, &uid, tz).await?;
    }
    if let Some(name) = &name {
        crate::auth::set_user_name(&state, &uid, name).await?;
    }
    let new_name = name.clone().unwrap_or_else(|| old_name.clone());
    let new_tz = timezone.map(str::to_string).unwrap_or_else(|| old_tz.clone());
    refresh_seeded_files(
        &state,
        (&old_name, &email, &old_tz),
        (&new_name, &email, &new_tz),
    )
    .await;
    Ok(Json(json!({"ok": true, "name": new_name, "timezone": new_tz})))
}

async fn complete(
    State(state): State<AppState>,
    user: AuthUser,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let skipped: Vec<Value> = body
        .and_then(|Json(b)| b["skipped"].as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.as_str().is_some_and(|s| STEPS.contains(&s)))
        .collect();
    let doc = json!({
        "completedAt": chrono::Utc::now().to_rfc3339(),
        "skipped": skipped,
    });
    write_json(&state_file(&state), &doc).await?;
    Ok(Json(doc))
}

async fn reset(State(state): State<AppState>, user: AuthUser) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    write_json(&state_file(&state), &json!({})).await?;
    Ok(Json(json!({"ok": true})))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/onboarding", get(status))
        .route("/api/onboarding/profile", post(profile))
        .route("/api/onboarding/complete", post(complete))
        .route("/api/onboarding/reset", post(reset))
}

/// Installs that were in use before onboarding existed skip the wizard: an
/// owner with chat history has clearly set Amiro up already.
pub async fn migrate_existing(state: &AppState) {
    let file = state_file(state);
    if file.exists() {
        return;
    }
    let Some(owner) = crate::agent_home::owner_user(state).await else {
        return;
    };
    let uid = owner["id"].as_str().unwrap_or_default();
    // Chat history is the one signal config files cannot produce, so a
    // server set up from amiro.toml still greets its owner once.
    if crate::agent_home::owner_has_threads(state, uid).await {
        let doc = json!({
            "completedAt": chrono::Utc::now().to_rfc3339(),
            "skipped": [],
            "migrated": true,
        });
        if let Err(error) = write_json(&file, &doc).await {
            tracing::warn!(error = %error.1, "could not record onboarding migration");
        }
    }
}

/// Friendly avatar names from amiro.toml → the stored body shape.
pub fn body_shape(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "headphones" | "blob" => Some("blob"),
        "sprout" => Some("sprout"),
        "starfish" | "star" => Some("star"),
        "dreamer" | "cloud" => Some("cloud"),
        _ => None,
    }
}

/// Apply agent and provider settings from amiro.toml / .env once an owner
/// exists. Idempotent: the agent look is applied only while the identity has
/// never been saved, and a provider key only while that provider has none.
pub async fn apply_config(state: &AppState) {
    let Some(owner) = crate::agent_home::owner_user(state).await else {
        return;
    };
    let loaded = crate::config::loaded();
    let from_files = |var: &str| matches!(loaded.source_of(var), Some(".env" | "amiro.toml"));

    // Agent name / look.
    let name = std::env::var("AMIRO_AGENT_NAME").ok().filter(|v| !v.trim().is_empty());
    let avatar = std::env::var("AMIRO_AGENT_AVATAR").ok().filter(|v| !v.trim().is_empty());
    let color = std::env::var("AMIRO_AGENT_COLOR").ok().filter(|v| !v.trim().is_empty());
    if name.is_some() || avatar.is_some() || color.is_some() {
        let uid = owner["id"].as_str().unwrap_or("").to_string();
        if !crate::agent::has_saved_identity(state, &uid) {
            let mut body = json!({});
            if let Some(name) = &name {
                body["name"] = json!(name.trim());
            }
            let mut traits = json!({});
            if let Some(avatar) = &avatar {
                match body_shape(avatar) {
                    Some(shape) => traits["bodyShape"] = json!(shape),
                    None => tracing::warn!(%avatar, "amiro config: unknown agent avatar (headphones, sprout, starfish, dreamer)"),
                }
            }
            if let Some(color) = &color {
                traits["color"] = json!(color.trim().to_ascii_lowercase());
            }
            if traits.as_object().is_some_and(|t| !t.is_empty()) {
                body["traits"] = traits;
            }
            match crate::agent::put_identity(
                State(state.clone()),
                AuthUser(owner.clone()),
                Some(Json(body)),
            )
            .await
            {
                Ok(_) => tracing::info!("applied agent name/avatar from config"),
                Err(error) => tracing::warn!(error = %error.1, "amiro config: agent settings rejected"),
            }
        }
    }

    // Provider keys: only from files (a key that merely sits in the shell
    // environment of whoever started the server is not imported). Each key
    // is imported once; a changed key in the file is imported again, so
    // rotating it there works. Only a fingerprint is remembered.
    let imports_file = state.home.join("store").join("config-imports.json");
    let mut imports = read_json(&imports_file, json!({})).await.unwrap_or(json!({}));
    if !imports.is_object() {
        imports = json!({});
    }
    let mut changed = false;
    for (var, provider) in PROVIDER_ENV {
        if !from_files(var) {
            continue;
        }
        let Ok(key) = std::env::var(var) else { continue };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let fingerprint = {
            use sha2::{Digest, Sha256};
            hex::encode(&Sha256::digest(format!("amiro-config-import:{key}"))[..12])
        };
        if imports[*provider].as_str() == Some(fingerprint.as_str()) {
            continue;
        }
        match crate::routes::providers_catalog::store_api_key(state, provider, key, "").await {
            Ok(()) => {
                crate::models::invalidate_catalog();
                imports[*provider] = json!(fingerprint);
                changed = true;
                tracing::info!(%provider, "connected provider from config");
            }
            Err(error) => tracing::warn!(%provider, error = %error.1, "amiro config: provider key not stored"),
        }
    }
    if changed {
        if let Err(error) = write_json(&imports_file, &imports).await {
            tracing::warn!(error = %error.1, "could not record config imports");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avatar_names_map_to_shapes() {
        assert_eq!(body_shape("Headphones"), Some("blob"));
        assert_eq!(body_shape("starfish"), Some("star"));
        assert_eq!(body_shape("dreamer"), Some("cloud"));
        assert_eq!(body_shape("dragon"), None);
    }

    #[test]
    fn timezones_are_validated() {
        assert!(valid_timezone("Asia/Kolkata"));
        assert!(!valid_timezone("Mars/Base"));
    }
}
