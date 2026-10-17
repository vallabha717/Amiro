# Amiro Tests

The Go test harness has been retired, as has the Go backend it targeted. The
backend is now the native Rust crate in `backend/` (binary `amiro-backend`), and
the engine is the vendored Rust runtime in `runtime/` (binary `amiro-runtime`).

* Backend: native Rust backend (`backend/`, `amiro-backend`) over the vendored runtime
* Desktop Shell: Tauri 2 and Rust (`src-tauri/`)
* Rust Testkit: `tests/rust/` (`amiro-testkit`, std-only, offline)
* Web and E2E: Vitest and Playwright (`tests/ui/`)
* Retired harness: `adapter/`, kept only for its contract tests

`adapter/` is **not** the backend and nothing starts it in production. It is a
retired Node compatibility harness, and its tests are kept because they still
pin the routes the native backend implements.

## Test Commands

| Surface / Suite | Command | Notes |
|---|---|---|
| Native backend (integration) | `cargo test --manifest-path backend/Cargo.toml` | Boots real servers over HTTP. Same as `pnpm native:test` |
| Runtime workspace check | `cargo check --manifest-path runtime/Cargo.toml --bin amiro-runtime --no-default-features` | Same as `pnpm runtime:check` |
| Frontend unit (Vitest) | `pnpm test` | Excludes `tests/**` and `adapter/**` via `vitest.config.ts` |
| Native UI acceptance | `pnpm verify:native-ui` | Stub provider, owned bridge, real backend, real browser |
| Schedules UI acceptance | `pnpm verify:schedules-ui` | `scripts/verify-schedules-ui.mjs` |
| Retired adapter contract tests | `node --test adapter/test/*.test.mjs` | Requires `pnpm --dir adapter install` |
| Retired adapter live smoke | `node adapter/test/live-smoke.mjs` | Requires a running, authenticated preview |
| Rust Testkit | `cargo test --offline` (in `tests/rust`) | Std-only, zero network dependencies |
| Tauri Desktop Check | `cargo check --offline` (in `src-tauri`) | Tauri shell check |
| UI E2E (Playwright) | `pnpm --dir tests test` | Playwright browser tests |

The backend integration tests spawn their own server per test and wait for
readiness. They are reliable in CI, but if you run the frontend suite, a cold
Rust build, and something else heavy on a small machine at the same time, they
can fail with a readiness or connection error. Re-run them alone, or with
`--test-threads=1`, before treating a failure as real.

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
