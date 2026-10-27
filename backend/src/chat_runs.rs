//! A chat turn outlives the request that started it.
//!
//! Phones drop a streaming request whenever the browser goes to the
//! background or the screen locks. A turn tied to that request was cancelled
//! with it, so the reply never arrived. Instead each turn runs as a task of
//! its own and writes its frames here; the request that started it, and any
//! later one that reconnects (`GET /api/chat/{id}/stream`), replays the frames
//! from the start and then follows the turn live. Only an explicit Stop
//! (`POST /api/chat/stop`) or a newer turn in the same thread ends it early.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::stream::{Stream, StreamExt};
use tokio::sync::{watch, Notify};

/// How long a finished turn stays replayable, so a phone that comes back a
/// while after the reply ended still gets it in full (later, history has it).
pub const KEEP_FINISHED: Duration = Duration::from_secs(30 * 60);

/// How long a newer turn waits for the one it replaces to wind down.
const REPLACE_WAIT: Duration = Duration::from_secs(10);

pub struct Run {
    id: String,
    uid: String,
    frames: Mutex<Vec<String>>,
    /// Frame count, and whether the turn has ended, for followers to wait on.
    progress: watch::Sender<(usize, bool)>,
    stop: Notify,
}

impl Run {
    pub fn is_done(&self) -> bool {
        self.progress.borrow().1
    }

    fn push(&self, frame: String) {
        let count = {
            let mut frames = self.frames.lock().unwrap_or_else(|e| e.into_inner());
            frames.push(frame);
            frames.len()
        };
        self.progress.send_replace((count, false));
    }

    fn finish(&self) {
        let count = self.frames.lock().map(|f| f.len()).unwrap_or(0);
        self.progress.send_replace((count, true));
    }

    async fn wait_done(&self, limit: Duration) {
        let mut progress = self.progress.subscribe();
        let _ = tokio::time::timeout(limit, progress.wait_for(|(_, done)| *done)).await;
    }
}

type Runs = Mutex<HashMap<String, Arc<Run>>>;

fn runs() -> &'static Runs {
    static RUNS: OnceLock<Runs> = OnceLock::new();
    RUNS.get_or_init(Default::default)
}

fn key(uid: &str, thread_id: &str) -> String {
    format!("{uid}\u{0}{thread_id}")
}

/// The latest turn of a thread, running or finished within [`KEEP_FINISHED`].
pub fn get(uid: &str, thread_id: &str) -> Option<Arc<Run>> {
    runs().lock().ok()?.get(&key(uid, thread_id)).cloned()
}

/// Run `turn` in the background as the thread's current turn. A turn still
/// running in that thread is stopped first.
pub async fn start<S>(uid: &str, thread_id: &str, turn: S) -> Arc<Run>
where
    S: Stream<Item = String> + Send + 'static,
{
    if let Some(previous) = get(uid, thread_id).filter(|run| !run.is_done()) {
        previous.stop.notify_one();
        previous.wait_done(REPLACE_WAIT).await;
    }
    let run = Arc::new(Run {
        id: uuid::Uuid::new_v4().to_string(),
        uid: uid.to_string(),
        frames: Mutex::new(Vec::new()),
        progress: watch::channel((0, false)).0,
        stop: Notify::new(),
    });
    let run_key = key(uid, thread_id);
    if let Ok(mut map) = runs().lock() {
        map.insert(run_key.clone(), run.clone());
    }
    let task_run = run.clone();
    tokio::spawn(async move {
        let mut turn = Box::pin(turn);
        loop {
            tokio::select! {
                frame = turn.next() => match frame {
                    Some(frame) => task_run.push(frame),
                    None => break,
                },
                _ = task_run.stop.notified() => break,
            }
        }
        // Dropping the turn mid-way cancels the runtime session (its guard).
        drop(turn);
        task_run.finish();
        tokio::time::sleep(KEEP_FINISHED).await;
        if let Ok(mut map) = runs().lock() {
            if map.get(&run_key).is_some_and(|run| run.id == task_run.id) {
                map.remove(&run_key);
            }
        }
    });
    run
}

