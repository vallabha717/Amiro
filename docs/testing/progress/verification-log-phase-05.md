# Verification Log: Phase 5 (UI Suite with Playwright) — Revised

**Date:** 2026-08-19
**Platform:** Linux (x86_64), headless Chromium under Xvfb where a real display was needed
**Surface:** `ui` (Playwright Chromium)

> This replaces the first verification log for Phase 5. That log checked a
> list of nine claims it invented itself, not the nine exit criteria in
> [`docs/testing/phases/phase-05-ui-playwright.md`](../phases/phase-05-ui-playwright.md#exit-criteria),
> and its Criterion 2 run reported **0 passed** while Playwright's own
> output showed 24 tests passing — see
> [`phase-05-ui-playwright.md`](phase-05-ui-playwright.md) §2 for how that
> happened and what fixed it. The sections below are the phase doc's nine
> criteria, verbatim, each with the command and its real output.

---

## 1. `amirotest run --surface ui` passes against the Phase 0 embedded server in under 5 minutes

Command:
```bash
cd tests && go run ./cmd/amirotest run --surface ui
```

Output (trimmed to the summary; the full per-test list is in the run
directory's `summary.md`):
```text
run 2026-08-19T14-41-47Z-ee32f1
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-19T14-41-47Z-ee32f1
  providers: replay · parallel: 4

── ui ──

Running 26 tests using 4 workers

  ✓   1 [chromium] › ui/specs/a11y/a11y.spec.ts:5:7 › a11y › keyboard navigation focus moves cleanly through sign-in inputs (8.5s)
  ... (23 more passing specs) ...
  -  16 [chromium] › ui/specs/errors/page-error-fails.spec.ts:23:7 › errors - expected-fail probe › uncaught page error fails the test (expected-fail probe; run in isolation, not part of the default suite)

  1 skipped
  25 passed (1.6m)

# Amiro test run 2026-08-19T14-41-47Z-ee32f1

**PASSED** · 25 passed · 0 failed · 1 skipped · 1m 35s
Started 2026-08-19T14:41:47Z · selection: --surface ui · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| ui      |     25 |      0 |       1 |   5m 39s |

## Skipped

- `ui/errors/uncaught page error fails the test (expected-fail probe; run in isolation, not part of the default suite)` — deliberately-failing probe for Criterion 7 -- run with AMIRO_RUN_EXPECTED_FAIL_SPECS=1 in isolation, see file comment

Artifacts: /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-19T14-41-47Z-ee32f1

real	1m35.533s
```

**This is the fix for Plan Gap 1**: `**PASSED** · 25 passed · 0 failed · 1
skipped` and a populated `| ui | 25 | 0 | 1 | 5m 39s |` row, both read
straight from `results.ndjson` — not `0 passed` while Playwright's own
output shows 25 tests running. The one skip is named, with a real reason
(see Criterion 7).

Wall clock: **1m 35s** (`real 1m35.533s`), against a 5-minute budget.

**Status: PASS**

---

## 2. Every test produces a `trace.zip` openable with `playwright show-trace`; failures also produce a video

**Trace count vs. test count.** From the run above (26 scheduled tests: 25
executed + 1 skipped test whose fixtures still stood up a browser context
before the in-body `test.skip()` took effect):

```text
$ find logs/2026-08-19T14-43-59Z-861d24/ui/test-results -iname trace.zip | wc -l
26
$ find logs/2026-08-19T14-43-59Z-861d24/ui/test-results -mindepth 1 -maxdepth 1 -type d | wc -l
26
```

Every scheduled test produced exactly one trace.

**Openability.** Launched the real trace viewer against a trace from the
run above and confirmed the server answers:
```text
$ xvfb-run -a pnpm exec playwright show-trace ui/specs/dashboard/*/trace.zip --port 9322 &
Listening on http://localhost:9322
$ curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:9322/
HTTP 302
```
(302 is the viewer's own redirect to the loaded-trace URL — the server is
up and serving that trace.) Independently validated the zip structure:
```text
>>> zipfile.ZipFile(trace_path).testzip()
None
>>> 'test.trace' in names
True
```
62 valid entries, no corrupt entries, a `test.trace` stream present — a
real Playwright trace, not an empty file.

**Failures produce a video — this was NOT true before this pass, and
fixing it required a real code change, not just a test.** Forcing a
failure (`ui/specs/errors/page-error-fails.spec.ts` with
`AMIRO_RUN_EXPECTED_FAIL_SPECS=1`, see Criterion 7) initially produced 0
`.webm` files despite `video: "retain-on-failure"` in `playwright.config.ts`.

Root cause: `tests/ui/support/fixtures.ts`'s `context` fixture calls
`browser.newContext({ baseURL: amiro.baseUrl })` directly, because each
test's backend runs on its own dynamically-assigned port and the baseURL
can only be known per test. That bypasses Playwright's default `context`
fixture, which is where `video`/`viewport` from `playwright.config.ts`
normally get wired into `newContext()`. Trace and screenshot survive a
custom context fixture (Playwright hooks those at the browser level);
video does not, because `recordVideo` has to be part of the `newContext()`
call itself. Confirmed by isolating the variable: the same forced failure
through Playwright's *default*, unmodified fixtures produced a `video.webm`
immediately; through the app's custom fixture it did not.

Fix: `context` now explicitly builds `recordVideo` from the same
`run.config.ui.video` the top-level config already resolves, and replicates
Playwright's own retention policy (`off` / `on` / `retain-on-failure` /
`on-first-retry`) by hand, using the documented pattern of grabbing the
`Video` handle before `context.close()` and reading its path after.
Re-running the same forced failure after the fix:
```text
$ AMIRO_RUN_EXPECTED_FAIL_SPECS=1 pnpm exec playwright test ui/specs/errors/page-error-fails.spec.ts --retries=0
  ✘  1 … uncaught page error fails the test … (2.3s)
    attachment #1: video (video/webm) ──────────────────────────
    logs/2026-08-19T14-30-10Z-4b7ace/ui/test-results/.../page@bc56d52c....webm
    attachment #2: screenshot (image/png) ──────────────────────
    attachment #4: trace (application/zip) ──────────────────────
  1 failed
```
And confirmed the policy holds in both directions: a passing test in the
same run retains **no** video —
```text
$ find logs/2026-08-19T14-30-23Z-62ad65/ui/test-results -type f
.../trace.zip     # only the trace; no video, no screenshot -- the test passed
```
— and the failing test's line in `results.ndjson` lists the video as an
artifact:
```json
"artifacts":["ui/test-results/.../page@bc56d52c....webm","ui/test-results/.../test-failed-1.png","ui/test-results/.../trace.zip"]
```

**Status: PASS** (fixed during this pass; see
[`fixtures.ts`](../../../tests/ui/support/fixtures.ts) and Divergence 2 in
`phase-05-ui-playwright.md`).

---

## 3. `events.ndjson` interleaves browser actions with backend requests on one clock for a chosen failing test

Chosen failing test: `ui/errors/uncaught page error fails the test
(expected-fail probe...)`, forced via `AMIRO_RUN_EXPECTED_FAIL_SPECS=1`
(run `2026-08-19T14-30-10Z-4b7ace`). Every event in the test's real time
window, one file, one clock:

```text
2026-08-19T14:30:12.215Z | ui | test    | started
2026-08-19T14:30:12.258Z | ui | action  | Launch browser
2026-08-19T14:30:12.632Z | ui | process | spawn            (backend, test's own instance)
2026-08-19T14:30:12.704Z | ui | process | ready
2026-08-19T14:30:12.783Z | ui | process | backend ready
2026-08-19T14:30:12.784Z | ui | http    | GET /api/auth/status
2026-08-19T14:30:12.852Z | ui | http    | POST /api/auth/register
2026-08-19T14:30:12.921Z | ui | http    | POST /api/auth/register
2026-08-19T14:30:12.989Z | ui | http    | POST /api/auth/register
2026-08-19T14:30:12.996Z | ui | action  | Create context
2026-08-19T14:30:13.012Z | ui | action  | Create page
2026-08-19T14:30:13.073Z | ui | action  | Emulate media
2026-08-19T14:30:13.081Z | ui | action  | Navigate to "/sign-in"
2026-08-19T14:30:13.409Z | ui | action  | Evaluate
2026-08-19T14:30:13.515Z | ui | error   | step failed: Fixture "page"
2026-08-19T14:30:13.952Z | ui | action  | Close context
2026-08-19T14:30:14.623Z | ui | error   | step failed: After Hooks
2026-08-19T14:30:14.716Z | ui | test    | failed
```

The backend's own process lifecycle and HTTP requests
(`process`/`http` kind, written by the Go harness) and the browser's
actions and the eventual failure (`action`/`error`/`test` kind, written by
`timeline-reporter.ts`) land in the same `events.ndjson`, in real
chronological order, for this one failing test.

**Two honest limitations, both real, neither fixed by this pass:**

1. **`events.ndjson` carries the harness's own API calls, not the
   browser's.** The `POST /api/auth/register` lines above are the test
   fixture seeding the account *before* the browser launches — visible in
   the excerpt as three register calls landing before "Create context".
   The browser's own network traffic (what the signed-in page itself
   fetches) is not in this file; it is in `network.har`, written
   separately by the Playwright HAR recorder.
