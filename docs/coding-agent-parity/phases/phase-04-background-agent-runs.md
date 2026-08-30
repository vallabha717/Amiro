# Phase 04 — Background agent runs

**Status:** ⚠️ shipped 2026-08-29, 5/7 criteria MET literally (1 more MET
conditionally via the same environment-honest pattern Phase 2 established;
1 NOT MET for lack of a Tauri runtime in this sandbox) — see
[progress/phase-04-background-agent-runs.md](../progress/phase-04-background-agent-runs.md)

**Depends on:** 0, 2, 3 · **Blocks:** — · **Size:** L

**Surfaces touched:** backend · desktop · web · terminal

This phase makes it true that starting an agent run does not require
staying in the thread, or even keeping the client open, until it finishes
— and that a run which finishes cleanly can open a pull request on its
own. This is the single biggest product-shape gap named in
`docs/future-implementation/amiro-vs-coding-agents-comparison.md`.

## What already exists

- `internal/appwiring.App` owns the object graph every entrypoint shares,
  including graceful shutdown (closing the MCP manager, releasing the
  single-instance lockfile) — this phase's background-job worker is a
  goroutine `App` owns directly, using the same shutdown hook, not a
  second process or a new supervision mechanism.
- `task` subagents (`internal/api/chat/subagent.go`) run synchronously
  inside one parent request, read-only, structurally unable to recurse —
  this phase does not modify `task`; a background run is a peer concept
  (unattended, potentially writing), built alongside it.
- `amiro run` (`cmd/amiro/run.go`) already proves the "one complete turn,
  no HTTP client attached to it" shape works — a background job's
  execution is `chat.RunTurn` called the same way, wrapped in job
  bookkeeping that outlives the call.
- The approval-suspend rail (`data-tool-approval`, resolved via
  `resolveApprovals`) already exists for interactive turns — this phase
  attaches the identical suspended-call shape to a job instead of a live
  request, rather than inventing a second suspend/resume mechanism.
- **This phase is the reason Phases 0, 2 and 3 exist as prerequisites**,
  not merely as nice-to-haves: see the suspension-cause table in
  [05-background-agent-runs.md](../05-background-agent-runs.md) for exactly
  what each dependency prevents an unattended job from doing.

## Deliverables

### 1. Durable job model

- `internal/db/models/background_job.go` — `(id, thread_id, user_id,
  workspace_root, prompt, mode, status, started_at, finished_at,
  auto_pr bool)`. Migration, both dialects. `status` ∈
  `{running, suspended, done, failed, interrupted}`.
- `internal/db/repository/backgroundjob/`.

### 2. Worker

- `internal/agent/background/worker.go` — owned by `appwiring.App`,
  started on job creation, tracked in an in-memory registry backed by the
  durable row (registry is a liveness cache, not the source of truth).
- On graceful shutdown, running jobs are marked `interrupted` (not
  `failed`) and their context is canceled. On next launch, `interrupted`
  jobs whose trust grant (Phase 0) is still valid resume; others are left
  `interrupted` for the user to see and restart explicitly.
