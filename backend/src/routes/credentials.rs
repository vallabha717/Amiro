//! Credential store routes.
//!
//! Credentials are instance-wide, like the Composio key: writes are admin-only,
//! while any authenticated user may list metadata (service/field/label/hint plus
//! the Vellum-style policy: exported env var, usage description, allowed tools
//! and domains). No route ever returns a credential value.
//!
//! `POST /api/credentials/validate` checks a stored credential against its
//! upstream provider (`composio`, or `github` when `AMIRO_GITHUB_BASE_URL` is
//! configured) and returns a boolean.
//!
//! `POST /api/credentials/broker` executes an upstream HTTP request *server
//! side*, injecting the stored secret into a header, enforcing the credential's
//! `allowedDomains`, and scrubbing the secret out of the response. The model
//! never sees the raw value.

use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::credentials;
use crate::routes::agents::AgentState;
use crate::state::{ApiError, AppState, AuthUser};

const VALIDATE_TIMEOUT: Duration = Duration::from_secs(15);

/// Placeholder substituted for a secret reflected by an upstream response.
const REDACTED: &str = "[REDACTED]";

fn require_admin(user: &AuthUser) -> Result<(), ApiError> {
    if user.0.get("role").and_then(|r| r.as_str()) != Some("admin") {
        return Err(ApiError(StatusCode::FORBIDDEN, "Forbidden".to_string()));
    }
    Ok(())
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(VALIDATE_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Collect a JSON array of non-empty, trimmed strings, ignoring other types.
fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

async fn list(AgentState(state): AgentState, _user: AuthUser) -> Result<Json<Value>, ApiError> {
    let items = credentials::list_metadata(&state).await?;
    Ok(Json(json!({ "items": items })))
}

/// Map bare or `-api` service names to the runtime's API-key provider IDs so
/// saving a credential in the vault (via the UI or SECRET_PROMPT card) also
/// provisions the runtime provider immediately.
fn runtime_provider_for_service(service: &str) -> Option<&'static str> {
    match service.trim().to_ascii_lowercase().as_str() {
        "openai" | "openai-api" => Some("openai-api"),
        "anthropic" | "anthropic-api" | "claude-api" => Some("anthropic-api"),
        "gemini" | "gemini-api" | "google" | "google-gemini" => Some("gemini-api"),
        "openrouter" => Some("openrouter"),
        "groq" => Some("groq"),
        "xai" | "grok" => Some("xai"),
        "deepseek" => Some("deepseek"),
        "mistral" => Some("mistral"),
        "together" => Some("together"),
        "fireworks" => Some("fireworks"),
        "cerebras" => Some("cerebras"),
        "perplexity" => Some("perplexity"),
        "cohere" => Some("cohere"),
        _ => None,
    }
}

/// Map search-related vault service names (`tavily`, `search.tavily`, etc.) to
/// the search provider catalog `(kind, default_label)`.
fn search_provider_for_service(service: &str) -> Option<(&'static str, &'static str)> {
    let raw = service.trim().to_ascii_lowercase();
    let stripped = raw.strip_prefix("search.").unwrap_or(&raw);
    match stripped {
        "brave" => Some(("brave", "Brave Search")),
        "tavily" => Some(("tavily", "Tavily")),
        "exa" => Some(("exa", "Exa")),
        "serper" => Some(("serper", "Serper")),
        "firecrawl" => Some(("firecrawl", "Firecrawl")),
        _ => None,
    }
}

async fn put_credential(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let service = body.get("service").and_then(Value::as_str).unwrap_or("");
    let field = body.get("field").and_then(Value::as_str).unwrap_or("");
    let value = body.get("value").and_then(Value::as_str).unwrap_or("");
    let label = body.get("label").and_then(Value::as_str);

    // Policy fields are optional. When a key is absent, preserve whatever is
    // already stored for the slot so a value-only re-save cannot drop policy.
    let existing = credentials::list_metadata(&state)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|item| item.service == service && item.field == field);
    let description = match body.get("usageDescription") {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => existing
            .as_ref()
            .and_then(|item| item.usage_description.as_deref()),
    };
    let tools = match body.get("allowedTools") {
        Some(value) => string_array(Some(value)),
        None => existing
            .as_ref()
            .map(|item| item.allowed_tools.clone())
            .unwrap_or_default(),
    };
    let domains = match body.get("allowedDomains") {
        Some(value) => string_array(Some(value)),
        None => existing
            .as_ref()
            .map(|item| item.allowed_domains.clone())
            .unwrap_or_default(),
    };

    let metadata =
        credentials::set_with_policy(&state, service, field, value, label, description, tools, domains)
            .await?;
    // Any credential is exported to runtime processes as AMIRO_CRED_*, so a
    // running bridge must pick up the new environment.
    crate::composio_config::refresh_runtime_key(&state);

    // Best-effort automatic provisioning when an API key is saved in the vault:
    // 1. Sync to runtime LLM provider if service matches a known API-key provider.
    if matches!(field, "api_key" | "key" | "token") && !value.trim().is_empty() {
        if let Some(provider_id) = runtime_provider_for_service(service) {
            let _ = crate::routes::providers_catalog::store_api_key(
                &state,
                provider_id,
                value.trim(),
                "",
            )
            .await;
        }
        // 2. Sync to search providers if service is a search provider (e.g. tavily, brave, search.tavily).
        if let Some((kind, default_label)) = search_provider_for_service(service) {
            let existing_id = crate::routes::search_providers::list_search_providers_payload(&state)
                .await
                .ok()
                .and_then(|list| {
                    list.into_iter().find_map(|p| {
                        (p.get("provider").and_then(Value::as_str) == Some(kind))
                            .then(|| p.get("id").and_then(Value::as_str).map(str::to_string))
                            .flatten()
                    })
                });
            let mut payload = json!({
                "name": label.unwrap_or(default_label),
                "provider": kind,
                "apiKey": value.trim(),
            });
            if let Some(id) = existing_id {
                payload["id"] = json!(id);
            }
            let _ = crate::routes::search_providers::upsert_search_provider(&state, &payload).await;
        }
        // 3. Reload MCP connectors if a connector secret (`mcp.<slug>`) was saved.
        if service.starts_with("mcp.") {
            crate::routes::connectors::reload(&state).await;
        }
    }

    Ok(Json(serde_json::to_value(metadata)?))
}

