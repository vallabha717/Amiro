# Progress

What has actually been built, as opposed to what is planned. The
[phases](../phases/README.md) hold the intent; this folder holds the
record — dated, with real numbers, and honest about what diverged.

**Last updated:** 2026-08-19 (Phase 7)

## Status

| Phase | Title | Status | Record |
|---|---|---|---|
| 0 | Serve the dashboard | ✅ **Done** — 2026-08-19 | [phase-00-serve-and-embed.md](phase-00-serve-and-embed.md) · [log](verification-log-phase-00.md) |
| 1 | Harness foundation | ✅ **Done** — 2026-08-19 | [phase-01-harness-foundation.md](phase-01-harness-foundation.md) · [log](verification-log-phase-01.md) |
| 2 | Backend API suite | ✅ **Done** — 2026-08-19 | [phase-02-backend-api.md](phase-02-backend-api.md) · [log](verification-log-phase-02.md) |
| 3 | Providers + agent loop | ✅ **Done** — 2026-08-19 | [phase-03-providers-and-agent.md](phase-03-providers-and-agent.md) · [log](verification-log-phase-03.md) |
| 4 | TUI suite | ✅ **Done** — 2026-08-19 | [phase-04-tui.md](phase-04-tui.md) · [log](verification-log-phase-04.md) |
| 5 | UI (Playwright) | ✅ **Done** — 2026-08-19 | [phase-05-ui-playwright.md](phase-05-ui-playwright.md) · [log](verification-log-phase-05.md) |
| 6 | Desktop (Tauri) | ✅ **Done** — 2026-08-19 (6/7 criteria MET; see record) | [phase-06-desktop.md](phase-06-desktop.md) · [log](verification-log-phase-06.md) |
| 7 | Cross-surface + resilience | ✅ **Done** — 2026-08-19 (6/7 criteria fully MET; see record) | [phase-07-cross-surface.md](phase-07-cross-surface.md) · [log](verification-log-phase-07.md) |
| 8 | CI + guardrails | ⬜ Not started — **unblocked** | — |

Each phase's verification log holds the commands used to check it against a
real running system, with their output, so any claim below can be re-checked
rather than taken on trust.

## What works today

**The test system exists and runs.** From a clean checkout, with no
`config.yaml` and no API keys:

```bash
cd tests
go run ./cmd/amirotest doctor     # what is installed, and what each gap means
go run ./cmd/amirotest run        # 15 tests, green, ~3s
go run ./cmd/amirotest list       # every discovered surface/feature/test address
```

Every run leaves one directory under `tests/logs/` holding `run.json`
(resolved config, redacted), `summary.md`, `summary.json`,
`results.ndjson`, the merged `events.ndjson` timeline, and per-test server
stdio, HTTP exchanges and isolated `appdata/ db/ workspace/ home/`.

The native runner works with no ceremony and produces the same artifacts,
which is what matters for editors and agents:

```bash
go test ./suites/backend/smoke/ -run TestBackend_BuildsStartsAndAnswersHealth -v
```

**`amiro serve`** — the Go binary serves the exported Next.js dashboard and
the API off one listener, from one executable, with no Node runtime.

```bash
pnpm build && ./scripts/build-ui.sh
cd backend-go && go build -tags embedui -o bin/amiro ./cmd/amiro

./bin/amiro serve --host 0.0.0.0 --port 8080    # dashboard on the network
./bin/amiro --serve --port 8080                 # the TUI *and* the dashboard
./bin/amiro version                             # says which UI bundle is inside
```

### By the numbers

