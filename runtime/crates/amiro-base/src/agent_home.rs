//! Agent "home" files loaded into the system prompt on every turn.
//!
//! The directory comes from `$AMIRO_AGENT_HOME`. Files are re-read from disk
//! on every call (no caching) so edits made by the agent show up next turn.
//! A session whose working folder is inside `$AMIRO_AGENTS_ROOT` belongs to a
//! team agent and loads that agent's folder instead.

use std::path::{Path, PathBuf};

pub const AGENT_HOME_ENV: &str = "AMIRO_AGENT_HOME";
/// Parent of the team agents' folders (`~/.amiro/agents`), set by the backend.
pub const AGENTS_ROOT_ENV: &str = "AMIRO_AGENTS_ROOT";
const AGENT_HOME_FILES: [&str; 5] = [
    "IDENTITY.md",
    "SOUL.md",
    "USER.md",
    "NOW.md",
    "BOOTSTRAP.md",
];
const MAX_FILE_BYTES: u64 = 64 * 1024;
const MAX_FILE_CHARS: usize = 16_000;
const MAX_BLOCK_CHARS: usize = 40_000;
const TRUNCATED_MARKER: &str = "[…truncated]";

/// Remove comment lines (`_ note` or a bare `_`) and trim surrounding blank lines.
fn strip_comment_lines(content: &str) -> String {
    let kept: Vec<&str> = content
        .lines()
        .filter(|line| {
            let t = line.trim();
            !(t == "_" || t.starts_with("_ "))
        })
        .collect();
    kept.join("\n").trim().to_string()
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let cut: String = text.chars().take(max_chars).collect();
    format!("{}\n{}", cut.trim_end(), TRUNCATED_MARKER)
}

fn read_home_file(dir: &Path, canonical_dir: &Path, name: &str) -> Option<String> {
    let path = dir.join(name);
    let canonical = match std::fs::canonicalize(&path) {
        Ok(p) => p,
        Err(_) => return None, // missing (or dangling symlink)
    };
    if !canonical.starts_with(canonical_dir) {
        crate::logging::warn(&format!(
            "agent home: skipping {name}: resolves outside {}",
            canonical_dir.display()
        ));
        return None;
    }
    let meta = std::fs::metadata(&canonical).ok()?;
    if !meta.is_file() {
        crate::logging::warn(&format!("agent home: skipping {name}: not a regular file"));
        return None;
    }
    if meta.len() > MAX_FILE_BYTES {
        crate::logging::warn(&format!(
            "agent home: skipping {name}: {} bytes exceeds {MAX_FILE_BYTES}",
            meta.len()
        ));
        return None;
    }
    let raw = std::fs::read_to_string(&canonical).ok()?;
    let stripped = strip_comment_lines(&raw);
    if stripped.is_empty() {
        return None;
    }
    Some(truncate_chars(&stripped, MAX_FILE_CHARS))
}

/// The home of the team agent whose folder contains `working_dir`: the first
/// path component under `$AMIRO_AGENTS_ROOT`. `None` when the root is unset or
/// the folder is outside it, so an arbitrary project folder that happens to
/// hold an `IDENTITY.md` can never replace the persona.
fn team_agent_home(working_dir: Option<&Path>) -> Option<PathBuf> {
    let root = std::env::var(AGENTS_ROOT_ENV).ok()?;
    let root = root.trim();
    if root.is_empty() {
        return None;
    }
    let root = std::fs::canonicalize(root).ok()?;
    let dir = std::fs::canonicalize(working_dir?).ok()?;
    let first = dir.strip_prefix(&root).ok()?.components().next()?;
    match first {
        std::path::Component::Normal(name) => Some(root.join(name)),
        _ => None,
    }
}

/// Load the agent-home block for a session working in `working_dir`. The home
/// is that team agent's folder when the session runs inside
/// `$AMIRO_AGENTS_ROOT`, else `$AMIRO_AGENT_HOME`. Returns `(block, chars)` or
/// `None` when no home resolves or no files exist.
pub fn load_agent_home_files(working_dir: Option<&Path>) -> Option<(String, usize)> {
    let dir = match team_agent_home(working_dir) {
        Some(home) => home.to_string_lossy().to_string(),
        None => std::env::var(AGENT_HOME_ENV).ok()?,
    };
    let dir = dir.trim();
    if dir.is_empty() {
        return None;
    }
    let dir_path = Path::new(dir);
    let canonical_dir = std::fs::canonicalize(dir_path).ok()?;
    if !canonical_dir.is_dir() {
        return None;
    }

    let mut sections = Vec::new();
    for name in AGENT_HOME_FILES {
        if let Some(body) = read_home_file(dir_path, &canonical_dir, name) {
            sections.push(format!("## {name}\n{body}"));
        }
    }
    if sections.is_empty() {
        return None;
    }

    let header = format!(
        "# Your agent home ({dir})\nThese files are yours and are loaded every turn. Keep them current with your file tools: SOUL.md (how you work — especially \"Working with …\"), USER.md (who the user is), NOW.md (your present-tense scratchpad). IDENTITY.md is set by the user on the Personality page. If BOOTSTRAP.md is present this is your first conversation: follow it, then delete it.\n\n"
    );
    let block = truncate_chars(&format!("{header}{}", sections.join("\n\n")), MAX_BLOCK_CHARS);
    let chars = block.len();
    Some((block, chars))
}

#[cfg(test)]
#[path = "agent_home_tests.rs"]
mod agent_home_tests;