2. **The Go and Playwright sides use different test identifiers**, so
   events can only be joined by timestamp today, not by test address. This
   run's Go-side events are addressed
   `ui/backend/ui-errors_page-error-fails_sp...` (the harness's own
   `testId` scheme); Playwright's own events are addressed
   `ui/errors/uncaught page error fails the test...` (feature/title). No
   single field lets a reader filter this file to "everything for this one
   test" — the excerpt above was built by filtering on a time window
   around the test, not on an identifier.

**Status: PASS**, with the two limitations above documented rather than
silently absent, as the original log left them.

---

## 4. `amirotest run --surface ui --feature chat` runs only chat specs, in under 60 seconds

Command:
```bash
cd tests && go run ./cmd/amirotest run --surface ui --feature chat
```

Output:
```text
run 2026-08-19T14-38-54Z-a1bee9
  providers: replay · parallel: 4

── ui ──

Running 3 tests using 3 workers

  ✓  2 [chromium] › ui/specs/chat/store.spec.ts:5:7 › store › client application store initializes and opens model selection (14.3s)
  ✓  1 [chromium] › ui/specs/chat/streaming.spec.ts:5:7 › chat › send message streams tokens into bubble and completes (18.8s)
  ✓  3 [chromium] › ui/specs/chat/threads.spec.ts:5:7 › threads › create new chat thread and switch between threads (20.8s)

  3 passed (22.4s)

**PASSED** · 3 passed · 0 failed · 0 skipped · 24.3s
Started 2026-08-19T14:38:54Z · selection: --surface ui --feature chat · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| ui      |      3 |      0 |       0 |    53.8s |

real	0m24.435s
```

