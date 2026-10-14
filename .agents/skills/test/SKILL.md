---
name: test
description: Amiro's testing standards and the `tests/` harness — how every change gets proven end to end across all five surfaces (backend API, terminal UI, web dashboard, Tauri desktop, cross-surface). Covers where a test goes (`tests/suites/<surface>/<feature>/` and `tests/ui/specs/<feature>/`), how to write one with `harness.New(t)` or the Playwright fixtures, the fake provider and cassettes, golden screens, the `suites/meta/` guards that fail the build when a route is untested, isolation and artifacts, and the selection commands. Use whenever adding or changing a feature, route, screen, component or keybinding — testing is part of the work, not a follow-up — and whenever asked to write, run, fix, select or debug tests, chase a flake, or check coverage of a surface.
---

> ## ⚠️ RETIRED: the `tests/` Go harness no longer runs
>
> `tests/` targeted the removed Go `backend-go` backend, so nothing in it
> builds or runs now. Its fixtures and suites are kept as historical
> reference, not deleted. The current test entry points are
> `node --test adapter/test/usage.test.mjs` (unit) and
> `node adapter/test/live-smoke.mjs` (optional; needs a running, authenticated
> preview), plus the frontend's `pnpm test` / `pnpm check-types`. The
> cross-surface, all-five-surfaces model described below is **historical**;
> see [`docs/AMIRO-RUNTIME.md`](../../../docs/AMIRO-RUNTIME.md).

# Amiro Testing Standards

Amiro's lifecycle is meant to be driven end to end by agents. That only
works if every change arrives with the test that proves it, on **every
surface it reaches**. This skill is how.

The plan behind the system is `docs/testing/`; what is actually built is
`docs/testing/progress/`; the user-facing guide is `tests/README.md`. Read
`docs/testing/03-selection.md` when you need addressing, and
`docs/testing/05-recording-and-replay.md` before touching provider traffic.

## The rule

> **A feature is not done until its test exists, runs, and passes in
> `tests/`.** Not "will be added later", not "covered by a unit test
> somewhere". If a change reaches a surface, that surface gets a test.

Two guards already enforce parts of this, and they fail the build, not a
review:

- `suites/meta/route_coverage_test.go` parses
  `backend-go/internal/httpserver/router.go` and fails if any registered
  route is neither exercised by `suites/backend/` nor waived in
  `suites/meta/waivers.yaml` with an owner and a reason. **Adding a route
  without a test breaks the build.**
- `suites/meta/boundary_test.go` fails on a suite importing another suite,
  on any test importing `amiro/backend`, on duplicate test addresses, and
  on `time.Sleep` anywhere in a suite. `ui_guard_test.go` does the same for
  `page.waitForTimeout` / `setTimeout` / `setInterval` in specs.

## Where a test goes

The **directory path is the test's address**. There is no registry to
update; adding a feature means creating a directory.

```
tests/
├── suites/<surface>/<feature>/*_test.go     Go surfaces
│   ├── backend/    API, storage, providers, agent loop, resilience, perf, security
│   ├── tui/        the terminal UI under a real PTY
│   ├── desktop/    Tauri lifecycle, sidecar handoff, ports, orphans, packaging
│   ├── cross/      journeys spanning two or more surfaces
│   └── meta/       the guards — tests OF the test system
├── ui/specs/<feature>/*.spec.ts             Playwright — the web dashboard
├── ui/pages/index.ts                        page objects (locators live here)
├── ui/support/fixtures.ts                   the `amiro` / `signedIn` / `admin` fixtures
├── harness/                                 the ONLY shared code
├── fixtures/                                data, not code
└── cassettes/                               committed provider recordings
```

Pick the surface by what the test drives, not by what it is about:

| The change is… | Test it in |
|---|---|
| A new/changed HTTP route, repository, migration, auth rule | `suites/backend/<feature>/` |
| A TUI screen, keybinding, launch flag, `amiro run` behaviour | `suites/tui/<feature>/` (+ a golden in `internal/tui` for pure rendering) |
| A dashboard page, component, form, client-side gate | `ui/specs/<feature>/` |
| Sidecar lifecycle, port handoff, packaging, orphan kill | `suites/desktop/<feature>/` |
| A behaviour that must agree across surfaces (a thread visible in TUI and browser, a shared config, an approval) | `suites/cross/<feature>/` |
| A contract the test system itself must enforce | `suites/meta/` |

**A feature that reaches more than one surface gets a test on each**, plus a
`cross` test if the surfaces must agree. That is the whole point of the
`cross` suite — a dashboard test and a TUI test both passing does not prove
they see the same thread.

## Writing a Go test

