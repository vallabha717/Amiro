# Amiro Tests

The Go test harness has been retired. Amiro uses a Rust desktop shell (Tauri), an offline std-only Rust testkit, and a Node adapter runtime for the backend.

* Backend: Node adapter (`adapter/src/server.mjs`) and Amiro runtime
* Desktop Shell: Tauri and Rust (`src-tauri/`)
* Rust Testkit: `tests/rust/` (`amiro-testkit`, std-only, offline)
* Web and E2E: Vitest and Playwright (`tests/ui/`)

## Test Commands

| Surface / Suite | Command | Notes |
|---|---|---|
| Node Adapter Unit | `node --test adapter/test/usage.test.mjs` | Node test runner |
| Node Adapter Live Smoke | `node adapter/test/live-smoke.mjs` | Requires running preview |
| Rust Testkit | `cargo test --offline` (in `tests/rust`) | Std-only, zero network dependencies |
| Tauri Desktop Check | `cargo check --offline` (in `src-tauri`) | Tauri shell check |
| Frontend Unit (Vitest) | `pnpm test` | Vitest test runner |
| UI E2E (Playwright) | `pnpm --dir tests test` | Playwright browser tests |

## Layout

```
tests/
  rust/                 Std-only Rust test harness (amiro-testkit)
  ui/                   Playwright browser specs
  fixtures/             Test fixtures (MCP, skills, workspace)
  cassettes/            Recorded provider interactions
  Taskfile.yml          Task runner definitions
  playwright.config.ts  Playwright configuration
```