Only the 3 specs under `ui/specs/chat/` ran. Wall clock: **24.4s**, against
a 60-second budget.

**Status: PASS**

---

## 5. `pnpm playwright test ui/specs/chat/streaming.spec.ts --headed` works standalone with no orchestrator, and still writes into a run directory

Command, with `AMIRO_TEST_RUN_DIR`/`AMIRO_TEST_RUN_ID` explicitly unset
first (there is no `amirotest run` orchestrator process anywhere in this
shell):
```bash
unset AMIRO_TEST_RUN_DIR AMIRO_TEST_RUN_ID
xvfb-run -a pnpm exec playwright test ui/specs/chat/streaming.spec.ts --headed
```

Output:
```text
Running 1 test using 1 worker

  ✓  1 [chromium] › ui/specs/chat/streaming.spec.ts:5:7 › chat › send message streams tokens into bubble and completes (6.1s)

  1 passed (9.0s)
```

The minted run directory (`resolveRun()` shelled out to `amirotest env
--surface ui --json` since no run was joined):
```text
$ ls -dt logs/*/ | head -1
logs/2026-08-19T14-25-42Z-f97865/
$ find logs/2026-08-19T14-25-42Z-f97865/ -maxdepth 2
logs/2026-08-19T14-25-42Z-f97865/backend/
logs/2026-08-19T14-25-42Z-f97865/backend/ui-chat_streaming_spec_ts-chat-send_message-mt06p1jq/
logs/2026-08-19T14-25-42Z-f97865/backends.json
logs/2026-08-19T14-25-42Z-f97865/events.ndjson
logs/2026-08-19T14-25-42Z-f97865/results.ndjson
logs/2026-08-19T14-25-42Z-f97865/run.json
logs/2026-08-19T14-25-42Z-f97865/ui/
$ cat logs/2026-08-19T14-25-42Z-f97865/results.ndjson
{"address":"ui/chat/send message streams tokens into bubble and completes",...,"status":"passed","durationMs":6090,"artifacts":["ui/test-results/.../trace.zip"]}
```