- Enforces the suspension-cause table from the design doc: `RiskExternal`
  `AlwaysAsk` calls (Phase 3's push/PR) move the job to `suspended` rather
  than abandoning it; an unsandboxed shell call (no backend available,
  Phase 2) is refused outright, never silently run unsandboxed; job
  creation itself is refused against an untrusted root (Phase 0).

### 3. Completion action — auto-PR

- On a clean finish with `auto_pr: true`: run `walkthrough`, create branch
  `agent/<job-id>-<slug>` (never the branch checked out when the job
  started), `git push` (Phase 3) that branch, `create_pr` (Phase 3) titled
  and described from the walkthrough output. Each step still goes through
  its own `AlwaysAsk` gate — a background job suspends and waits in the
  panel at exactly the same point an interactive push/PR would ask,
  it does not get a bypass.

### 4. Concurrency cap

- A constant (2) enforced at job-creation time; a creation request beyond
  the cap is refused with a message naming the running jobs, not queued
  silently.

### 5. Web — "Agent runs" panel

- List of jobs (own + visible-to-role), status, a resume action for
  `suspended`/`interrupted` jobs, reusing the existing thread-list visual
  patterns.

### 6. Terminal — `amiro run --background` and `/runs`

- `--background` flag on `amiro run`: creates a job and returns
  immediately with the job id (distinct from the existing synchronous
  `amiro run`, which is unaffected).
- `/runs` picker in the TUI, mirroring `/threads`' list/filter/select shape.

### 7. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/backgroundjob/` | A job continues after the originating client disconnects, proven with a real dropped connection (not a mock — the `test` skill's own harness pattern for this kind of lifecycle claim); a job against an untrusted root is refused at creation; a job hitting an unsandboxed shell call is refused, not silently run; a suspended job resumes correctly on approval; graceful shutdown marks running jobs `interrupted`, and a restart resumes only those with a still-valid trust grant; the concurrency cap refuses a third job with the running jobs named |
| desktop | `tests/suites/desktop/backgroundjob/` | The sidecar's shutdown path actually marks jobs `interrupted`, exercised against the real Tauri lifecycle |
| cross | `tests/suites/cross/backgroundjob/` | A job started from the TUI (`--background`) is visible and resumable from the web panel, and vice versa |
| web | `tests/ui/specs/backgroundjob/` | Panel list/status/resume, `data-testid`s added |
| terminal | `tests/suites/tui/backgroundjob/` | `--background` returns immediately with a job id; `/runs` list/filter/select/resume under a real PTY |
| meta | `tests/suites/meta/` | A guard asserting a background job's mode is always `Edit` or `Auto` at creation — never `Plan`/`Interactive` — and that job creation always checks the Phase 0 trust grant before starting the worker goroutine |

**Deliberately not covered:** raising the concurrency cap past 2 (named as
a follow-up in the design doc, once this phase has run in production);
scheduled/cron-triggered background jobs (`00-overview.md`'s non-goals — a
job is always started by an explicit user action).

### 8. Docs updated

- `docs/future-implementation/amiro-vs-coding-agents-comparison.md`'s Tier
  1/Tier 2 rows for workspace trust, sandboxing, checkpoints, git push/PR
  and background agents all flip from ❌/⚠️ once the corresponding phase
  ships — this phase, landing last, is the trigger to do the full pass
  across all five rows rather than leaving the comparison doc to drift.

## Exit criteria

1. `amirotest run --surface backend --feature backgroundjob` passes.
2. `TestBackgroundJob_ContinuesAfterClientDisconnects` passes against a
   real dropped connection.
3. `TestBackgroundJob_RefusesAgainstUntrustedRoot` and
   `TestBackgroundJob_RefusesUnsandboxedShellRatherThanFallingBack` both
   pass — the two exit criteria that directly prove Phases 0 and 2 are
   load-bearing here, not just referenced.
4. `TestBackgroundJob_GracefulShutdownInterruptsAndCleanlyResumes` passes,
   including the trust-grant-still-valid check on resume.
5. `amirotest run --surface cross --feature backgroundjob` passes, proving
   a job started from one surface is visible and resumable from the other.
6. `amirotest run --surface desktop --feature backgroundjob` passes against
   the real Tauri lifecycle.
7. `amirotest run` is green overall, `suites/meta` included, with every
   skip reasoned.

## Risks

- **This is the largest architectural addition in the whole plan**: a
  goroutine that outlives a request is new to this single-binary tree.
  Mitigated by the low, explicit concurrency cap (deliverable 4) and by
  reusing every existing safety primitive (trust grant, sandbox flag,
  always-ask gate, event log, approval-suspend rail) rather than building
  parallel versions of any of them — the design doc's principle 1
  ("compose existing primitives") is under the most pressure in this phase
  and is exactly where it matters most.
- **A job surviving a restart is a new kind of state to reason about
  correctly** — an `interrupted` job whose workspace root was deleted, or
  whose trust grant was revoked, while the process was down. Mitigated by
  re-checking both at resume time, not just at original creation time
  (exit criterion 4).
- **Auto-PR creating branch/PR noise on a repo the user didn't expect
  it on.** Mitigated by `auto_pr` being opt-in per job (never a default)
  and by the branch naming convention (`agent/<job-id>-<slug>`) making an
  agent-created branch unambiguous at a glance.

## Open questions

- ~~Should a `suspended` job's pending approval be resolvable from **any**
  surface...~~ **Resolved: any surface**, confirmed before implementation.
  In practice this needed no dedicated mechanism at all: a suspended job's
  pending approval is an ordinary `data-tool-approval` part on its thread,
  resolved by the exact same `POST /api/chat` resubmission any interactive
  approval already uses — see
  [progress/phase-04-background-agent-runs.md](../progress/phase-04-background-agent-runs.md)'s
  divergence 1.
