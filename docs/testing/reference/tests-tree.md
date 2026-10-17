# Reference: the `tests/` tree

This document records the current test directory layout for Amiro.

> Status note: The earlier Go test harness (`tests/cmd/amirotest`, `tests/harness/`, `tests/suites/`)
> has been retired and removed. The repository now uses native Rust backend tests (`backend/tests/`),
> an offline std-only Rust testkit (`tests/rust/`), Playwright browser suites (`tests/ui/`), and
> Node adapter contract tests (`adapter/test/`).

## The `tests/` layout

```
tests/
├── README.md                          # Quickstart and test commands overview
├── Taskfile.yml                       # Task runner targets
├── package.json · pnpm-lock.yaml      # UI test dependencies (Playwright)
├── playwright.config.ts               # Playwright configuration
│
├── rust/                              # Std-only Rust testkit (amiro-testkit)
│   ├── Cargo.toml                     # Offline package manifest (zero external crates)
│   ├── src/
│   │   └── lib.rs                     # Shared test utilities and contract helpers
│   └── tests/
│       ├── cli.rs                     # CLI arguments and flags tests
│       ├── health.rs                  # Health check endpoints
│       ├── mcp.rs                     # MCP contract checks
│       ├── real_files.rs              # File manipulation assertions
│       └── sidecar.rs                 # Tauri sidecar integration checks
│
├── ui/                                # Playwright browser suites
│   ├── pages/                         # Page objects
│   ├── support/                       # Fixtures, test helpers, and reporters
│   └── specs/                         # Feature test suites
│       ├── a11y/                      # Accessibility tests
│       ├── admin/                     # Admin and usage tests
│       ├── archive/                   # Thread archive specs
│       ├── auth/                      # Login and signup specs
│       ├── checkpoint/                # Checkpoint tests
│       ├── chat/                      # Chat interaction specs
│       ├── dashboard/                 # Dashboard view specs
│       ├── errors/                    # Error state tests
│       ├── export/                    # Chat export specs
│       ├── mcp/                       # MCP configuration specs
│       ├── onboarding/                # Onboarding workflow specs
│       ├── responsive/                # Responsive layout specs
│       ├── settings/                  # User settings specs
│       ├── skills/                    # Skills list and authoring specs
│       ├── visual/                    # Visual regression specs
│       └── workspacetrust/            # Workspace trust tests
│
├── fixtures/                          # Fixture data
│   ├── mcp/                           # MCP server fixture
│   ├── skills/                        # Test skill folders (.agents, .amiro, .claude, .codex)
│   └── workspaces/                    # Workspace test fixtures
│
└── cassettes/                         # Recorded provider responses
```

## Backend tests in `backend/tests/`

```
backend/tests/
├── native_acceptance.rs               # Core native backend integration
├── schedules_acceptance.rs            # Native schedules acceptance tests
├── schedule_durability.rs             # Cross-process lock and restart durability
├── agent_native.rs                    # Native agent endpoints and state
└── runtime_live.rs                    # Live runtime integration tests
```

## Verification scripts in `scripts/`

```
scripts/
├── verify-native-ui.mjs               # Native UI browser verification
├── verify-schedules-ui.mjs            # Schedules UI browser verification
├── verify-agent-color-sync.mjs        # Agent color persistence and theme sync
├── build-native.sh                    # Builds amiro-backend and amiro-runtime
└── start-native-ui-check.sh           # Runner for native UI browser check
```
