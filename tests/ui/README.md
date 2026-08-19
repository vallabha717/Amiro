# Amiro UI Test Suite (Playwright)

The Playwright UI test suite validates Amiro's web application surface end-to-end against real, hermetic backend instances.

## Architecture

- **Go ↔ TypeScript Runner Seam**: The UI suite uses `amirotest env --surface ui [--json]` (or `amirotest backend start/stop`) to mint/join test runs, launch isolated Go server backends (`-tags embedui`), and provide dynamic base URLs, authentication tokens, and run log directories to Playwright worker processes.
- **Per-test backend isolation**: The `amiro` fixture in `fixtures.ts` is test-scoped, not worker-scoped — every test gets its own fresh SQLite database, workspace, port and pre-seeded accounts (`user@amiro.test`, `admin@amiro.test`) via `amirotest backend start`. A worker running several tests in sequence never shares a backend across them.
- **Page Objects**: Located in `tests/ui/pages/index.ts`, encapsulating locators, navigation, and user actions for all application routes (`SignInPage`, `SignUpPage`, `OnboardingPage`, `ChatPage`, `ThreadsPage`, `AgentsPage`, `AgentDetailPage`, `McpPage`, `WorkflowPage`, `ArchivePage`, `AdminPage`, `ExportPage`, `SettingsPage`).
- **Fixtures & Observers**: Defined in `tests/ui/support/fixtures.ts`, providing automated token-injected contexts (`signedIn`, `admin`), capturing browser console output to `console.ndjson`, capturing uncaught exceptions to `pageerrors.ndjson`, and enforcing test isolation. The `context` fixture builds its own `browser.newContext()` (baseURL is per-test, not global) and so also hand-wires `recordVideo` and replicates Playwright's `on`/`off`/`retain-on-failure`/`on-first-retry` policy — a custom context fixture does not inherit that from `playwright.config.ts` for free.
- **Results reporting**: `tests/ui/support/timeline-reporter.ts` writes two things per test — an `events.ndjson` entry (interleaved with the Go harness's own backend `process`/`http` events on one clock) and a `results.ndjson` entry in the exact shape `tests/harness/run/summary.go`'s `TestResult` decodes, which is what lets `amirotest run --surface ui`'s summary show real pass/fail/skip counts instead of `0 passed`.
- **Zero-Wait Invariant**: Spec files never use hardcoded timeouts (`sleep`, `page.waitForTimeout`); assertions rely exclusively on web-first locators and reactive predicates (`toBeVisible`, `waitForURL`, `expect.poll`). Enforced by `suites/meta/ui_guard_test.go`, not just convention.
- **Expected-fail probes**: A test that exists to prove something fails on purpose (see `errors/page-error-fails.spec.ts`) does not belong in the default green suite. The pattern is `test.skip(!process.env.AMIRO_RUN_EXPECTED_FAIL_SPECS, "reason")` as the first line of the test body, so it shows up as a *named, reasoned* skip in a normal run and only actually executes — and fails — when invoked directly with that env var set.

## Running Tests

### Standalone (Playwright Runner)
```bash
cd tests
pnpm exec playwright test
```

### Via Amiro Unified Runner
```bash
# Run entire UI surface
amirotest run --surface ui

# Filter by feature
amirotest run --surface ui --feature auth
amirotest run --surface ui --feature chat
amirotest run --surface ui --feature admin
```

### Meta Guard Verification
```bash
cd tests
go test -v ./suites/meta/...
```

### Stability (flake) check
```bash
cd tests
pnpm exec playwright test ui/specs/chat --repeat-each=3
```

### Verifying an expected-fail probe (e.g. Criterion 7)
```bash
cd tests
unset AMIRO_TEST_RUN_DIR AMIRO_TEST_RUN_ID
AMIRO_RUN_EXPECTED_FAIL_SPECS=1 pnpm exec playwright test ui/specs/errors/page-error-fails.spec.ts
# exits non-zero -- that is the point
```

## Directory Structure
```
tests/ui/
├── pages/
│   └── index.ts          # Page Object Models for all routes
├── specs/
│   ├── a11y/             # Accessibility and semantic landmarks
│   ├── admin/            # Admin dashboard tabs and RBAC boundaries
│   ├── agents/           # Agent listing, filtering, and creation
│   ├── archive/          # Archived conversation management
│   ├── auth/             # Sign-in, sign-up wizard, protected routes
│   ├── chat/             # Chat threads, streaming, store state
│   ├── dashboard/        # SPA fallback and deep linking
│   ├── errors/           # page-error-allowed.spec.ts (escape hatch, logs and
│   │                     # continues) + page-error-fails.spec.ts (no escape
│   │                     # hatch, expected to fail -- gated, see above)
│   ├── export/           # Data and conversation export forms
│   ├── mcp/              # MCP server management
│   ├── onboarding/       # AI provider onboarding wizard
│   ├── responsive/       # Viewport responsiveness
│   ├── settings/         # Profile and preferences modal
│   ├── visual/           # Visual UI component rendering
│   └── workflow/         # Workflow automation builder
├── support/
│   ├── fixtures.ts         # Test fixtures, auth injection, video/log sinks
│   ├── timeline-reporter.ts # events.ndjson + results.ndjson per test
│   └── resolve-run.ts     # joins or mints a run (AMIRO_TEST_RUN_DIR or `amirotest env`)
└── README.md
```

Known coverage gaps, not hidden by the directory listing above: `archive`,
`workflow` and `export` each have exactly one `expect` today (a smoke
check, not the full journey the phase doc describes for each), and
`chat/streaming.spec.ts` cannot currently distinguish a real assistant
reply from a provider-not-configured error frame — see
`docs/testing/progress/phase-05-ui-playwright.md`'s Follow-ups for both.
