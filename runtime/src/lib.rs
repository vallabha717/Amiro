#![allow(
    unknown_lints,
    clippy::collapsible_match,
    clippy::manual_checked_ops,
    clippy::unnecessary_sort_by,
    clippy::useless_conversion
)]
// Tests hold the process-wide env lock across awaits on purpose.
#![cfg_attr(test, allow(clippy::await_holding_lock))]

//! Root `amiro` crate: the entrypoint + cli layer on top of the `amiro-tui`
//! presentation crate (which in turn re-exports `amiro-app-core` and
//! `amiro-base`).
//!
//! The presentation modules (`tui`, `video_export`) live in `amiro-tui` and the
//! non-presentation modules live in `amiro-app-core`; both are re-exported here
//! via `pub use amiro_tui::*`, so existing `crate::<module>` paths (e.g.
//! `crate::config`, `crate::server`, `crate::tui`) keep resolving unchanged
//! across the cli code that was not moved.

// Re-export the presentation layer (and, transitively, the application core)
// so `crate::tui`, `crate::video_export`, and `crate::<app-core module>` paths
// resolve.
pub use amiro_tui::*;

// Cli + entrypoint layer (kept in the root crate).
pub mod cli;

use anyhow::Result;

pub async fn run() -> Result<()> {
    cli::startup::run().await
}
