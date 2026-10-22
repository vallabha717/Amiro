//! Vellum-style notification pipeline: signal → decision → broadcast →
//! adapters → audit. Producers emit free-form signals; the broadcaster fans
//! out to channel adapters and records every step.
//!
//! Phase 00 ships the domain with the deterministic decision and the local
//! adapter. The LLM decision (Phase 01) and external adapters (Phase 03)
//! plug into `decision.rs` and `adapters/` without changing this shape.

pub mod adapters;
pub mod broadcaster;
pub mod decision;
pub mod destinations;
pub mod presence;
pub mod signal;
pub mod store;

pub use broadcaster::{emit_signal, emit_signal_with_caller, subscribe};
pub use decision::Decision;
pub use signal::NotificationSignal;