async fn delete_credential(
    AgentState(state): AgentState,
    user: AuthUser,
    Path((service, field)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    credentials::delete(&state, &service, &field).await?;
    crate::composio_config::refresh_runtime_key(&state);
    Ok(Json(json!({ "success": true })))
}

async fn validate(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let service = body.get("service").and_then(Value::as_str).unwrap_or("");
    let field = body.get("field").and_then(Value::as_str).unwrap_or("");

    if service == "composio" {
        let secret = credentials::get_plaintext(&state, service, field)
            .await?
            .ok_or_else(not_configured)?;
        let base = crate::composio_config::base_url();
        // The request URL never carries the key (it is a header), and errors
        // below never echo it.
        let response = http_client()
            .get(format!("{base}/api/v3/toolkits"))
            .query(&[("limit", "1")])
            .header("x-api-key", secret.expose())
            .send()
            .await
            .map_err(|_| upstream_unreachable("the Composio API"))?;
        return Ok(Json(json!({ "valid": response.status().is_success() })));
    }

    if service == "github" {
        let Some(base) = github_base_url() else {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "validation is only supported for service \"composio\" \
                 (github needs AMIRO_GITHUB_BASE_URL)"
                    .to_string(),
            ));
        };
        let secret = credentials::get_plaintext(&state, service, field)
            .await?
            .ok_or_else(not_configured)?;
        let response = http_client()
            .get(format!("{base}/user"))
            .header("authorization", format!("token {}", secret.expose()))
            .header("user-agent", "amiro")
            .header("accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|_| upstream_unreachable("the GitHub API"))?;
        return Ok(Json(json!({ "valid": response.status().is_success() })));
    }

    Err(ApiError(
        StatusCode::BAD_REQUEST,
        "validation is only supported for service \"composio\"".to_string(),
    ))
}

fn not_configured() -> ApiError {
    ApiError(
        StatusCode::NOT_FOUND,
        "credential is not configured".to_string(),
    )
}

fn upstream_unreachable(target: &str) -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        format!("could not reach {target}"),
    )
}

fn github_base_url() -> Option<String> {
    std::env::var("AMIRO_GITHUB_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
}

/// Whether a host matches one allow-list pattern. `*.example.com` matches
/// `example.com` and any subdomain; anything else is an exact match.
pub fn host_matches_domain(host: &str, pattern: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let pattern = pattern.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || pattern.is_empty() {
        return false;
    }
    match pattern.strip_prefix("*.") {
        Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
        None => host == pattern,
    }
}

/// Enforce a credential's `allowedDomains`. An empty list means "no restriction".
pub fn host_allowed(host: &str, allowed: &[String]) -> bool {
    allowed.is_empty() || allowed.iter().any(|pattern| host_matches_domain(host, pattern))
}

/// Replace every occurrence of a secret in a text blob with `[REDACTED]`.
pub fn scrub_secret(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        return text.to_string();
    }
    text.replace(secret, REDACTED)
}