/// Stop the thread's running turn. False when nothing was running.
pub fn stop(uid: &str, thread_id: &str) -> bool {
    match get(uid, thread_id).filter(|run| !run.is_done() && run.uid == uid) {
        Some(run) => {
            run.stop.notify_one();
            true
        }
        None => false,
    }
}

/// Every frame of the turn from its start, then each new one until it ends.
/// Dropping this stream leaves the turn running.
pub fn follow(run: Arc<Run>) -> impl Stream<Item = String> + Send + 'static {
    async_stream::stream! {
        let mut progress = run.progress.subscribe();
        let mut sent = 0usize;
        loop {
            let (batch, done) = {
                let frames = run.frames.lock().unwrap_or_else(|e| e.into_inner());
                (frames[sent..].to_vec(), run.is_done())
            };
            sent += batch.len();
            for frame in batch {
                yield frame;
            }
            if done {
                // Frames pushed before `finish` are already in `batch`.
                let total = run.frames.lock().map(|f| f.len()).unwrap_or(sent);
                if sent >= total {
                    break;
                }
                continue;
            }
            if progress.changed().await.is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(items: &[&str]) -> impl Stream<Item = String> + Send + 'static {
        let items: Vec<String> = items.iter().map(|s| s.to_string()).collect();
        async_stream::stream! {
            for item in items {
                tokio::time::sleep(Duration::from_millis(20)).await;
                yield item;
            }
        }
    }

    #[tokio::test]
    async fn a_turn_keeps_running_after_its_follower_goes_away() {
        let run = start("u-keep", "t-keep", frames(&["a", "b", "c"])).await;
        let mut first = Box::pin(follow(run.clone()));
        assert_eq!(first.next().await.as_deref(), Some("a"));
        drop(first);
        run.wait_done(Duration::from_secs(5)).await;
        assert!(run.is_done());
        let replay: Vec<String> = follow(run).collect().await;
        assert_eq!(replay, ["a", "b", "c"]);
    }

    #[tokio::test]
    async fn a_late_follower_gets_the_whole_turn_then_live_frames() {
        let run = start("u-late", "t-late", frames(&["1", "2", "3", "4"])).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let all: Vec<String> = follow(get("u-late", "t-late").unwrap()).collect().await;
        assert_eq!(all, ["1", "2", "3", "4"]);
        assert!(run.is_done());
    }

    #[tokio::test]
    async fn stop_ends_the_turn_and_drops_it() {
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Dropped(dropped.clone());
        let endless = async_stream::stream! {
            let _flag = flag;
            loop {
                tokio::time::sleep(Duration::from_millis(10)).await;
                yield "x".to_string();
            }
        };
        let run = start("u-stop", "t-stop", endless).await;
        assert!(!stop("someone-else", "t-stop"));
        assert!(stop("u-stop", "t-stop"));
        run.wait_done(Duration::from_secs(5)).await;
        assert!(run.is_done());
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!stop("u-stop", "t-stop"));
    }

    #[tokio::test]
    async fn a_new_turn_replaces_the_running_one() {
        let endless = async_stream::stream! {
            loop {
                tokio::time::sleep(Duration::from_millis(10)).await;
                yield "old".to_string();
            }
        };
        let old = start("u-new", "t-new", endless).await;
        let new = start("u-new", "t-new", frames(&["new"])).await;
        assert!(old.is_done());
        assert_eq!(get("u-new", "t-new").unwrap().id, new.id);
        let replay: Vec<String> = follow(new).collect().await;
        assert_eq!(replay, ["new"]);
    }

    #[test]
    fn turns_are_per_user() {
        assert!(get("nobody", "t-keep").is_none());
    }
}
