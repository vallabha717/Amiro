//! Amiro fork policy gates for the vendored runtime.
//!
//! Amiro owns this runtime as a fork of the MIT-licensed upstream engine
//! (see `runtime/LICENSE` and `docs/RUST-RUNTIME.md`). Two upstream behaviours
//! are *default-deny* here, because both would let an Amiro installation act on
//! the upstream vendor's infrastructure instead of the operator's:
//!
//! 1. **Self-replacement.** The upstream auto-updater downloads a release from
//!    the upstream GitHub repository and swaps the running executable. In an
//!    Amiro install that would silently replace Amiro's runtime with the
//!    upstream binary.
//! 2. **Upstream telemetry / discovery.** The upstream client posts usage,
//!    lifecycle and optional transcript events to upstream endpoints. Amiro must
//!    not forward its users' data to the upstream vendor under fork branding.
//!
//! Both stay compiled in and remain testable, but they are off unless an
//! operator explicitly opts in with the environment variables below. The
//! upstream endpoints, repository and lease identities themselves are left
//! untouched on purpose (see the "preserved identities" section of
//! `docs/RUST-RUNTIME.md`), so an operator who does opt in talks to the real
//! upstream service rather than to a URL that does not exist.
//!
//! Amiro's own services are not covered here. When Amiro ships its own update
//! feed or telemetry, they need their own explicit gates and must not reuse
//! these opt-ins.

/// Environment variable that re-enables the upstream self-updater.
pub const ALLOW_UPSTREAM_UPDATE_ENV: &str = "AMIRO_ALLOW_UPSTREAM_UPDATE";
/// Environment variable that re-enables upstream telemetry and discovery beacons.
pub const ALLOW_UPSTREAM_TELEMETRY_ENV: &str = "AMIRO_ALLOW_UPSTREAM_TELEMETRY";

/// Whether an environment variable is set to an affirmative value.
///
/// Unset, empty, `0`, `false`, `no` and `off` all count as "not set", matching
/// the opt-out conventions the upstream engine already uses.
fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| {
        !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        )
    })
}

/// Whether the upstream self-updater may install or switch binaries.
///
/// Default: `false`. Amiro never replaces its own runtime with an upstream
/// build unless an operator sets [`ALLOW_UPSTREAM_UPDATE_ENV`].
pub fn upstream_auto_update_enabled() -> bool {
    env_flag(ALLOW_UPSTREAM_UPDATE_ENV)
}

/// Whether upstream telemetry, transcript sharing and discovery beacons may be
/// sent to the upstream vendor.
///
/// Default: `false`. This is independent of, and stricter than, the upstream
/// `AMIRO_NO_TELEMETRY` / `DO_NOT_TRACK` opt-outs: those can only turn
/// telemetry further off, never on.
pub fn upstream_telemetry_enabled() -> bool {
    env_flag(ALLOW_UPSTREAM_TELEMETRY_ENV)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Environment mutation is process-global; these tests only read the flags
    // through one variable each and run with an explicit guard so a parallel
    // test cannot observe a half-set value.
    struct EnvGuard(Option<std::ffi::OsString>, &'static str);

    impl EnvGuard {
        fn unset(name: &'static str) -> Self {
            let previous = std::env::var_os(name);
            unsafe { std::env::remove_var(name) };
            Self(previous, name)
        }

        fn set(name: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(name);
            unsafe { std::env::set_var(name, value) };
            Self(previous, name)
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => unsafe { std::env::set_var(self.1, value) },
                None => unsafe { std::env::remove_var(self.1) },
            }
        }
    }

    #[test]
    fn upstream_services_are_disabled_by_default() {
        let _update = EnvGuard::unset(ALLOW_UPSTREAM_UPDATE_ENV);
        let _telemetry = EnvGuard::unset(ALLOW_UPSTREAM_TELEMETRY_ENV);
        assert!(!upstream_auto_update_enabled());
        assert!(!upstream_telemetry_enabled());
    }

    #[test]
    fn opt_in_requires_an_affirmative_value() {
        for value in ["0", "false", "no", "off", ""] {
            let _update = EnvGuard::set(ALLOW_UPSTREAM_UPDATE_ENV, value);
            let _telemetry = EnvGuard::set(ALLOW_UPSTREAM_TELEMETRY_ENV, value);
            assert!(!upstream_auto_update_enabled(), "{value:?}");
            assert!(!upstream_telemetry_enabled(), "{value:?}");
        }
        let _update = EnvGuard::set(ALLOW_UPSTREAM_UPDATE_ENV, "1");
        let _telemetry = EnvGuard::set(ALLOW_UPSTREAM_TELEMETRY_ENV, "true");
        assert!(upstream_auto_update_enabled());
        assert!(upstream_telemetry_enabled());
    }
}