| | |
|---|---|
| `tests/` module | 189 Go files (excl. the `fixtures/workspaces/large` fixture) · 13716 non-test LOC · 19487 test LOC |
| Test functions in `tests/` | 280 unique addresses across 68 features, all passing or cleanly, reasonedly skipped |
| UI suite (Playwright) | 20 spec files · 26 tests (25 run by default, 1 a gated expected-fail probe) |
| Desktop suite (Go, `suites/desktop/`) | 8 feature directories · 12 tests (8 real and passing without cargo, 4 cargo-gated skip stubs) |
| Cross-surface suite (Go, `suites/cross/`) | 11 feature directories · 18 tests, all real, all passing |
| Resilience suite (Go, `suites/backend/resilience/`) | 9 fault classes · 31 tests (29 passing, 2 recorded PARTIAL/NOT MET with reasons) |
| Perf suite (Go, `suites/backend/perf/`) | 8 budgets, `slow`-tagged, calibrated and trend-recorded |
| Security suite (Go, `suites/backend/security/`) | 8 checks, 2 through a real dashboard-auth code path |
| Suites that exist | `backend/*` · `meta` · `tui` · `ui` (Playwright) · `desktop` · `cross` |
| Dependencies | `gopkg.in/yaml.v3`, `github.com/jackc/pgx/v5`. No dependency on `amiro/backend` |
| Cross-compiles | `GOOS=windows` and `GOOS=darwin` build clean |
| Full default run | 3m 50s — `meta`, `backend`, `tui`, `ui`, `desktop`, `cross`: 243 passed, 0 failed, 17 skipped, all reasoned |

## What does **not** exist yet

One of eight numbered phases is unwritten (Phase 8). To be explicit,
because a plan folder full of confident prose can read as if it describes
reality:

- **No CI.** No `.github/workflows`, no Makefile. (Phase 8.)
- **Desktop's `ui-parity` criterion needs a machine with the Tauri
  toolchain** — the other 6 of 7 exit criteria already run against the
  real sidecar binary and pass here. See
  [phase-06-desktop.md](phase-06-desktop.md). (Phase 6, mostly done.)
- **Postgres is written but unexercised** — no postgres server exists here,
  so `CREATE SCHEMA` / `DROP SCHEMA` has never actually run. sqlite, the
  default, is fully exercised. See Phase 1's divergence 5. The same gap
  blocks one of resilience's Database-class rows (Phase 7).
- **`run.keepArtifacts` is validated and recorded in `run.json`, but
  nothing enforces it yet** — `run.retries` and `run.costCeilingUsd`,
  its former companions in this exact sentence through Phase 6, are now
  both real (Phase 7): a failed test is actually retried and every
  attempt kept under its own artifact directory, and accumulated spend is
  checked against the ceiling after every surface. `keepArtifacts` was
  not in Phase 7's scope and remains open. (Phase 8, most likely — it is
  the kind of guardrail that phase's own name suggests.)
- **`auth.SessionTTL` has no config hook**, so no test can exercise a
  session actually expiring (only being explicitly revoked, which Phase 7
  does cover). See [phase-07-cross-surface.md](phase-07-cross-surface.md)'s
  Follow-ups.
- **A dashboard-rendered FCP budget and a rendered-staleness check for
  concurrent writes both need a Playwright companion** — Phase 7's
  Go-only suites measure a real, defensible proxy for each (HTML
  time-to-first-byte; API-level convergence) but explicitly cannot reach
  into a rendered browser. See
  [phase-07-cross-surface.md](phase-07-cross-surface.md)'s Follow-ups.
- **Five real application defects were found by Phase 7 and recorded,
  not fixed** (out of the test system's own scope — this module talks to
  Amiro over its public surfaces, it does not patch `backend-go`): no
  auth rate limiter in `cmd/server`; a typed-nil `*web.Handler` panics an
  untagged (non-`embedui`) build on any non-API route — the shipped
  desktop sidecar (`src-tauri/build-sidecar.sh` builds `cmd/server` with
  no `-tags embedui`) is the affected build, and this corrects
  `verification-log-phase-05.md`'s claim that `web.New()` "runs
  identically with and without `-tags embedui`", which only ever
  exercised API/health routes; `/api/ai/providers` leaks a runtime
  provider key, in plaintext, to any authenticated non-admin user — a
  credential leak, flagged for a fix-now decision rather than filed as a
  routine follow-up; a public thread export republishes tool-call raw
  input/output and internal ids verbatim; the TUI's `/export`
  confirmation is never rendered. See
  [phase-07-cross-surface.md](phase-07-cross-surface.md).
