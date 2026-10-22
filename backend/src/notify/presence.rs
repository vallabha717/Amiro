//! Which conversation each signed-in browser tab has on screen. Vellum's
//! `runtime/web-presence.ts`, ported.
//!
//! Answers one question for notification producers: is the user looking at
//! this thread right now? A chat reply the user is watching is not news, so
//! the broadcaster drops it before the decision runs.
//!
//! Fails open: presence lives in memory, is reported by tabs that can vanish
//! without saying so (closed, crashed, laptop lid shut), and goes stale after
//! [`STALE_AFTER`]. Anything short of a fresh, visible report naming the
//! thread answers `false`, and the notification goes out. A missed
//! notification is worse than a redundant one.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a report is trusted. Tabs re-report every minute while the user
/// is present, so a live tab never ages out; a closed one does.
pub const STALE_AFTER: Duration = Duration::from_secs(180);

#[derive(Debug, Clone)]
struct Report {
    visible: bool,
    thread_id: Option<String>,
    at: Instant,
}

/// user id → client id → latest report.
type Reports = HashMap<String, HashMap<String, Report>>;

static REPORTS: OnceLock<Mutex<Reports>> = OnceLock::new();

fn reports() -> &'static Mutex<Reports> {
    REPORTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record what one tab is showing. `visible` means the tab is on screen,
/// focused and touched recently; `thread_id` is the chat it has open, if any.
pub fn report(user_id: &str, client_id: &str, visible: bool, thread_id: Option<&str>) {
    let thread_id = thread_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let Ok(mut all) = reports().lock() else {
        return;
    };
    let clients = all.entry(user_id.to_string()).or_default();
    clients.retain(|_, r| r.at.elapsed() <= STALE_AFTER);
    clients.insert(
        client_id.to_string(),
        Report {
            visible,
            thread_id,
            at: Instant::now(),
        },
    );
}

/// Whether some tab of this user reported, recently enough to trust, that the
/// thread is open and on screen. Any doubt answers `false`.
pub fn is_thread_focused(user_id: &str, thread_id: &str) -> bool {
    if thread_id.is_empty() {
        return false;
    }
    let Ok(all) = reports().lock() else {
        return false;
    };
    all.get(user_id).is_some_and(|clients| {
        clients.values().any(|r| {
            r.visible
                && r.at.elapsed() <= STALE_AFTER
                && r.thread_id.as_deref() == Some(thread_id)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique(prefix: &str) -> String {
        format!("{prefix}-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn a_visible_tab_on_the_thread_counts_as_focused() {
        let user = unique("u");
        report(&user, "tab-1", true, Some("t1"));
        assert!(is_thread_focused(&user, "t1"));
        assert!(!is_thread_focused(&user, "t2"));
    }

    #[test]
    fn hidden_tabs_and_other_users_do_not_count() {
        let user = unique("u");
        report(&user, "tab-1", false, Some("t1"));
        assert!(!is_thread_focused(&user, "t1"));
        assert!(!is_thread_focused(&unique("other"), "t1"));
    }

    #[test]
    fn leaving_the_chat_replaces_the_report() {
        let user = unique("u");
        report(&user, "tab-1", true, Some("t1"));
        report(&user, "tab-1", true, None);
        assert!(!is_thread_focused(&user, "t1"));
    }

    #[test]
    fn any_one_tab_on_the_thread_is_enough() {
        let user = unique("u");
        report(&user, "tab-1", true, Some("t1"));
        report(&user, "tab-2", true, Some("t2"));
        assert!(is_thread_focused(&user, "t1"));
        assert!(is_thread_focused(&user, "t2"));
    }

    #[test]
    fn blank_ids_never_match() {
        let user = unique("u");
        report(&user, "tab-1", true, Some("  "));
        assert!(!is_thread_focused(&user, ""));
    }
}