A real run directory, with `results.ndjson`, `events.ndjson`, `run.json`
and per-test backend logs, minted by a bare `pnpm exec playwright test`
invocation with no orchestrator.

**Status: PASS**

---

## 6. Deep links load on hard refresh — the Phase 0 SPA-fallback contract, verified from a browser

Command:
```bash
cd tests && pnpm exec playwright test ui/specs/dashboard/fallback.spec.ts
```

Output:
```text
Running 1 test using 1 worker

  ✓  1 [chromium] › ui/specs/dashboard/fallback.spec.ts:4:7 › dashboard › deep links load on hard refresh verifying SPA fallback (6.0s)

  1 passed (6.9s)
```

The spec navigates directly to `/agents` and `/mcp` (not via in-app
navigation), asserts each renders, then does a real `page.reload()` (a hard
refresh — a fresh HTTP request against the Go server's `internal/web`
resolution ladder, not a client-side re-render) and re-asserts on both
routes.

**Status: PASS**

---

## 7. Uncaught page errors fail their test

**This is Plan Gap 2.** The original spec (now
`ui/specs/errors/page-error-allowed.spec.ts`) only exercised the
`allow-page-errors` **escape hatch** — a page error that is deliberately
allowed and merely logged. If the fixture's fail-on-page-error mechanism
were deleted outright, that spec would still pass, so it proved nothing
about the criterion.

The new `ui/specs/errors/page-error-fails.spec.ts` provokes an uncaught
page error with **no** escape-hatch annotation, and is expected to fail.
It is skipped in the default suite (`test.skip(!process.env.
AMIRO_RUN_EXPECTED_FAIL_SPECS, ...)`) — a deliberately-failing test inside
`amirotest run --surface ui` would itself violate Criterion 1 — and is run
directly for this verification:

```bash
cd tests
unset AMIRO_TEST_RUN_DIR AMIRO_TEST_RUN_ID
AMIRO_RUN_EXPECTED_FAIL_SPECS=1 pnpm exec playwright test ui/specs/errors/page-error-fails.spec.ts
echo "exit: $?"
```

Raw output:
```text
Running 1 test using 1 worker

  ✘  1 [chromium] › ui/specs/errors/page-error-fails.spec.ts:23:7 › errors - expected-fail probe › uncaught page error fails the test (expected-fail probe; run in isolation, not part of the default suite) (1.6s)

  1) [chromium] › ui/specs/errors/page-error-fails.spec.ts:23:7 › errors - expected-fail probe › uncaught page error fails the test ...

    Error: Test encountered 1 uncaught page error(s):
    Deliberate unhandled browser runtime error for Criterion 7 verification (expected to fail the test)

       at ../support/fixtures.ts:141

      139 |     const allowed = testInfo.annotations.some((a) => a.type === "allow-page-errors");
      140 |     if (!allowed && uncaughtErrors.length > 0) {
    > 141 |       throw new Error(`Test encountered ${uncaughtErrors.length} uncaught page error(s):\n${uncaughtErrors.join("\n")}`);
          |             ^
      142 |     }

    attachment #3: trace (application/zip) ────────────────────
    ...

  1 failed
    [chromium] › ui/specs/errors/page-error-fails.spec.ts:23:7 ...

exit: 1
```

The failure comes from `fixtures.ts`'s `page` fixture teardown — not from
an assertion written in the test body — which is what proves the *product's
own mechanism* fails the test, not a convention the test author chose to
follow. Exit code is non-zero.

**Status: PASS**

---

## 8. No spec uses a hard-coded wait; enforced by a `suites/meta/` guard

