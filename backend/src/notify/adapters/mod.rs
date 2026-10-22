//! Channel adapters: one trait, one adapter per delivery surface. Phase 00
//! ships the local adapter (feed + SSE intent). Telegram, Slack, and Discord
//! adapters land in Phase 03 behind this same trait.

pub mod discord;
pub mod http;
pub mod local;
pub mod pairing;
pub mod slack;
pub mod telegram;

use serde_json::Value;

use crate::state::{ApiError, AppState};

/// Rendered copy for one channel, decided before any adapter runs.
#[derive(Debug, Clone)]
pub struct ChannelCopy {
    pub title: String,
    pub body: String,
}

/// What an adapter reports back. A send that never ran (suppressed before
/// any provider call) is `skipped`, not a failure.
#[derive(Debug, Clone)]
pub struct DeliveryResult {
    pub success: bool,
    pub skipped: bool,
    pub error: Option<String>,
    /// Adapter-specific detail (the local adapter reports the feed item
    /// and unread count here).
    pub detail: Option<Value>,
}

/// Interface every channel adapter implements.
pub trait ChannelAdapter {
    fn channel(&self) -> &'static str;

    fn send(
        &self,
        state: &AppState,
        user_id: &str,
        delivery_id: &str,
        copy: &ChannelCopy,
        context: &Value,
    ) -> impl std::future::Future<Output = Result<DeliveryResult, ApiError>> + Send;
}

#[cfg(test)]
mod tests {
    /// Meta guard (Phase 05): every adapter module must carry its own test
    /// module, so no untested adapter lands later. Add the file here when a
    /// new adapter is added.
    #[test]
    fn every_adapter_has_a_test_module() {
        for file in [
            include_str!("discord.rs"),
            include_str!("http.rs"),
            include_str!("local.rs"),
            include_str!("pairing.rs"),
            include_str!("slack.rs"),
            include_str!("telegram.rs"),
        ] {
            assert!(
                file.contains("mod tests"),
                "adapter file without a test module"
            );
        }
    }
}
