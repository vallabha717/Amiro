# Phase 5: UI Suite (Playwright) Progress Report

## 1. What shipped

Phase 5 delivers a hermetic Playwright browser-test suite for Amiro's web
surface, running against the real Go backend serving the real static
export bundle (`-tags embedui`), plus this revision pass, which made its
reported results trustworthy, proved (rather than assumed) the phase
doc's nine exit criteria, and fixed what that verification found broken.

**Files (this revision pass; the underlying suite from the first pass is
unchanged except where noted):**

| File | LOC | What changed |
|---|---|---|
| `tests/ui/support/timeline-reporter.ts` | 218 | Now also writes `results.ndjson` per test (Divergence 1 below) |
| `tests/ui/support/fixtures.ts` | 199 | `context` fixture now wires `recordVideo` and replicates Playwright's retention policy by hand |
| `tests/ui/specs/errors/page-error-fails.spec.ts` | 41 | New — the actual failing-test proof for Criterion 7 |
| `tests/ui/specs/errors/page-error-allowed.spec.ts` | 32 | Renamed from `page-error.spec.ts`; retitled to say it tests the escape hatch |
| `tests/ui/specs/auth/sign-up.spec.ts` | 20 | New — closes the `(auth)/sign-up` gap found while building Criterion 9's table |
| `tests/ui/specs/chat/store.spec.ts` | 15 | Assertion made unconditional (was silently passing on an invisible element) |
| `docs/testing/progress/verification-log-phase-05.md` | — | Full rewrite against the phase doc's real 9 criteria |
| `docs/testing/progress/phase-05-ui-playwright.md` | — | This file |

**Isolation model: per-test, not per-worker.** The first pass's progress
report called this "Per-Worker / Per-Test Backend Isolation," which
conflates two different guarantees. What is actually built:
`fixtures.ts`'s `amiro` fixture is a plain (test-scoped) fixture, not one
declared `{ scope: "worker" }`, so it runs — and starts a fresh backend,
database, workspace and port via `amirotest backend start` — once per
**test**, not once per worker process. A worker running four tests in
sequence gets four independent backends, never a shared one. That is the
same isolation guarantee every Go suite gets from `harness.New(t, ...)`;
the only difference is which process boundary it rides on.

**Deliverables & test count (whole `tests/ui/` tree, first pass + this
one):** 20 spec files across 15 directories, 342 LOC of page objects
(`ui/pages/index.ts`), 576 LOC of support code (fixtures + reporter +
run-resolution), 435 LOC of specs, 39-line `playwright.config.ts`, 116-line
meta guard (`suites/meta/ui_guard_test.go`). 26 tests total: 25 run in the
default suite, 1 (`page-error-fails.spec.ts`) is a deliberately-failing
probe gated behind `AMIRO_RUN_EXPECTED_FAIL_SPECS=1` so it never breaks a
normal run.

## 2. What diverged from the plan, and why

The implementation plan for this pass was itself a revision of the first
pass, written after that pass shipped and was reviewed. It called out four
specific gaps and asked for a set of corrections; this section records
what each turned out to be once actually touched, including two things
the plan did not anticipate.

