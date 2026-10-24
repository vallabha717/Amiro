//! Amiro's sandbox supervisor and its client.
//!
//! The supervisor (`amiro-sandboxd`) is the only process that holds the Docker
//! socket. It gives every team agent one hardened container that sees only the
//! agent's own folder, and runs that agent's shell and file tools there. The
//! backend reaches it over loopback with the supervisor token plus a credential
//! derived for the one agent it is acting for.
//!
//! See `docs/multi-agent-team-isolation/01-architecture.md`.

pub mod client;
pub mod credential;
pub mod docker;
pub mod paths;
pub mod server;
pub mod spec;

/// Agent ids are the registry's: 32 lowercase hex characters, or `"main"` for
/// the primary agent's virtual desktop container. Checked before an id is used
/// in a container name, a label or a mount path.
pub fn valid_agent_id(id: &str) -> bool {
    id == "main" || (id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Header carrying the per-agent credential on agent-scoped routes.
pub const CREDENTIAL_HEADER: &str = "x-amiro-agent-credential";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_ids_are_32_lowercase_hex() {
        assert!(valid_agent_id("0123456789abcdef0123456789abcdef"));
        assert!(valid_agent_id("main"));
        assert!(!valid_agent_id("0123456789ABCDEF0123456789abcdef"));
        assert!(!valid_agent_id("../../etc/passwd0123456789abcdef0"));
        assert!(!valid_agent_id(""));
    }
}
