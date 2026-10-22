//! Shared HTTP plumbing for the external channel adapters (Phase 03).
//!
//! Every adapter speaks to its provider with a plain `reqwest` client, a
//! bounded timeout, and no retries: a failure is recorded in the delivery
//! row and never blocks the other channels. Tests point each adapter at a
//! local stub server through `AMIRO_NOTIFY_<CHANNEL>_BASE_URL`; production
//! uses the compiled-in default base URL.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

use crate::state::ApiError;
use axum::http::StatusCode;

/// Per-request ceiling: providers are chatty, but a delivery must never hang
/// the pipeline.
pub const ADAPTER_TIMEOUT: Duration = Duration::from_secs(10);

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(ADAPTER_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Resolve the API base URL: the stub override when set (tests), else the
/// production default. The override is read per call so tests can point at
/// an ephemeral stub port without restarting anything.
pub fn base_url(env_override: &str, production: &str) -> String {
    std::env::var(env_override)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| production.to_string())
}

/// POST a JSON body, returning the parsed JSON response. Non-2xx responses
/// and transport failures both surface as `ApiError` whose message is safe
/// to persist in a delivery row (it never contains the token: callers pass
/// tokens via headers or URL paths built from vault material, and this
/// helper never echoes them back).
pub async fn post_json(
    url: &str,
    headers: &[(&str, &str)],
    body: &Value,
) -> Result<Value, ApiError> {
    let mut request = http_client().post(url).json(body);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.map_err(|error| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("channel request failed: {}", short_error(&error)),
        )
    })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
    if !status.is_success() {
        return Err(ApiError(
            provider_status(status),
            format!(
                "channel returned {}: {}",
                status.as_u16(),
                short_body(&parsed)
            ),
        ));
    }
    Ok(parsed)
}

/// GET a JSON endpoint (used by `getMe`-style verify calls).
pub async fn get_json(url: &str, headers: &[(&str, &str)]) -> Result<Value, ApiError> {
    let mut request = http_client().get(url);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.map_err(|error| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("channel verify failed: {}", short_error(&error)),
        )
    })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
    if !status.is_success() {
        return Err(ApiError(
            provider_status(status),
            format!(
                "channel verify returned {}: {}",
                status.as_u16(),
                short_body(&parsed)
            ),
        ));
    }
    Ok(parsed)
}

/// A 401/403 from the provider means the stored token is wrong (the caller's
/// fault: 401 here so the UI can prompt for a new token); anything else
/// upstream is a 502.
fn provider_status(status: reqwest::StatusCode) -> StatusCode {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::BAD_GATEWAY
    }
}

fn short_error(error: &reqwest::Error) -> String {
    let text = error.to_string();
    // Strip any URL (which for Telegram embeds the bot token in the path).
    if let Some(at) = text.find("error sending request for url") {
        format!("{} (url redacted)", text[..at].trim_end())
    } else {
        text.chars().take(300).collect()
    }
}

/// Truncate provider error bodies so a verbose upstream reply cannot bloat a
/// delivery row.
fn short_body(value: &Value) -> String {
    let text = match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    text.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_url_prefers_production_without_override() {
        std::env::remove_var("AMIRO_NOTIFY_TEST_ONLY_BASE_URL");
        assert_eq!(
            base_url(
                "AMIRO_NOTIFY_TEST_ONLY_BASE_URL",
                "https://api.example.test"
            ),
            "https://api.example.test"
        );
    }

    #[test]
    fn provider_status_maps_auth_failures_to_401() {
        assert_eq!(
            provider_status(reqwest::StatusCode::UNAUTHORIZED),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            provider_status(reqwest::StatusCode::FORBIDDEN),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            provider_status(reqwest::StatusCode::TOO_MANY_REQUESTS),
            StatusCode::BAD_GATEWAY
        );
    }

    #[test]
    fn short_body_truncates_to_300_chars() {
        let long = "x".repeat(500);
        assert_eq!(short_body(&json!(long)).chars().count(), 300);
        assert_eq!(short_body(&json!({"ok": false})), "{\"ok\":false}");
    }
}