**Divergence 1 — Plan Gap 1 (the UI surface never reported results) needed
zero Go changes.** The plan's evidence was real: `amirotest run --surface
ui` printed `**PASSED** · 0 passed · 0 failed · 0 skipped` while
Playwright's own output showed 24 tests running. The instinct might be to
patch the orchestrator (`tests/cmd/amirotest/run.go`) to parse Playwright's
JSON reporter output. That is unnecessary: `Run.Summarise()`
(`tests/harness/run/summary.go:169`) already re-reads `results.ndjson` from
disk at the end of every run, specifically so that multiple processes
(`go test` shards, and now Playwright) can each append independently
without any of them needing to call back into the orchestrator's in-memory
state. The entire fix is `timeline-reporter.ts` appending one line per test
in the same JSON shape `TestResult` decodes — no Go code touched. Verified
in `verification-log-phase-05.md` §1: `25 passed · 0 failed · 1 skipped`
with a populated per-surface row, sourced from `results.ndjson`.

**Divergence 2 — forcing a failure for Criterion 2 surfaced a real,
previously-invisible bug: videos were never produced, ever, even for
failing tests.** The plan asked to "force a failure; show ... the video
file that failure produced," on the assumption forcing a failure would
produce one. It did not. `fixtures.ts`'s `context` fixture builds its own
`browser.newContext({ baseURL: amiro.baseUrl })` because each test's
backend binds a fresh port and `baseURL` can only be known per test — but
that bypasses the mechanism Playwright's *default* context fixture uses to
turn `video: "retain-on-failure"` in `playwright.config.ts` into an actual
`recordVideo` option. Trace and screenshot happen to survive a custom
context fixture (Playwright hooks those elsewhere); video does not, because
`recordVideo` has to be passed at `newContext()` time. This was invisible
in the first pass because nothing had ever failed, so "0 videos" read as
"nothing to show" rather than "the mechanism is broken." Fixed by building
`recordVideo` from the same `run.config.ui.video` the top-level config
already resolves, and replicating the on/off/retain-on-failure/on-first-retry
retention policy by hand (get the `Video` handle before `context.close()`,
read its path after). Verified with a forced failure before and after the
fix — see `verification-log-phase-05.md` §2.

**Divergence 3 — adding the two new error specs collided on test address,
for a reason worth recording.** `tests/harness/selector/discover.go`'s
`playwrightTitles()` scans every `.spec.ts` file in a feature directory and
treats **both** `test(...)` and `test.describe(...)` calls as candidate
test names (`playwrightTitle` regex, `discover.go:51`) — a deliberate
existing design, not something this pass changed. Both new specs under
`ui/specs/errors/` originally kept the existing file's `test.describe("errors", ...)`
title, so the literal string `"errors"` was discovered twice in the same
directory, and `TestEveryTestAddressIsUnique` (`suites/meta/boundary_test.go`)
correctly failed: two specs would have shared one artifact directory.
Fixed by giving each describe block a distinct title
(`"errors - allow-page-errors escape hatch"`, `"errors - expected-fail probe"`);
the `feature` used in `results.ndjson` and artifact paths comes from the
directory name, not the describe title, so this has no effect on selection
or artifact layout, only on the discovery tool's uniqueness check.

**Divergence 4 — Criterion 9's own verification found a real, unrelated
gap: `(auth)/sign-up` had no spec.** Building the route-group → spec
mapping table the plan's remaining-corrections list asked for surfaced
that `auth.spec.ts` only ever exercises `/sign-in`; nothing in the suite
navigated to `/sign-up`, despite `SignUpPage` already existing fully-built
in `ui/pages/index.ts` with a working `signUp()` helper. This was not one
of the plan's four named gaps — it was found by actually building the
evidence the plan asked for, which is the entire argument for building it.
Closed with `ui/specs/auth/sign-up.spec.ts` rather than left as a
documented gap, since the fix was small, mechanical, and used
infrastructure that already existed.

**Divergence 5 — the "cassette" claim was worse than the plan guessed, and
this pass did not fix it.** The plan flagged: "Runs report `providers:
replay`, and Phase 3 recorded only 4 cassettes with chat falling back to
the fake provider. Say fake provider if that is what it is." Tracing the
actual code path (`tests/cmd/amirotest/backend_cmd.go` calls `seed.Apply`
with `seed.Default`, never `seed.ApplyWithProxy`; no `AMIRO_TEST_PROVIDERS_MODE`
or proxy URL is ever passed to the per-test backend the UI fixture starts)
shows it is **not** fake-provider-backed either: **zero AI provider
accounts exist in the database the UI suite's backend runs against.**
`backend-go/internal/ai/bifrost/account.go`'s `GetKeysForProvider` returns
no keys, Bifrost fails fast with `"no keys found for provider: openai"`,
and that error is what actually streams back over SSE — no assistant text
is ever generated. `chat/streaming.spec.ts` passes anyway because its
assertions are weak: `data-testid="message-content"` is set on the user's
own optimistically-rendered bubble (`message-parts.tsx`), not only the
assistant's, so `bubbles.count() >= 1` is satisfied by the user's own
echoed message, and the container's `data-state="ready"` flips regardless
of whether the turn succeeded or errored. **The suite's own name for this
spec — "streaming chat end-to-end token validation" — is not what it
verifies.** This is squarely a Phase 3/UI-harness wiring gap (the UI
fixture never wires `tests/harness/cassette`/`tests/harness/fakeprovider`
the way the Go suites' `harness.Proxy()`/`Fake()` do), not something a
docs correction can paper over, and it is out of scope for this revision
pass to fix — recorded here and under Follow-ups instead of silently
repeated as fact.

## 3. How it was verified

Every claim above and every one of the phase doc's nine criteria has a
command and its real output in
[`verification-log-phase-05.md`](verification-log-phase-05.md), including
two negative-then-positive pairs (video before/after the fix, and the meta
guard failing on a planted violation before passing again on the revert)
rather than single green runs. Also run and green: the full default
`amirotest run` across every built surface (`meta`, `backend`, `tui`,
`ui`) — 173 passed, 0 failed, 2 skipped (both with real reasons), 3m 14s —
which is not one of the nine criteria but is the strongest evidence that
this pass did not regress anything outside Phase 5's own surface; and a
`--repeat-each=3` run of all three `chat` specs (9/9 passed, no flake),
since browser flake appearing only on a later run is this surface's
defining failure mode and the first pass's log did not address it.

`chat/store.spec.ts` also had `if (await chat.modelSelector.isVisible())`
wrapped around its only real assertion — a test that passes whether or not
the element ever renders. Made unconditional; still passes (the element
does render), so this was a latent gap, not a live false-positive, but the
next regression in that area would have gone unnoticed.

## 4. Exit criteria — checked off against the phase doc's own list

| # | Criterion | Status |
|---|---|---|
| 1 | `amirotest run --surface ui` passes against the Phase 0 embedded server in under 5 minutes | ✅ PASS — 25 passed, 1 reasoned skip, 1m 35s |
| 2 | Every test produces a `trace.zip` openable with `playwright show-trace`; failures also produce a video | ✅ PASS — 26/26 traces, verified openable; video required a real fix (Divergence 2) |
| 3 | `events.ndjson` interleaves browser actions with backend requests on one clock for a chosen failing test | ✅ PASS — excerpt in the log; two real limitations documented, not fixed |
| 4 | `amirotest run --surface ui --feature chat` runs only chat specs, in under 60 seconds | ✅ PASS — 3 specs, 24.4s |
| 5 | `pnpm playwright test ui/specs/chat/streaming.spec.ts --headed` works standalone, writes into a run directory | ✅ PASS |
| 6 | Deep links load on hard refresh, verified from a browser | ✅ PASS |
| 7 | Uncaught page errors fail their test | ✅ PASS — proven by a test that actually fails (Divergence in Plan Gap 2), not the escape-hatch test alone |
| 8 | No spec uses a hard-coded wait; enforced by a `suites/meta/` guard | ✅ PASS — guard shown failing on a planted violation, then passing again after revert |
| 9 | Every `src/app` route group has at least one spec | ✅ PASS — after adding `sign-up.spec.ts` (Divergence 4); **was NOT MET** going into this pass |

All nine criteria pass with real evidence. Two (`2`, `9`) required an
actual code/test change during verification, not just a check.

## 5. Follow-ups surfaced

- **The chat/UI surface does not actually exercise streaming with a real
  or fake AI response** (Divergence 5). `chat/streaming.spec.ts`'s
  assertions pass against an error frame. Fixing this properly means
  wiring `tests/harness/cassette`/`tests/harness/fakeprovider` into the
  UI fixture's backend start path (`tests/cmd/amirotest/backend_cmd.go`,
  `tests/ui/support/fixtures.ts`) the way `harness.Proxy()`/`Fake()`
  already does for Go suites, and then tightening the assertion to require
  assistant-authored content specifically (e.g. a `data-testid` scoped to
  the assistant message, not any bubble). This is a real correctness gap
  in the suite's coverage claims, not a cosmetic one.
- **Coverage depth is a smoke slice, not full journeys, for `archive`,
  `workflow` and `export`.** Each has exactly one `expect` today, against
  phase-doc journeys like "build a graph, save, execute, watch node
  results" (`workflow`) and "export a thread, open the public link signed
  out, comment, delete" (`export`). Defensible as an initial scope, but
  Criterion 9's "at least one spec" should not be read as "these journeys
  are covered."
- **`page-error-fails.spec.ts` still spins up a full per-test backend even
  when skipped**, because Playwright resolves fixtures (`amiro`, `context`,
  `page`) before the in-body `test.skip()` call takes effect. Harmless
  (confirmed: the skipped test still produced a trace.zip in §2's count)
  but wasteful; moving the skip condition to `test.skip(condition, reason)`
  at the `test.describe` level, or a `test.beforeEach`, would avoid the
  backend start entirely. Not fixed here since it costs correctness
  nothing.
- **Cross-surface event correlation (Criterion 3's limitation 2)**: unify
  the Go harness's `testId` scheme and Playwright's `feature/title`
  addressing, or add a join key to `events.ndjson`, so `amirotest report
  --timeline --test <address>` (referenced in `summary.go`'s own
  `RenderMarkdown`) can filter by test rather than requiring a human to
  eyeball a timestamp window as this log's §3 did.
- **`network.har`** is written per test but was not inspected in this
  pass; a future pass verifying browser-side network behavior (as opposed
  to the harness's own seeding calls) should read it directly rather than
  relying on `events.ndjson`, per limitation 1 in Criterion 3.