Baseline:
```text
$ go test -v -run TestUISpecs_DoNotUseHardcodedWaits ./suites/meta/...
=== RUN   TestUISpecs_DoNotUseHardcodedWaits
    ui_guard_test.go:93: Verified 19 UI spec files: 0 hardcoded waits found.
--- PASS: TestUISpecs_DoNotUseHardcodedWaits (0.58s)
PASS
```

Planted a violation (`auth.spec.ts`, line 7): `await
page.waitForTimeout(100);` — then re-ran:
```text
$ go test -v -run TestUISpecs_DoNotUseHardcodedWaits ./suites/meta/...
=== RUN   TestUISpecs_DoNotUseHardcodedWaits
    ui_guard_test.go:88: hardcoded waits found in UI specs:
          ui/specs/auth/auth.spec.ts (line 7: await page.waitForTimeout(100);)

        Use locator.waitFor(), expect(...), or data-state predicates instead of fixed timeouts.
--- FAIL: TestUISpecs_DoNotUseHardcodedWaits (0.62s)
FAIL
```

Reverted the plant (`diff` against the pre-plant copy confirmed a clean
revert), and confirmed green again:
```text
$ go test -v -run TestUISpecs_DoNotUseHardcodedWaits ./suites/meta/...
    ui_guard_test.go:93: Verified 19 UI spec files: 0 hardcoded waits found.
--- PASS: TestUISpecs_DoNotUseHardcodedWaits (0.64s)
```

The guard is non-vacuous: it genuinely fails on a real violation, and its
own `TestUISpecs_GuardIsNonVacuous` unit test additionally exercises the
pattern matcher directly.

**Status: PASS**

---

## 9. Every `src/app` route group has at least one spec

`src/app`'s route groups, mapped to the spec that covers each. `src/app/store/`
is a Zustand store, **not** a route — `chat/store.spec.ts` exercises it
directly (client-side state), and it is listed here to be explicit that
nothing is missing on that account, not because it is a tenth route group.

| Route group | Path | Spec(s) |
|---|---|---|
| `(auth)/sign-in` | `src/app/(auth)/sign-in/page.tsx` | `ui/specs/auth/auth.spec.ts` |
| `(auth)/sign-up` | `src/app/(auth)/sign-up/page.tsx` | `ui/specs/auth/sign-up.spec.ts` **— new in this pass, see below** |
| `(chat)` (root) | `src/app/(chat)/page.tsx` | `ui/specs/chat/streaming.spec.ts`, `ui/specs/chat/threads.spec.ts`, `ui/specs/chat/store.spec.ts` |
| `(chat)/agent` | `src/app/(chat)/agent/page.tsx` | `ui/specs/agents/agent-detail.spec.ts` |
| `(chat)/agents` | `src/app/(chat)/agents/page.tsx` | `ui/specs/agents/agents.spec.ts` |
| `(chat)/archive` | `src/app/(chat)/archive/page.tsx` | `ui/specs/archive/archive.spec.ts` |
| `(chat)/mcp` | `src/app/(chat)/mcp/page.tsx` | `ui/specs/mcp/mcp.spec.ts` |
| `(chat)/workflow` | `src/app/(chat)/workflow/page.tsx` | `ui/specs/workflow/workflow.spec.ts` |
| `(chat)/(admin)` | `src/app/(chat)/(admin)/admin/**` | `ui/specs/admin/admin.spec.ts` |
| `(public)/export` | `src/app/(public)/export/page.tsx` | `ui/specs/export/export.spec.ts` |
| `onboarding` | `src/app/onboarding/page.tsx` | `ui/specs/onboarding/onboarding.spec.ts` |
| *(not a route)* `src/app/store/` | Zustand store | `ui/specs/chat/store.spec.ts` |

Cross-cutting specs not tied to one route group: `ui/specs/dashboard/fallback.spec.ts`
(Criterion 6, spans `(chat)/agents` + `(chat)/mcp`), `ui/specs/a11y/a11y.spec.ts`,
`ui/specs/responsive/viewports.spec.ts`, `ui/specs/visual/components.spec.ts`,
`ui/specs/settings/settings.spec.ts` (a modal on `(chat)`, not its own route),
`ui/specs/errors/*.spec.ts`.

