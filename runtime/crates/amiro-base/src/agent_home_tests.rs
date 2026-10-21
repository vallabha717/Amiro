use super::*;
use crate::prompt::{PromptCapabilities, build_system_prompt_full, build_system_prompt_split};

struct EnvGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    prev: Option<String>,
}

impl EnvGuard {
    fn new(value: Option<&Path>) -> Self {
        let lock = crate::storage::lock_test_env();
        let prev = std::env::var(AGENT_HOME_ENV).ok();
        match value {
            Some(p) => crate::env::set_var(AGENT_HOME_ENV, p),
            None => crate::env::remove_var(AGENT_HOME_ENV),
        }
        Self { _lock: lock, prev }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(v) => crate::env::set_var(AGENT_HOME_ENV, v),
            None => crate::env::remove_var(AGENT_HOME_ENV),
        }
    }
}

#[test]
fn unset_or_missing_dir_yields_none() {
    let _g = EnvGuard::new(None);
    assert!(load_agent_home_files(None).is_none());
    crate::env::set_var(AGENT_HOME_ENV, "");
    assert!(load_agent_home_files(None).is_none());
    crate::env::set_var(AGENT_HOME_ENV, "/nonexistent/amiro-home-xyz");
    assert!(load_agent_home_files(None).is_none());
}

#[test]
fn files_load_in_order_and_header_is_exact() {
    let t = tempfile::tempdir().unwrap();
    for (n, c) in [
        ("NOW.md", "now body"),
        ("SOUL.md", "soul body"),
        ("IDENTITY.md", "id body"),
        ("USER.md", "user body"),
        ("HEARTBEAT.md", "heartbeat body"),
    ] {
        std::fs::write(t.path().join(n), c).unwrap();
    }
    let _g = EnvGuard::new(Some(t.path()));
    let (block, chars) = load_agent_home_files(None).unwrap();
    assert_eq!(chars, block.len());
    assert!(block.starts_with(&format!("# Your agent home ({})\n", t.path().display())));
    let pos = |s: &str| block.find(s).unwrap();
    assert!(pos("## IDENTITY.md") < pos("## SOUL.md"));
    assert!(pos("## SOUL.md") < pos("## USER.md"));
    assert!(pos("## USER.md") < pos("## NOW.md"));
    assert!(!block.contains("## BOOTSTRAP.md"));
    assert!(!block.contains("HEARTBEAT") && !block.contains("heartbeat body"));
    std::fs::write(t.path().join("BOOTSTRAP.md"), "boot").unwrap();
    let (block, _) = load_agent_home_files(None).unwrap();
    assert!(block.contains("## BOOTSTRAP.md\nboot"));
}

#[test]
fn comment_lines_are_stripped_but_markdown_is_kept() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(
        t.path().join("NOW.md"),
        "_ a note\n_\n\n  _ indented note\n# Now\n_italic_ text\n__init__\n_ \nkeep\n",
    )
    .unwrap();
    let _g = EnvGuard::new(Some(t.path()));
    let (block, _) = load_agent_home_files(None).unwrap();
    assert!(block.contains("## NOW.md\n# Now\n_italic_ text\n__init__\nkeep"));
    assert!(!block.contains("a note") && !block.contains("indented note"));
}

#[test]
fn oversize_and_symlink_escape_are_skipped() {
    let t = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.md"), "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path().join("secret.md"), t.path().join("SOUL.md")).unwrap();
    std::fs::write(t.path().join("USER.md"), "x".repeat(65 * 1024)).unwrap();
    std::fs::create_dir(t.path().join("NOW.md")).unwrap();
    std::fs::write(t.path().join("IDENTITY.md"), "ok").unwrap();
    let _g = EnvGuard::new(Some(t.path()));
    let (block, _) = load_agent_home_files(None).unwrap();
    assert!(block.contains("## IDENTITY.md"));
    assert!(!block.contains("secret"));
    assert!(!block.contains("## SOUL.md"));
    assert!(!block.contains("## USER.md"));
    assert!(!block.contains("## NOW.md"));
}

#[test]
fn per_file_and_block_caps_apply() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("SOUL.md"), "a".repeat(30_000)).unwrap();
    let _g = EnvGuard::new(Some(t.path()));
    let (block, _) = load_agent_home_files(None).unwrap();
    assert!(block.contains(TRUNCATED_MARKER));
    let soul = block.split("## SOUL.md\n").nth(1).unwrap();
    assert_eq!(soul.chars().take_while(|c| *c == 'a').count(), MAX_FILE_CHARS);
    for n in ["IDENTITY.md", "USER.md", "NOW.md"] {
        std::fs::write(t.path().join(n), "b".repeat(16_000)).unwrap();
    }
    let (block, chars) = load_agent_home_files(None).unwrap();
    assert!(block.chars().count() <= MAX_BLOCK_CHARS + TRUNCATED_MARKER.chars().count() + 1);
    assert!(block.ends_with(TRUNCATED_MARKER));
    assert_eq!(chars, block.len());
}

