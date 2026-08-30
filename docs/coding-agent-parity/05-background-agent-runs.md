# 05 — Background agent runs

Settles Phase 4: what a background run is, how it outlives the request that
started it inside a single-binary architecture that has never needed that
before, what it's allowed to do unattended, and what happens when it
finishes.

## What's genuinely new here

Nothing in `internal/appwiring` today owns work whose lifetime exceeds one
HTTP request (or one PTY session, for the TUI). `task` subagents
(`internal/api/chat/subagent.go`) run a whole loop, but synchronously,
inside the parent turn's own request — when the request ends, so does the
subagent, by construction. `amiro run` is a complete headless turn, start
to finish, in one process invocation. A background run needs to survive
the client that started it disconnecting, closing its thread, or (for the
TUI) exiting entirely — which none of the above do, and which is the
reason this is sized **L** and blocks on three other phases rather than
standing alone.

## Ownership: a worker inside `appwiring`, not a second process

`internal/appwiring.App` already owns the object graph every entrypoint
shares. A background run is a goroutine that `App` owns directly — started
by an API call, tracked in a small in-memory registry keyed by job id,
*backed by* a durable row (survives a restart; the in-memory registry is a
liveness cache, not the source of truth). On process shutdown, `appwiring`'s
existing graceful-shutdown path (already responsible for closing the MCP
manager and releasing the lockfile) also cancels any running background
job's context and marks it `interrupted` — not `failed`, since a shutdown
is not the job's own error, and not silently `done`, since it didn't
finish. A background job resumes on next launch if it was `interrupted` and
its trust grant is still valid; it does not resume if the workspace root or
grant is gone.

## What a background run is allowed to do

A durable job row: `(id, thread_id, user_id, workspace_root, prompt, mode,
status, started_at, finished_at)`. `mode` is restricted to `Edit` or `Auto`
at creation time — `Plan` produces nothing to run unattended, and
`Interactive` would suspend on the first write with no one watching, which
is simply a hung job with extra steps.

**Execution reuses `chat.RunTurn` exactly as `amiro run` already does** —
Phase 4 adds no second agent loop. What changes is what happens when a call
suspends:

| Suspension cause | Interactive behavior today | Background run behavior |
|---|---|---|
| A gated write/exec in Interactive mode | Approval card, waits for a human | N/A — background jobs never run in Interactive mode |
| `RiskExternal` always-ask (Phase 3's push/PR gate) | Approval card | **Job status becomes `suspended`**, not abandoned — the pending approval is the same `data-tool-approval` shape the approval rail already produces, just attached to a job instead of a live request |
| A shell command with no sandbox available (Phase 2) | Runs anyway (host-level) | **Refused outright** — an unattended job never falls back to unsandboxed execution; this is the concrete reason Phase 4 depends on Phase 2 rather than merely benefiting from it |
| Workspace not trusted (Phase 0) | Every write/exec refused | **Job creation itself is refused** — there is no such thing as starting a background run against an ungranted root |

A `suspended` job is not lost: it appears in the "Agent runs" panel (web)
and `/runs` (TUI) as needing attention, and resolving the pending approval
resumes it exactly the way resolving one resumes an interactive turn today
— reusing `resolveApprovals`, not a parallel resolution path.

## Completion action — composition, not new machinery

On a clean finish (`status: done`, no pending suspension), the job
optionally runs, in order:

1. `walkthrough` (already built) — summarizes what changed.
2. `git push` (Phase 3) on a branch the job itself creates
   (`agent/<job-id>-<slug>`, never the branch the user was on when the job
   started — a background job must never push to whatever branch happened
   to be checked out).
3. `create_pr` (Phase 3), titled and described from the walkthrough output.

This is opt-in per job (a checkbox at creation time), and each of the three
steps is itself still gated the way Phase 3 defines — a background job does
not get to skip the always-ask rule on `push`/`create_pr` just because
nothing else about it asks. **The always-ask gate for a background job
means "suspend and wait in the panel," not "block forever" or "silently
skip."**

## Concurrency

Capped at 2 concurrent background runs per instance for this phase (a
constant, not yet configurable) — deliberately conservative next to
Cursor's 8 and Antigravity's 5 (`00-overview.md`'s non-goals). The cap
exists because this phase is also proving the *shape* — a goroutine
outliving a request, a job surviving a restart, a suspended job resuming
cleanly — and validating that shape under real concurrent load before
raising the number is the honest order to do the work in, not a
consequence of any technical ceiling. Raising the cap is a one-line change
once Phase 4 has run in anger; it is named as a follow-up rather than
attempted here.

## Failure modes

- **Two background jobs racing on the same file:** each job is a normal
  `chat.RunTurn` and goes through the same permission-session locking
  Phase 2's design doc already relies on for rewind — two jobs against the
  *same* workspace root serialize on that lock exactly as two interactive
  turns would. Jobs against different roots are fully independent.
- **A job whose workspace root is deleted mid-run:** the next file-tool
  call fails containment (`workspace.Resolve`) exactly as it would for a
  live turn; the job is marked `failed` with that error, not silently
  retried.
- **A job that never finishes** (runaway loop): bounded by the same
  `loopBudget{MaxSteps, Wall}` every turn already has — a background job is
  not exempt from the step/wall-clock budget, and hitting it ends the job
  as `failed` with the budget-exceeded reason already produced today,
  surfaced in the panel instead of a chat transcript.