**`(auth)/sign-up` had zero coverage before this pass** —
`auth.spec.ts` only ever exercises `/sign-in`, and nothing in the suite
navigated to `/sign-up`. This is exactly the gap Criterion 9 exists to
catch, and it was found by building this table rather than assumed from
the file list. Added `ui/specs/auth/sign-up.spec.ts`, which completes the
three-step sign-up wizard (`SignUpPage.signUp()`, already present in
`ui/pages/index.ts` but never called by a spec) and asserts the app leaves
`/sign-up`:
```text
$ pnpm exec playwright test ui/specs/auth/sign-up.spec.ts
  ✓  1 [chromium] › ui/specs/auth/sign-up.spec.ts:9:7 › auth - sign-up › sign up with a new account completes registration and leaves /sign-up (3.2s)
  1 passed (4.3s)
```

**Status: PASS** (after adding the missing spec; **NOT MET** before this
pass — see Divergence 4 in `phase-05-ui-playwright.md`).

---

## Required, not among the nine criteria

### `go test -v -run TestBuild_EmbedUI ./harness/backend`
```text
=== RUN   TestBuild_EmbedUI_InvalidatesCacheWhenWebDistChanges
--- PASS: TestBuild_EmbedUI_InvalidatesCacheWhenWebDistChanges (0.29s)
PASS
ok  	amiro/tests/harness/backend	0.292s
```

### `go test ./suites/meta/...`
```text
$ go test -v ./suites/meta/...
--- PASS: TestNoTestImportsTheApplicationModule (0.60s)
--- PASS: TestSuitesDoNotImportEachOther (0.01s)
--- PASS: TestSuitesDoNotSleep (0.03s)
    boundary_test.go:165: 196 unique addresses across 45 features
--- PASS: TestEveryTestAddressIsUnique (0.01s)
--- PASS: TestConfigExample_MatchesTheDefaults (0.00s)
--- PASS: TestConfigExample_ParsesBackToExactlyTheDefaults (0.00s)
--- PASS: TestConfig_MissingFileIsAValidConfiguration (0.00s)
--- PASS: TestTeardown_LeavesNoProcessAndNoBoundPort (0.10s)
--- PASS: TestBackends_StartedConcurrentlyDoNotCollide (0.00s)
    route_coverage_test.go:279: Route coverage: 101 total routes in router.go (101 covered, 0 waived, 0 uncovered)
--- PASS: TestRouteCoverageGuard (0.02s)
--- PASS: TestLogs_ContainNoConfiguredSecretInTheClear (0.00s)
--- PASS: TestRedactor_ReplacesAPasswordSentThroughTheRealAPI (0.32s)
    ui_guard_test.go:93: Verified 19 UI spec files: 0 hardcoded waits found.
--- PASS: TestUISpecs_DoNotUseHardcodedWaits (0.00s)
--- PASS: TestUISpecs_GuardIsNonVacuous (0.00s)
PASS
ok  	amiro/tests/suites/meta	1.184s
```

This run is *after* adding `ui/specs/auth/sign-up.spec.ts` (20 spec files,
196 addresses). Adding `page-error-fails.spec.ts` earlier in this pass
briefly broke `TestEveryTestAddressIsUnique` — see Divergence 3 in
`phase-05-ui-playwright.md`.

### `--repeat-each=3` stability run
```bash
unset AMIRO_TEST_RUN_DIR AMIRO_TEST_RUN_ID
pnpm exec playwright test ui/specs/chat --repeat-each=3
```
```text
Running 9 tests using 4 workers

  ✓  4 … store … (21.9s)
  ✓  3 … store … (23.1s)
  ✓  2 … streaming … (26.5s)
  ✓  1 … threads … (27.9s)
  ✓  7 … store … (22.1s)
  ✓  6 … streaming … (26.0s)
  ✓  5 … threads … (27.5s)
  ✓  8 … streaming … (24.0s)
  ✓  9 … threads … (12.3s)

  9 passed (1.1m)
```
9/9 across three repeats of each of the three chat specs, no flake
observed.