#[test]
fn block_lands_in_prompts_and_is_reread_each_turn() {
    let t = tempfile::tempdir().unwrap();
    std::fs::write(t.path().join("NOW.md"), "first scratch").unwrap();
    let _g = EnvGuard::new(Some(t.path()));

    let (full, info) = build_system_prompt_full(None, &[], false, None, None);
    assert!(full.contains("## NOW.md\nfirst scratch"));
    assert!(info.agent_home_chars > 0);
    assert!(info.breakdown().iter().any(|(l, _, i)| *l == "agent home" && *i == "🏠"));

    let (split, info) = build_system_prompt_split(None, &[], false, None, None);
    assert!(!split.static_part.contains("Your agent home"));
    assert!(split.dynamic_part.contains("first scratch"));
    assert!(info.agent_home_chars > 0);

    std::fs::write(t.path().join("NOW.md"), "second scratch").unwrap();
    let (split, _) = build_system_prompt_split(None, &[], false, None, None);
    assert!(split.dynamic_part.contains("second scratch"));
    assert!(!split.dynamic_part.contains("first scratch"));
    let _ = PromptCapabilities::default;
}

/// Sets `AMIRO_AGENTS_ROOT` for one test; the agent-home guard holds the env lock.
struct RootGuard(Option<String>);

impl RootGuard {
    fn new(value: Option<&Path>) -> Self {
        let prev = std::env::var(AGENTS_ROOT_ENV).ok();
        match value {
            Some(p) => crate::env::set_var(AGENTS_ROOT_ENV, p),
            None => crate::env::remove_var(AGENTS_ROOT_ENV),
        }
        Self(prev)
    }
}

impl Drop for RootGuard {
    fn drop(&mut self) {
        match &self.0 {
            Some(v) => crate::env::set_var(AGENTS_ROOT_ENV, v),
            None => crate::env::remove_var(AGENTS_ROOT_ENV),
        }
    }
}

#[test]
fn team_agent_folder_replaces_the_main_home() {
    let main = tempfile::tempdir().unwrap();
    std::fs::write(main.path().join("IDENTITY.md"), "main agent").unwrap();
    let root = tempfile::tempdir().unwrap();
    let scout = root.path().join("scout");
    std::fs::create_dir_all(scout.join("notes")).unwrap();
    std::fs::write(scout.join("IDENTITY.md"), "scout agent").unwrap();
    let _g = EnvGuard::new(Some(main.path()));
    let _r = RootGuard::new(Some(root.path()));

    let (block, _) = load_agent_home_files(Some(&scout)).unwrap();
    assert!(block.contains("scout agent") && !block.contains("main agent"));
    // A sub-folder of the agent still belongs to that agent.
    let (block, _) = load_agent_home_files(Some(&scout.join("notes"))).unwrap();
    assert!(block.contains("scout agent"));
    // The root itself and folders outside it keep the main home.
    let (block, _) = load_agent_home_files(Some(root.path())).unwrap();
    assert!(block.contains("main agent"));
    let (block, _) = load_agent_home_files(Some(main.path())).unwrap();
    assert!(block.contains("main agent"));
}

#[test]
fn project_folder_with_identity_cannot_replace_the_persona() {
    let main = tempfile::tempdir().unwrap();
    std::fs::write(main.path().join("IDENTITY.md"), "main agent").unwrap();
    let project = tempfile::tempdir().unwrap();
    std::fs::write(project.path().join("IDENTITY.md"), "planted").unwrap();
    let _g = EnvGuard::new(Some(main.path()));
    let _r = RootGuard::new(None);
    let (block, _) = load_agent_home_files(Some(project.path())).unwrap();
    assert!(block.contains("main agent") && !block.contains("planted"));
}

#[test]
fn team_agent_persona_reaches_the_session_prompt() {
    let main = tempfile::tempdir().unwrap();
    std::fs::write(main.path().join("IDENTITY.md"), "main agent").unwrap();
    let root = tempfile::tempdir().unwrap();
    let scout = root.path().join("scout");
    std::fs::create_dir_all(&scout).unwrap();
    std::fs::write(scout.join("IDENTITY.md"), "scout agent").unwrap();
    let _g = EnvGuard::new(Some(main.path()));
    let _r = RootGuard::new(Some(root.path()));
    let (split, _) = build_system_prompt_split(None, &[], false, None, Some(&scout));
    assert!(split.dynamic_part.contains("scout agent"));
    assert!(!split.dynamic_part.contains("main agent"));
}