```go
package thread_test

import (
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

func TestThread_ListReturnsOnlyTheCallersOwn(t *testing.T) {
	h := harness.New(t)        // config + run dir + isolated backend + cleanup
	alice := h.As("user")      // a seeded, signed-in identity
	bob := h.As("other")

	threads, err := alice.ListThreads(t.Context())
	if err != nil {
		t.Fatalf("listing threads: %v", err)
	}
	if len(threads) != 0 {
		t.Errorf("threads = %d, want 0", len(threads))
	}
	_ = bob
}
```

- **`harness.New(t)` is the entire entry ceremony.** It resolves config,
  creates the run directory, builds and starts an isolated backend on an
  OS-assigned port, seeds accounts through the real API, and registers
  teardown that asserts the process exited and the port is free.
- **Name tests `Test<Area>_<WhatIsAsserted>`** — `TestThread_GetNonexistentReturns404`,
  `TestLaunch_AttachesToRunningBackend`. The name is half the failure report.
- **Three seeded identities, and the order matters**: `admin` is registered
  first because `internal/auth` makes the first account the admin;
  `user` and `other` are two distinct non-admins, which is what every
  "can B see A's data?" test needs.
- Talk to the API through `h.As(...)` / `h.Client()` (the typed
  `apiclient`), never a raw `http.Client` — every exchange is logged and
  redacted for you. `apiclient.StatusOf(err)` gets the status code.
- **Nothing imports the application.** The harness reaches Amiro over HTTP,
  a PTY and a browser, exactly as a user does.

### Harness options

| Option | For |
|---|---|
| `harness.Tags("smoke")` | Cross-cutting properties; `--tag` selection honours them. Also `slow`, `live`, `flaky` — all excluded from the default run |
| `harness.NoSeed()` | A genuinely empty database — first-run and onboarding tests |
| `harness.NoBackend()` | Config + run directory only; no server |
| `harness.With(fn)` | Override config for this test alone |
| `harness.Seeds(...)` | Extra fixtures beyond the default accounts |
| `harness.WithFake(fn)` | Script the fake provider (below) |
| `harness.WithCassette(name)` / `ProviderMode(...)` | Replay or record real provider traffic |
| `harness.BuildTags("embedui")` | Build the binary under test with a tag |

### Provider traffic — never call a real API by default

| Situation | Use |
|---|---|
| Deterministic model behaviour (the common case) | `harness.WithFake(...)` — script the response |
| Proving real provider wire compatibility | a cassette: record once with `amirotest record`, replay by default |
| A test that genuinely needs the network | tag it `live`; it is excluded from the default run |

```go
h := harness.New(t, harness.WithFake(func(s *fakeprovider.Server) {
	s.OnPrompt(fakeprovider.Contains("capital of France")).
		StreamText("The capital of France is Paris.")
}))
```

The fake also models failure: `.Error(status, body)`, `.TruncateStreamAfter(n)`,
`.MalformedSSE(...)`, `.MalformedToolArgs(...)`, `.OverContextWindow()`,
`.ResetMidStream(...)`, `.ToolCall(name, args).ThenStreamText(...)`. Use it
— the resilience suite is 31 tests built on exactly these.

### TUI tests

```go
sess := h.PTY(harness.PTYAppDataDir(be.AppDataDir), harness.PTYDir(be.WorkspaceRoot))
defer sess.Close()

if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
	t.Fatalf("TUI not ready: %v\nframe:\n%s", err, sess.Frame())
}
sess.SendLine("what is the capital of France")
sess.WaitForText("The capital of France is Paris.", 8*time.Second)
sess.WaitForStable(3 * time.Second)
```

- **Zero sleeps.** `WaitForStable` / `WaitForText` / `WaitForFrame` only —
  `suites/meta` greps for `time.Sleep` and fails the build.
- Always print `sess.Frame()` in a failure message; a PTY failure with no
  frame is unreadable.
- Golden screens via `h.GoldenScreen(name, frame)`, updated deliberately
  with `amirotest run --surface tui --update-golden`, never blind.
- Pure rendering stays in `backend-go/internal/tui/**`'s own golden tests.
  This suite asserts **behaviour and lifecycle** — don't duplicate.

## Writing a Playwright test

```ts
import { test, expect } from "../../support/fixtures";
import { ChatPage } from "../../pages";

test.describe("threads", () => {
  test("creates a thread and lists it in the sidebar", async ({ signedIn }) => {
    const chat = new ChatPage(signedIn);
    await expect(chat.input.first()).toBeVisible({ timeout: 15000 });
    await chat.sendMessage("First thread topic");
    await chat.waitForStreamingComplete();
  });
});
```

