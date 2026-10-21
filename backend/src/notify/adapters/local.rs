//! Local adapter: persists the feed item and publishes the
//! `notification_intent` SSE event (Vellum's vellum-channel equivalent).

use serde_json::{json, Value};

use crate::notify::adapters::{ChannelAdapter, ChannelCopy, DeliveryResult};
use crate::notify::broadcaster;
use crate::routes::notifications as feed;
use crate::state::{ApiError, AppState};

pub struct LocalAdapter;

impl ChannelAdapter for LocalAdapter {
    fn channel(&self) -> &'static str {
        "local"
    }

    async fn send(
        &self,
        state: &AppState,
        user_id: &str,
        delivery_id: &str,
        copy: &ChannelCopy,
        context: &Value,
    ) -> Result<DeliveryResult, ApiError> {
        let settings_doc = feed::load_settings_doc(state).await?;
        let settings = feed::settings_for(&settings_doc, user_id);
        let category = context
            .get("category")
            .and_then(|v| v.as_str())
            .unwrap_or("system");
        let urgency = context
            .get("urgency")
            .and_then(|v| v.as_str())
            .unwrap_or("normal");
        let silent = context
            .get("silent")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let input = json!({
            "title": copy.title,
            "body": copy.body,
            "category": category,
            "urgency": urgency,
            "silent": silent,
            "deliveryId": delivery_id,
            "threadId": context.get("threadId"),
            "scheduleId": context.get("scheduleId"),
            "sourceEventName": context.get("sourceEventName"),
        });
        let item = feed::build_item(user_id, &input, &settings, None)?;
        let unread = feed::persist_item(state, user_id, item.clone()).await?;
        broadcaster::publish(feed::intent_event(user_id, delivery_id, &item, unread));
        // Silence is presentation, not delivery: the item reached the feed.
        Ok(DeliveryResult {
            success: true,
            skipped: false,
            error: None,
            detail: Some(json!({ "item": item, "unreadCount": unread })),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn state() -> AppState {
        let root =
            std::env::temp_dir().join(format!("amiro-notify-local-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        AppState {
            home,
            runtime_home: root.join("runtime"),
            runtime_socket: root.join("s.sock"),
            workspace: root.join("workspace"),
            runtime_bin: root.join("rt"),
            token: String::new(),
            store: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    #[tokio::test]
    async fn send_persists_the_feed_item_and_reports_it() {
        let state = state();
        let copy = ChannelCopy {
            title: "Hi".into(),
            body: "There".into(),
        };
        let context = json!({
            "category": "system",
            "urgency": "normal",
            "silent": true,
            "sourceEventName": "system.test",
        });
        let result = LocalAdapter
            .send(&state, "u1", "d1", &copy, &context)
            .await
            .unwrap();
        assert!(result.success);
        let detail = result.detail.expect("local adapter reports the item");
        assert_eq!(detail["item"]["title"], json!("Hi"));
        assert_eq!(detail["item"]["silent"], json!(true));
        assert_eq!(detail["unreadCount"], json!(1));
        let _ = std::fs::remove_dir_all(state.home.parent().unwrap());
    }
}