async fn broker(
    AgentState(state): AgentState,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&user)?;
    let service = body.get("service").and_then(Value::as_str).unwrap_or("");
    let field = body.get("field").and_then(Value::as_str).unwrap_or("");
    let url = body.get("url").and_then(Value::as_str).unwrap_or("").trim();
    if url.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "url is required".to_string(),
        ));
    }
    let parsed = url::Url::parse(url).map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "url must be an absolute http(s) URL".to_string(),
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "url must be an absolute http(s) URL".to_string(),
        ));
    }

    // Domain enforcement comes from the credential's own policy.
    let metadata = credentials::list_metadata(&state)
        .await?
        .into_iter()
        .find(|item| item.service == service && item.field == field)
        .ok_or_else(not_configured)?;
    let host = parsed.host_str().unwrap_or("");
    if !host_allowed(host, &metadata.allowed_domains) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            format!("host {host} is not allowed for this credential"),
        ));
    }

    let secret = credentials::get_plaintext(&state, service, field)
        .await?
        .ok_or_else(not_configured)?;

    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "method is not a valid HTTP method".to_string(),
        )
    })?;

    let header_name = body
        .get("headerName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Authorization");
    let value_prefix = body
        .get("valuePrefix")
        .and_then(Value::as_str)
        .unwrap_or("Bearer ");
    let injected = format!("{value_prefix}{}", secret.expose());

    let mut request = http_client().request(method, parsed.clone());
    let mut has_content_type = false;
    if let Some(headers) = body.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            let Some(value) = value.as_str() else { continue };
            if name.eq_ignore_ascii_case("content-type") {
                has_content_type = true;
            }
            request = request.header(name.as_str(), value);
        }
    }
    request = request.header(header_name, injected);

    if let Some(payload) = body.get("body") {
        if !payload.is_null() {
            let (text, is_json) = match payload {
                Value::String(text) => (text.clone(), false),
                other => (
                    serde_json::to_string(other).map_err(|error| {
                        ApiError(
                            StatusCode::BAD_REQUEST,
                            format!("body could not be serialized: {error}"),
                        )
                    })?,
                    true,
                ),
            };
            if is_json && !has_content_type {
                request = request.header("content-type", "application/json");
            }
            request = request.body(text);
        }
    }

    let response = request.send().await.map_err(|error| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("brokered request failed: {error}"),
        )
    })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let scrubbed = scrub_secret(&text, secret.expose());

    Ok(Json(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "body": scrubbed,
    })))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/credentials", get(list).put(put_credential))
        .route(
            "/api/credentials/{service}/{field}",
            axum::routing::delete(delete_credential),
        )
        .route("/api/credentials/validate", post(validate))
        .route("/api/credentials/broker", post(broker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_patterns_are_enforced() {
        assert!(host_matches_domain("api.github.com", "api.github.com"));
        assert!(!host_matches_domain("evil-api.github.com", "api.github.com"));
        assert!(host_matches_domain("api.github.com", "*.github.com"));
        assert!(host_matches_domain("github.com", "*.github.com"));
        assert!(!host_matches_domain("notgithub.com", "*.github.com"));
        assert!(!host_matches_domain("github.com.evil.test", "*.github.com"));
        assert!(host_matches_domain("API.GitHub.com", "api.github.com"));
        assert!(!host_matches_domain("", "api.github.com"));
        assert!(!host_matches_domain("api.github.com", ""));
    }

    #[test]
    fn allow_list_gates_hosts() {
        let allowed = vec!["api.github.com".to_string(), "*.example.com".to_string()];
        assert!(host_allowed("api.github.com", &allowed));
        assert!(host_allowed("sub.example.com", &allowed));
        assert!(!host_allowed("evil.test", &allowed));
        // An empty list means unrestricted.
        assert!(host_allowed("anything.test", &[]));
    }

    #[test]
    fn secrets_are_scrubbed_from_bodies() {
        let body = r#"{"echo":"sk-secret-1234","nested":{"also":"sk-secret-1234"}}"#;
        let scrubbed = scrub_secret(body, "sk-secret-1234");
        assert!(!scrubbed.contains("sk-secret-1234"));
        assert_eq!(scrubbed.matches(REDACTED).count(), 2);
        // Nothing to redact is a no-op.
        assert_eq!(scrub_secret("plain", ""), "plain");
    }
}
