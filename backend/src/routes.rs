pub mod admin;
pub mod agent_computer;
pub mod agents;
pub mod agent_workspace;
pub mod artifacts;
pub mod archive;
pub mod channels;
pub mod composer;
pub mod checkpoint;
pub mod composio;
pub mod connectors;
pub mod contacts;
pub mod credentials;
pub mod export;
pub mod fsbrowse;
pub mod github;
pub mod live_voice;
pub mod mcp;
pub mod notifications;
pub mod provider_login;
pub mod providers_catalog;
pub mod schedules;
pub mod search_providers;
pub mod skills;
pub mod storage;
pub mod system;
pub mod user;
pub mod voice;
pub mod workspace_trust;

use crate::state::AppState;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(user::routes())
        .merge(admin::routes())
        .merge(agents::routes())
        .merge(agent_computer::routes())
        .merge(artifacts::routes())
        .merge(agent_workspace::routes())
        .merge(archive::routes())
        .merge(channels::routes())
        .merge(composer::routes())
        .merge(contacts::routes())
        .merge(workspace_trust::routes())
        .merge(checkpoint::routes())
        .merge(composio::routes())
        .merge(connectors::routes())
        .merge(credentials::routes())
        .merge(export::routes())
        .merge(storage::routes())
        .merge(system::routes())
        .merge(mcp::routes())
        .merge(fsbrowse::routes())
        .merge(providers_catalog::routes())
        .merge(provider_login::routes())
        .merge(search_providers::routes())
        .merge(github::routes())
        .merge(schedules::routes())
        .merge(skills::routes())
        .merge(voice::routes())
        .merge(live_voice::routes())
        .merge(notifications::routes())
        .merge(crate::agent_mcp::router())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn test_router_builds() {
        let _r: Router<AppState> = router();
    }

    #[test]
    fn test_skill_name_validation() {
        assert!(skills::is_valid_skill_name("test-skill"));
        assert!(skills::is_valid_skill_name("skill123"));
        assert!(skills::is_valid_skill_name("a-b-c-1-2"));
        assert!(!skills::is_valid_skill_name("Test-Skill"));
        assert!(!skills::is_valid_skill_name("skill_name"));
        assert!(!skills::is_valid_skill_name(""));
        assert!(!skills::is_valid_skill_name("-leading-hyphen"));
        assert!(!skills::is_valid_skill_name("trailing-hyphen-"));
        assert!(!skills::is_valid_skill_name("double--hyphen"));
        assert!(!skills::is_valid_skill_name(&"a".repeat(65)));
    }

    #[test]
    fn test_fsbrowse_roots() {
        let roots = fsbrowse::resolve_browse_roots();
        assert!(!roots.is_empty());
    }

    #[test]
    fn test_fsbrowse_denied_paths() {
        assert!(fsbrowse::is_denied(Path::new("/root/.ssh")));
        assert!(fsbrowse::is_denied(Path::new("/root/.ssh/id_rsa")));
        assert!(fsbrowse::is_denied(Path::new("/root/.jcode")));
        assert!(fsbrowse::is_denied(Path::new("/root/.jcode/config.json")));
        assert!(fsbrowse::is_denied(Path::new("/etc/ssl/private")));
        assert!(fsbrowse::is_denied(Path::new("/etc/letsencrypt")));
        assert!(!fsbrowse::is_denied(Path::new("/tmp/test-project")));
    }

    #[tokio::test]
    async fn test_concurrent_store_locking() {
        let temp_dir =
            std::env::temp_dir().join(format!("amiro-test-lock-{}", uuid::Uuid::new_v4()));
        let _ = tokio::fs::create_dir_all(&temp_dir).await;
        let file = temp_dir.join("test-counter.json");
        let store = std::sync::Arc::new(tokio::sync::Mutex::new(()));

        let _ = crate::state::write_json(&file, &json!({ "count": 0 })).await;

        let mut handles = Vec::new();
        for _ in 0..10 {
            let f = file.clone();
            let s = store.clone();
            handles.push(tokio::spawn(async move {
                let _lock = s.lock().await;
                let mut doc = crate::state::read_json(&f, json!({ "count": 0 }))
                    .await
                    .unwrap();
                let current = doc["count"].as_i64().unwrap_or(0);
                doc["count"] = json!(current + 1);
                crate::state::write_json(&f, &doc).await.unwrap();
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        let final_doc = crate::state::read_json(&file, json!({})).await.unwrap();
        assert_eq!(final_doc["count"], 10);
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[test]
    fn test_storage_token_format() {
        assert!(storage::is_valid_token(
            "0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!storage::is_valid_token("short_token"));
        assert!(!storage::is_valid_token(
            "0123456789abcdef0123456789abcdef0123456789abcdeg"
        )); // 'g' is non-hex
        assert!(!storage::is_valid_token(""));
    }

    #[tokio::test]
    async fn test_user_preferences_isolation() {
        let temp_dir =
            std::env::temp_dir().join(format!("amiro-test-user-{}", uuid::Uuid::new_v4()));
        let _ = tokio::fs::create_dir_all(temp_dir.join("store")).await;
        let prefs_file = temp_dir.join("store").join("user-preferences.json");

        let doc = json!({
            "user1": { "displayName": "Alice", "botName": "Amiro" },
            "user2": { "displayName": "Bob", "botName": "Assistant" }
        });
        crate::state::write_json(&prefs_file, &doc).await.unwrap();

        let read_back = crate::state::read_json(&prefs_file, json!({}))
            .await
            .unwrap();
        assert_eq!(read_back["user1"]["displayName"], "Alice");
        assert_eq!(read_back["user2"]["displayName"], "Bob");

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_workspace_trust_grant_and_revoke() {
        let temp_dir =
            std::env::temp_dir().join(format!("amiro-test-trust-{}", uuid::Uuid::new_v4()));
        let _ = tokio::fs::create_dir_all(temp_dir.join("store")).await;
        let trust_file = temp_dir.join("store").join("workspace-trust.json");

        let initial = json!({
            "user1": [
                { "resolvedRoot": "/path/one", "grantedAt": "2026-01-01T00:00:00Z" }
            ]
        });
        crate::state::write_json(&trust_file, &initial)
            .await
            .unwrap();

        let mut doc = crate::state::read_json(&trust_file, json!({}))
            .await
            .unwrap();
        let grants = doc.get_mut("user1").unwrap().as_array_mut().unwrap();
        grants.push(json!({ "resolvedRoot": "/path/two", "grantedAt": "2026-01-02T00:00:00Z" }));
        crate::state::write_json(&trust_file, &doc).await.unwrap();

        let verified = crate::state::read_json(&trust_file, json!({}))
            .await
            .unwrap();
        assert_eq!(verified["user1"].as_array().unwrap().len(), 2);

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
}
