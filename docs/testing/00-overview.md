# 00: Overview

## Why this exists

Amiro requires a test system that **drives the real binaries the way a user does**
and leaves behind enough evidence to tell you exactly where a run went wrong.

Everything below follows from that: real processes, real HTTP, real
terminals, real browsers, real recordings.

## The four surfaces

| Surface | What ships | Entrypoint | Test strategy |
|---|---|---|---|
| **Backend** | Native Rust HTTP API (axum), routes under `/api/*`, agent loop via amiro-sdk | `backend/src/main.rs` (`amiro-backend`) | Run with `cargo test --manifest-path backend/Cargo.toml` |
| **Runtime & TUI** | Vendored Rust runtime and TUI | `runtime/src/main.rs` (`amiro-runtime`) | Check with `cargo check --manifest-path runtime/Cargo.toml --bin amiro-runtime --no-default-features` |
| **UI** | Next.js static export (`output: "export"` -> `out/`) | Served directly by native backend | Playwright against the real native backend serving the real bundle |
| **Desktop** | Tauri v2 shell spawning the sidecars | `src-tauri` | Drive the lifecycle: spawn, sidecar handoff, shutdown |

## Principles

1. **Real processes over in-process handlers.** The root `tests/` tree talks to
   spawned binaries. In-process handler tests keep living next to the code
   they test.

2. **One artifact directory per run.** Every process, every surface, every
   language writes under `tests/logs/<run-id>/`. The harness exports
   `AMIRO_TEST_RUN_DIR` so Playwright and the desktop driver land in the same
   tree without knowing anything about the harness.

3. **Deterministic by default, real on demand.** Replayed provider traffic
   makes test runs reliable and zero-cost in CI. Live mode exercises the real
   providers when validating upstream protocol compatibility.

4. **Hermetic runs.** Each run receives its own temporary directory, its own
   config file, its own socket path, and its own SQLite database.

5. **Fast feedback.** Acceptance suites should execute in seconds locally,
   giving immediate confidence without burning network credits.

## Scope

- Native Rust backend tests (`backend/tests/`)
- Std-only contract checks (`tests/rust/`)
- Playwright UI tests (`tests/ui/`)
- Node adapter contract tests (`adapter/test/`)
- Verification scripts (`scripts/verify-*.mjs`)
