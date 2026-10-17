# Amiro Testing Plan

> Status note: The Go test harness (`amirotest`) has been retired along with the
> Go backend. Testing now consists of native Rust backend tests, std-only Rust
> contract checks (`tests/rust`), Playwright browser tests, Vitest frontend tests,
> Node adapter contract tests, and dedicated verification scripts.

The test system covers the surfaces Amiro ships: the **native Rust backend**
(`backend/`, `amiro-backend`), the **vendored Rust runtime** (`runtime/`,
`amiro-runtime`), the **web UI**, and the **Tauri desktop app**: with real
processes and reproducible checks.

## Current Test Surfaces and Commands

| Surface / Suite | Command | Notes |
|---|---|---|
| Native Rust Backend | `pnpm native:test` or `cargo test --manifest-path backend/Cargo.toml` | Full native backend integration and unit tests |
| Schedules Acceptance | `cargo test --manifest-path backend/Cargo.toml --test schedules_acceptance` | 13 native schedule acceptance tests |
| Schedules Durability | `cargo test --manifest-path backend/Cargo.toml --test schedule_durability` | 4 scheduler crash recovery and restart tests |
| Rust Testkit | `cargo test --offline` (in `tests/rust`) | Std-only, zero network dependencies (`amiro-testkit`) |
| Vendored Runtime | `pnpm runtime:check` or `cargo check --manifest-path runtime/Cargo.toml --bin amiro-runtime --no-default-features` | Runtime engine workspace check |
| Tauri Desktop Shell | `cargo check --offline` (in `src-tauri`) | Tauri shell check |
| Frontend Unit | `pnpm test` | Vitest test runner (350+ tests) |
| UI E2E | `pnpm test:e2e` or `pnpm --dir tests test` | Playwright browser tests |
| Adapter Contract Tests | `node --test adapter/test/*.test.mjs` | Retired Node adapter contract tests |
| Native UI Verification | `pnpm verify:native-ui` (`bash scripts/start-native-ui-check.sh`) | End-to-end browser check with real runtime |
| Schedules UI Verification | `pnpm verify:schedules-ui` (`node scripts/verify-schedules-ui.mjs`) | Browser verification for schedules UI and runtime |
| Agent Color Sync | `node scripts/verify-agent-color-sync.mjs` | Color persistence and theme synchronization check |

## Read in this order

| # | Document | What it settles |
|---|---|---|
| 00 | [Overview](00-overview.md) | Goals, the active surfaces, scope, principles, non-goals |
| 01 | [Architecture](01-architecture.md) | The `tests/` tree, contract testkit, module layout, run lifecycle |
| 02 | [Config](02-config.md) | Configuration schema, defaults, precedence order |
| 03 | [Selection](03-selection.md) | Run all / one surface / one feature / one test |
| 04 | [Artifacts & Logs](04-artifacts-and-logs.md) | Artifact layout, traces, video, casts, HAR |
| 05 | [Recording & Replay](05-recording-and-replay.md) | Cassettes, live mode, fake provider, redaction |
| 06 | [Fixtures & Seeding](06-fixtures-and-seeding.md) | Deterministic seeds, workspaces, MCP fixture server |
| 07 | [CI & Guardrails](07-ci.md) | Gates, matrices, flake policy, cost control |
| - | [**Progress**](progress/README.md) | Historical phase-by-phase implementation record |

## Reference

- [Target `tests/` tree](reference/tests-tree.md): directory listing
- [`config.example.yaml`](reference/config.example.yaml): annotated configuration template
