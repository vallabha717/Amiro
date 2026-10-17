# 01: Architecture

## Where it lives

```
Amiro/
├── backend/               # Native Rust backend (axum, amiro-backend)
├── runtime/               # Vendored Rust runtime (amiro-runtime)
├── src/                   # Next.js frontend
├── src-tauri/             # Tauri 2 desktop shell
├── adapter/               # Retired Node compatibility harness (contract tests)
├── docs/testing/          # Testing documentation
└── tests/                 # Test suites (rust testkit, ui playwright, fixtures)
```

> Note on current architecture: The earlier Go test harness was retired.
> Testing now centers on:
> 1. Native Rust backend tests (`backend/tests/`)
> 2. Offline std-only Rust contract checks (`tests/rust/`, `amiro-testkit`)
> 3. Playwright browser specs (`tests/ui/`)
> 4. Verification scripts (`scripts/verify-native-ui.mjs`, `scripts/verify-schedules-ui.mjs`, `scripts/verify-agent-color-sync.mjs`)
> 5. Retired Node adapter unit/contract tests (`adapter/test/`)

## The test layout

```
tests/
├── rust/                      # Std-only Rust test harness (amiro-testkit)
│   ├── Cargo.toml
│   └── tests/                 # Sidecar, CLI, health, and contract checks
├── ui/                        # Playwright browser specs
│   ├── specs/                 # Visual, auth, chat, skills, schedules
│   ├── pages/                 # Page objects
│   └── support/               # Test fixtures and plant scripts
├── fixtures/                  # Fixture files (skills, workspaces, MCP)
├── cassettes/                 # Recorded interactions
├── Taskfile.yml               # Task definitions
└── playwright.config.ts       # Playwright configuration
```

## Running tests

```bash
# Native backend tests
cargo test --manifest-path backend/Cargo.toml

# Std-only Rust testkit
cargo test --offline --manifest-path tests/rust/Cargo.toml

# Playwright browser tests
pnpm test:e2e

# Node adapter contract tests
node --test adapter/test/*.test.mjs

# Browser verification scripts
pnpm verify:native-ui
pnpm verify:schedules-ui
node scripts/verify-agent-color-sync.mjs
```
