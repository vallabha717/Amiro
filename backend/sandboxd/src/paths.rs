//! Paths an agent may name in its file tools.
//!
//! Hygiene, not the boundary: every file action runs inside the agent's own
//! container, so even a path that slipped through could only reach that
//! container's view. Rejecting absolute and parent paths keeps tool results
//! predictable and errors clear.

/// Longest relative path accepted.
pub const MAX_PATH_LEN: usize = 1024;

/// A cleaned relative path under the agent's home, or a message saying why not.
/// `""` and `"."` mean the home folder itself.
pub fn clean_relative(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.len() > MAX_PATH_LEN {
        return Err("path is too long".into());
    }
    if raw.contains('\0') {
        return Err("path contains a NUL byte".into());
    }
    if raw.starts_with('/') || raw.starts_with('~') {
        return Err("use a path relative to your home folder, not an absolute path".into());
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err("paths may not contain '..'".into()),
            other => parts.push(other),
        }
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_relative_paths_and_rejects_escapes() {
        assert_eq!(clean_relative("notes/today.md").unwrap(), "notes/today.md");
        assert_eq!(clean_relative("./a//b/").unwrap(), "a/b");
        assert_eq!(clean_relative("").unwrap(), "");
        assert_eq!(clean_relative(".").unwrap(), "");
        assert!(clean_relative("/etc/passwd").is_err());
        assert!(clean_relative("~/x").is_err());
        assert!(clean_relative("../other/notes.md").is_err());
        assert!(clean_relative("a/../../b").is_err());
        assert!(clean_relative("a\0b").is_err());
        assert!(clean_relative(&"a".repeat(MAX_PATH_LEN + 1)).is_err());
    }
}