- Fixtures come from `../../support/fixtures`, never from `@playwright/test`
  directly — `amiro` (a real isolated backend), `signedIn`, and `admin` are
  what give the test its own server, database and accounts.
- **Locators live in `ui/pages/index.ts` as page objects**, keyed on
  `[data-testid="…"]`. A spec never inlines a CSS selector.
- Adding a testable element means adding `data-testid` in `src/` — treat it
  as part of the UI change, and see the `ui` skill.
- **No hardcoded waits.** `page.waitForTimeout`, `setTimeout`, `setInterval`
  are grep-failed by `suites/meta/ui_guard_test.go`. Use `expect(...)`
  auto-waiting and event-based synchronisation.
- Trace, video, screenshot and HAR land in the run directory automatically.

## Isolation you get, and must not break

Per test, inside the run directory, torn down afterwards: its own backend
process and port, a fresh sqlite file (or a fresh postgres schema, dropped
on cleanup), a **copy** of the workspace fixture, its own `appdata/`, its
own `HOME`, a fresh auth token registered with the redactor, and a stripped
session bus so keyring writes land in the run directory.

Nothing is shared, so nothing is order-dependent, so parallelism is safe by
construction. **Do not introduce a shared temp path, a fixed port, a global
counter, or a real `$HOME` read** — a test that only passes alone is worse
than no test.

## Artifacts — where the evidence goes

```
tests/logs/<run-id>/           # logs/latest points at the newest
├── run.json  summary.md  summary.json  results.ndjson
├── events.ndjson              THE MERGED TIMELINE — every surface, one clock
├── backend/<test-id>/         server stdio, http.ndjson, appdata/ db/ workspace/ home/
└── ui/                        traces, video, HTML report
```

```bash
go run ./cmd/amirotest report --timeline --test 'backend/smoke/TestBackend_...'
pnpm show-trace logs/latest/ui/test-results/<...>/trace.zip
```

Redaction happens **at write time** — a secret that reaches disk once has
leaked. `suites/meta/secret_leak_test.go` greps the whole log tree for every
configured secret and fails if one appears. Never print a token, key or
password into a test log or a failure message.

## Running it

```bash
cd tests
go run ./cmd/amirotest doctor                        # what's installed, and what each gap means
go run ./cmd/amirotest run                           # everything selected by config
go run ./cmd/amirotest run --surface backend         # one surface
go run ./cmd/amirotest run --surface ui --feature chat
go run ./cmd/amirotest run --feature chat            # that feature on EVERY surface
go run ./cmd/amirotest run --tag smoke
go run ./cmd/amirotest list                          # every address that exists
go run ./cmd/amirotest run --surface tui --update-golden
```

The native runners work too, and produce the same artifacts — which is what
matters when iterating on one failure:

```bash
go test ./suites/backend/thread/ -run TestThread_ListReturnsOnlyTheCallersOwn -v -race
pnpm playwright test ui/specs/chat/threads.spec.ts --headed
```

No `config.yaml` and no API keys is a **valid, passing** configuration —
keep it that way. Exit codes: `0` pass · `1` a test failed · `2` config
error, nothing ran · `3` infrastructure failure. Do not collapse them.

## Definition of done, per change

1. The test exists in the right `suites/<surface>/<feature>/` or
   `ui/specs/<feature>/` directory.
2. Every surface the change reaches has one; a multi-surface behaviour also
   has a `cross` test.
3. New route → `suites/backend/` coverage, or a waiver with owner + reason.
   New schema → a `tests/migration` case on **both** dialects.
4. `go run ./cmd/amirotest run` is green, with every skip reasoned.
5. `suites/meta` is green — no sleeps, no cross-suite imports, no leaked
   secret, no uncovered route, no duplicate address.
6. Anything slow is tagged `slow`; anything needing the network is tagged
   `live`. The default run must not get slower than the project's stated
   budget.

## Anti-patterns

| Don't | Do |
|---|---|
| "I'll add tests in a follow-up" | ship the test with the change |
| `time.Sleep` / `page.waitForTimeout` | `WaitForStable` / `expect(...)` |
| A raw `http.Client` in a suite | `h.As(...)` / `h.Client()` |
| Importing `amiro/backend` from `tests/` | drive it over HTTP, PTY or the browser |
| Importing another suite | put shared code in `harness/` |
| A CSS selector inlined in a spec | a page object on `data-testid` |
| Calling a real provider by default | `WithFake` or a cassette; tag `live` otherwise |
| A green run over a silently skipped surface | make the skip reasoned and visible |
| Editing a golden to make a test pass | understand the diff, then `--update-golden` |
| Reporting a surface as covered because another surface passed | one test per surface, plus `cross` |
