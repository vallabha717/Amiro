# Phase 5 — UI suite (Playwright)

> **Status:** SHIPPED (2026-08-19) — Progress report in [`docs/testing/progress/phase-05-ui-playwright.md`](../progress/phase-05-ui-playwright.md) and verification log in [`docs/testing/progress/verification-log-phase-05.md`](../progress/verification-log-phase-05.md).

**Depends on:** 0, 1, 3 · **Blocks:** 7 · **Size:** L

Browser end-to-end against the **real** Go backend serving the **real**
static bundle, with a trace, a video, a HAR and a console log for every
test, all landing in the run directory.

## Deliverables

### 1. `playwright.config.ts`

Nothing exists today — `pnpm test:e2e` is wired in `package.json` with no
config behind it. The new config lives at `tests/playwright.config.ts` and
derives everything from the harness:

```ts
const run = resolveRun();   // reads AMIRO_TEST_RUN_DIR, or shells amirotest env --surface ui

export default defineConfig({
  testDir: "./ui/specs",
  outputDir: path.join(run.dir, "ui"),
  reporter: [
    ["list"],
    ["json",  { outputFile: path.join(run.dir, "ui/results.json") }],
    ["html",  { outputFolder: path.join(run.dir, "ui/html"), open: "never" }],
    [require.resolve("./ui/support/timeline-reporter"), { runDir: run.dir }],
  ],
  use: {
    baseURL: run.baseUrl,
    trace: run.config.ui.trace,          // default "on" — always recorded
    video: run.config.ui.video,          // default "retain-on-failure"
    screenshot: run.config.ui.screenshot,
    viewport: run.config.ui.viewport,
    recordHar: { path: "network.har", content: "embed" },
  },
  projects: run.config.ui.browsers.map(name => ({ name, use: devices[browserOf(name)] })),
  workers: run.config.run.parallel,
  retries: run.config.run.retries,
  forbidOnly: !!process.env.CI,
});
```

`timeline-reporter` is the piece that makes cross-surface debugging work:
it appends Playwright's action and assertion events into the shared
`events.ndjson` so browser clicks interleave with backend requests on one
clock ([04](../04-artifacts-and-logs.md)).

`resolveRun()` shelling out to `amirotest env --surface ui` when
`AMIRO_TEST_RUN_DIR` is unset is what makes a bare
`pnpm playwright test ui/specs/chat` work with no orchestration.

### 2. The `amiro` fixture

```ts
export const test = base.extend<AmiroFixtures>({
  amiro:   async ({}, use) => { /* per-test backend: fresh DB, workspace, port */ },
  signedIn: async ({ amiro, page }, use) => { /* logged in as accounts.user */ },
  admin:    async ({ amiro, page }, use) => { /* logged in as accounts.admin */ },
});
```

The fixture starts a **per-test backend** by calling `amirotest backend
start --json` (a harness subcommand), which returns the base URL, the
token, and the seeded accounts. Same isolation guarantees as every Go
suite: fresh database, fresh workspace, own port, no shared state.

It also wires console messages and page errors into `console.ndjson` and
`pageerrors.ndjson`, and **fails the test on an uncaught page error** by
default. An unhandled exception in the browser is a bug, and silently
passing over it is how UI rot accumulates.

### 3. Page objects

`ui/pages/` — one object per screen, mirroring `src/app`'s route groups:
`SignInPage`, `SignUpPage`, `OnboardingPage`, `ChatPage`, `AgentsPage`,
`AgentDetailPage`, `McpPage`, `WorkflowPage`, `ArchivePage`, `AdminPage`,
`ExportPage`, `SettingsPage`.

Selectors are `data-testid` attributes. Phase 5 includes **adding those
attributes to `src/`** — the only product-code change outside Phase 0.
Selecting on class names or text in a Tailwind + i18n app (this one has
`next-intl` and a `messages/` directory) produces tests that break on every
copy change and every locale.

### 4. Spec directories

`--feature <name>` maps directly to these:

| Feature | Journeys |
|---|---|
| `auth` | Sign up (first user becomes admin), sign in, sign out, wrong password, session persistence across reload, protected routes redirect, `RequireAuth` / `RequireAdmin` client guards |
| `onboarding` | The first-run flow end to end |
| `chat` | Send a message, tokens stream into the bubble, tool cards render, approval dialog approve/deny, interrupt, multi-turn, thread persists across reload, markdown/code/katex/mermaid render |
| `threads` | List, switch, rename, delete, delete-all, search |
| `agents` | Create, edit, delete, use in a chat, AI-generate |
| `mcp` | Add a server (the fixture server), see its tools, call one, customize, delete, handle a server that crashes |
| `workflow` | Build a graph in the `@xyflow/react` editor, save, execute, watch node results |
| `archive` | Create, add items, remove, delete |
| `export` | Export a thread, open the public link **signed out**, comment, delete |
| `admin` | Admin sees admin UI, non-admin gets 403/redirect, user management |
| `settings` | Provider keys (and never rendered back), model selection, theme, language |
| `dashboard` | The Phase 0 served dashboard: deep links on hard refresh, `0.0.0.0` reachability, login over the network |
| `a11y` | Keyboard navigation on the primary flows, focus management in dialogs, axe scan on each main screen |
| `responsive` | Mobile and tablet viewports on the primary flows |

### 5. Visual regression — deliberately scoped small

Full-page screenshot diffing on an app with animations (`framer-motion`,
`ogl`), streaming content and themes produces a maintenance burden that
outweighs its value. Scope it to a handful of stable, high-signal
components with animations disabled and streaming stubbed: the sign-in
form, the settings panel, an empty chat, a rendered tool card. Everything
else relies on behavioural assertions.

## Exit criteria

1. `amirotest run --surface ui` passes against the Phase 0 embedded server in under 5 minutes.
2. Every test produces a `trace.zip` openable with `playwright show-trace`; failures also produce a video.
3. `events.ndjson` interleaves browser actions with backend requests on one clock for a chosen failing test.
4. `amirotest run --surface ui --feature chat` runs only chat specs, in under 60 seconds.
5. `pnpm playwright test ui/specs/chat/streaming.spec.ts --headed` works standalone with no orchestrator, and still writes into a run directory.
6. Deep links load on hard refresh — the Phase 0 SPA-fallback contract, verified from a browser.
7. Uncaught page errors fail their test.
8. No spec uses a hard-coded wait; enforced by a `suites/meta/` guard.
9. Every `src/app` route group has at least one spec.

## Risks

- **`data-testid` churn in product code.** Adding attributes touches many components. Do it as one reviewable pass, and add a guard that a page object's selectors all resolve — a renamed testid should fail loudly.
- **Streaming assertions.** Playwright's auto-waiting handles most of it, but "the full response finished" needs an explicit signal. Prefer a `data-state` attribute on the message container over polling text length.
- **Static export quirks.** `output: "export"` means client-side routing and no server components. Phase 0's fallback rules are the contract; the `dashboard` feature is where they are verified from a browser rather than from Go.
- **Animation flakiness.** Disable animations globally in the test fixture via `prefers-reduced-motion` and a CSS override, except in the specs that exist to test them.
- **Browser install in CI.** `pnpm playwright install --with-deps chromium` is a setup step with its own cache; getting it wrong is a slow-CI problem, not a correctness one.