- **`harness/pty/buffer.go`'s terminal emulator has a known
  rendering-fidelity gap** (repaints can accumulate instead of replace;
  long rows hard-wrap mid-token) — shared by every TUI, desktop, and
  cross-surface test. Confirmed to flake at least two tests across two
  surfaces (`suites/cross/servetui` and
  `suites/tui/rendering/TestRendering_RawANSIInModelOutputDoesNotBreakFrame`),
  contention-sensitive enough that it undercounts in isolated re-runs.
  **`run.retries: 1`, the shipped default, is currently masking every
  occurrence of it** in an ordinary `amirotest run` — visible only in
  `summary.md`'s `## Retried` section, not the top-line pass count.
  Diagnosed, not fixed, in Phase 7. Phase 8 must set `run.retries: 0` in
  its own CI config explicitly rather than inherit the dev-convenience
  default; see [phase-07-cross-surface.md](phase-07-cross-surface.md)'s
  Follow-ups.

A default `amirotest run` says so itself, for anything a selected surface
genuinely cannot do, rather than reporting green over the gap. With
`desktop.enabled: false` set, for example:

```
- **desktop** did not run: desktop.enabled is false
```

That was a deliberate change during Phase 1. A selected surface that
contributes nothing has to say so; "ui: 0 tests" reading as green when there
is no UI suite at all is the one failure mode a test system must not have.

## Next up — Phase 8

[Phase 8](../phases/phase-08-ci.md) is unblocked — every
prior phase, including Phase 7, is done, and Phase 7 specifically closed
the two harness gaps ("phase 7 will need to actually enforce
`run.retries`/`run.costCeilingUsd`") that stood between "validated in
config" and "real."

Findings from Phase 7 that Phase 8 should carry forward:

> **A data race in shared harness code can sit latent for six phases.**
> `harness/logging/redact.go`'s `Redactor.secrets` was mutated by every
> `backend.Start` and read by every log write with no lock at all, since
> Phase 1. It took `-race` on `suites/meta`'s own concurrency guard,
> during Phase 7's verification, to surface it. Whatever Phase 8's CI
> pipeline runs by default should run `-race`, not treat it as optional —
> this is exactly the class of bug that a non-race CI run would never
> catch, on a guard that has existed since Phase 1.

> **`run.retries`, once real, needs its own artifact convention, not just
> a re-run.** A second attempt reusing the first's `TestID` would
> overwrite exactly the evidence a retry investigation needs. The fix
> (`-attemptN` suffix, a `## Retried` section in `summary.md` that is
> never silent even when the final verdict is a clean pass) is the shape
> Phase 8's own CI reporting should match: a flake that passed on retry
> must never render identically to a test that never failed.

> **A gap found while verifying someone else's suite is still this
> phase's responsibility to fix, not the next phase's to discover.** The
> `Redactor` race and the missing `cross` default-surface entry were both
> found during independent verification of parallel work, not in the
> feature each was nominally scoped to. Phase 8 should expect the same:
> budget time for verification to surface real, unscoped problems, and
> fix what's cheaply fixable rather than only recording it.

> **Five real application defects, and one real harness rendering bug,
> were found and deliberately left unfixed** (out of this module's
> scope — see "What does not exist yet" above and
> [phase-07-cross-surface.md](phase-07-cross-surface.md)'s Follow-ups).
> None of them are CI-blocking today; a CI pipeline that runs security
> and resilience nightly, per Phase 7's own tagging, will keep re-finding
> them until someone with `backend-go` in scope closes them.

## How to update this folder

When a phase ships, add `phase-NN-<slug>.md` and
`verification-log-phase-NN.md` here recording:

1. **What shipped** — files created and modified, with line counts.
2. **What diverged from the plan, and why.** This is the most valuable
   section and the one most likely to be skipped. A plan written before the
   code always gets something wrong; the record of *what* and *why* is what
   stops the next person re-litigating a decision that was already made
   with better information. Phase 1 has seven, one of which was a plan
   instruction that the Go compiler makes impossible.
3. **How it was verified** — commands and their real output, not
   assertions that it works.
4. **Exit criteria**, checked off against the phase doc's own list.
5. **Follow-ups surfaced** — things found along the way that belong to a
   later phase.

Then update the status table above, and mark the phase doc itself.
