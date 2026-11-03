//! A git history of the agent's home, so any change the agent makes to its own
//! files, notes or scripts can be seen and undone.
//!
//! The home is made a repository when it is seeded (with the `.gitignore` from
//! `agent-home/workspace.gitignore`, which keeps runtime data, scratch work and
//! binaries out), and a snapshot is committed after each chat turn and
//! heartbeat. Snapshots are local only: the repository has no remote and its
//! commits are made as "Amiro" with the user's hooks and signing switched off.
//!
//! Best effort throughout: no git on the machine, a workspace that is already
//! someone else's repository, or a failing commit never affects the turn.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;

/// One snapshot at a time across the process: two turns ending together would
/// otherwise race for git's index lock and one would be lost.
static SNAPSHOT: Mutex<()> = Mutex::new(());

fn git(workspace: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args([
            "-c",
            "user.name=Amiro",
            "-c",
            "user.email=amiro@localhost",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Whether `workspace` is the root of its own repository (never one it merely
/// sits inside, such as a folder in the user's project).
pub fn is_tracked(workspace: &Path) -> bool {
    workspace.join(".git").exists()
}

/// Make the workspace a repository and take the first snapshot. Does nothing
/// when it already is one, or when it sits inside another repository: its
/// history belongs to that repository's owner.
pub fn init(workspace: &Path) {
    if is_tracked(workspace) || git(workspace, &["rev-parse", "--show-toplevel"]).is_some() {
        return;
    }
    if git(workspace, &["init", "-q"]).is_none() {
        return;
    }
    snapshot(workspace, "Workspace created");
}

/// Commit every tracked change, if there is any. Returns whether a snapshot
/// was taken.
pub fn snapshot(workspace: &Path, message: &str) -> bool {
    if !is_tracked(workspace) {
        return false;
    }
    let _guard = SNAPSHOT.lock().unwrap_or_else(|e| e.into_inner());
    if git(workspace, &["add", "-A"]).is_none() {
        return false;
    }
    let changed = git(workspace, &["status", "--porcelain"]).is_some_and(|s| !s.trim().is_empty());
    changed && git(workspace, &["commit", "-q", "-m", message]).is_some()
}

/// [`snapshot`] off the async runtime, fire and forget.
pub fn snapshot_later(workspace: std::path::PathBuf, message: String) {
    tokio::task::spawn_blocking(move || snapshot(&workspace, &message));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("amiro-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn log(ws: &Path) -> Vec<String> {
        git(ws, &["log", "--format=%s"]).unwrap().lines().map(str::to_string).collect()
    }

    #[test]
    fn edits_are_snapshotted_and_ignored_files_stay_out() {
        let ws = tmp();
        std::fs::write(ws.join(".gitignore"), crate::agent_home::WORKSPACE_GITIGNORE).unwrap();
        std::fs::create_dir_all(ws.join("scratch")).unwrap();
        std::fs::write(ws.join("SOUL.md"), "first").unwrap();
        init(&ws);
        assert!(is_tracked(&ws));
        assert_eq!(log(&ws), ["Workspace created"]);

        assert!(!snapshot(&ws, "nothing changed"), "no empty snapshots");
        std::fs::write(ws.join("SOUL.md"), "second").unwrap();
        std::fs::write(ws.join("scratch/tmp.py"), "print(1)").unwrap();
        std::fs::write(ws.join("photo.png"), [0u8; 4]).unwrap();
        assert!(snapshot(&ws, "Chat: Plan the launch"));
        assert_eq!(log(&ws), ["Chat: Plan the launch", "Workspace created"]);
        let tracked = git(&ws, &["ls-files"]).unwrap();
        assert!(tracked.contains("SOUL.md"));
        assert!(!tracked.contains("scratch/") && !tracked.contains("photo.png"));

        // The earlier version is one restore away.
        git(&ws, &["restore", "--source=HEAD~1", "SOUL.md"]).unwrap();
        assert_eq!(std::fs::read_to_string(ws.join("SOUL.md")).unwrap(), "first");
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn a_workspace_inside_another_repository_is_left_alone() {
        let outer = tmp();
        git(&outer, &["init", "-q"]).unwrap();
        let ws = outer.join("agent-home");
        std::fs::create_dir_all(&ws).unwrap();
        init(&ws);
        assert!(!is_tracked(&ws));
        assert!(!snapshot(&ws, "x"));
        let _ = std::fs::remove_dir_all(outer);
    }
}
