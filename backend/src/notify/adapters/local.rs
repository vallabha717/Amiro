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
            "threadId": context.get("threadId"),
            "scheduleId": context.get("scheduleId"),
            "sourceEventName": context.get("sourceEventName"),
        });
        let item = feed::build_item(user_id, &input, &settings, None)?;
        let unread = feed::persist_item(state, user_id, item.clone()).await?;
        broadcaster::publish(json!({
            "type": "notification_intent",
            "userId": user_id,
            "deliveryId": delivery_id,
            "notification": item,
            "unreadCount": unread,
        }));
        // Silence is presentation, not delivery: the item reached the feed.
        Ok(DeliveryResult {
            success: true,
            skipped: false,
            error: None,
            detail: Some(json!({ "item": item, "unreadCount": unread })),
        })
    }
}