### `backend-go/tests/e2e/serve_test.go` still green
```bash
cd backend-go
go build -o /tmp/server-noembed ./cmd/server && echo "BUILD OK (no tag)"
go build -tags embedui -o /tmp/server-embed ./cmd/server && echo "BUILD OK (embedui tag)"
go test -v ./tests/e2e/...
```
```text
BUILD OK (no tag)
BUILD OK (embedui tag)
=== RUN   TestServe_ServesTheDashboardAndTheAPIOffOneListener
--- PASS: TestServe_ServesTheDashboardAndTheAPIOffOneListener (2.80s)
=== RUN   TestServe_DeepLinksSurviveAHardRefresh
--- PASS: TestServe_DeepLinksSurviveAHardRefresh (2.78s)
=== RUN   TestServe_InjectsTheSameOriginMarker
--- PASS: TestServe_InjectsTheSameOriginMarker (2.78s)
=== RUN   TestServe_UnknownRoutesAnswerCorrectlyForTheirKind
--- PASS: TestServe_UnknownRoutesAnswerCorrectlyForTheirKind (2.81s)
=== RUN   TestServe_RefusesCrossSiteRequests
--- PASS: TestServe_RefusesCrossSiteRequests (2.84s)
=== RUN   TestServe_WarnsLoudlyWhenBoundBeyondLoopback
--- PASS: TestServe_WarnsLoudlyWhenBoundBeyondLoopback (2.83s)
=== RUN   TestServe_NoUIServesTheAPIAloneBehindTheSharedSecret
--- PASS: TestServe_NoUIServesTheAPIAloneBehindTheSharedSecret (2.76s)
=== RUN   TestServe_ShutsDownGracefullyOnSIGTERM
--- PASS: TestServe_ShutsDownGracefullyOnSIGTERM (2.77s)
=== RUN   TestServe_RefusesToStartASecondBackendOnTheSameDatabase
--- PASS: TestServe_RefusesToStartASecondBackendOnTheSameDatabase (2.97s)
=== RUN   TestVersion_ReportsWhetherADashboardIsEmbedded
--- PASS: TestVersion_ReportsWhetherADashboardIsEmbedded (2.70s)
=== RUN   TestSidecar_PrintsPortAndBindsLoopbackOnly
--- PASS: TestSidecar_PrintsPortAndBindsLoopbackOnly (2.64s)
=== RUN   TestSidecar_HealthRejectsRequestWithoutToken
--- PASS: TestSidecar_HealthRejectsRequestWithoutToken (2.68s)
=== RUN   TestSidecar_HealthReturnsOkWithValidToken
--- PASS: TestSidecar_HealthReturnsOkWithValidToken (2.65s)
=== RUN   TestSidecar_ShutsDownGracefullyOnSIGTERM
--- PASS: TestSidecar_ShutsDownGracefullyOnSIGTERM (2.63s)
PASS
ok  	amiro/backend/tests/e2e	38.633s
```
`web.New()` in `cmd/server/main.go` (line ~102) compiles and runs
identically with and without `-tags embedui`; the sidecar tests
(`TestSidecar_*`, which spawn `cmd/server` directly) confirm nothing in
that binary's own behavior changed. See Divergence 1 in
`phase-05-ui-playwright.md` for why that line exists at all.

---

## Full default run, all built surfaces (context, not a criterion)

```bash
cd tests && go run ./cmd/amirotest run
```
```text
**PASSED** · 173 passed · 0 failed · 2 skipped · 3m 14s
Started 2026-08-19T14:43:59Z · selection: --surface meta,backend,tui,ui,desktop · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    103 |      0 |       1 |   1m 52s |
| meta    |     14 |      0 |       0 |    772ms |
| tui     |     31 |      0 |       0 |    46.5s |
| ui      |     25 |      0 |       1 |   5m 34s |

- **desktop** did not run: no suite exists yet under suites/desktop/

## Skipped

- `backend/migration/TestMigration_PostgresSchemaHandlingAndSkip` — tagged "live", which run.tags.exclude excludes
- `ui/errors/uncaught page error fails the test (expected-fail probe...)` — deliberately-failing probe for Criterion 7 -- run with AMIRO_RUN_EXPECTED_FAIL_SPECS=1 in isolation, see file comment

real	3m14.579s
```
