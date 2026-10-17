# 00 — Overview

## Goal

Close the top of the gap list in
[docs/future-implementation/amiro-vs-coding-agents-comparison.md](../future-implementation/amiro-vs-coding-agents-comparison.md)
— the Tier 1 and Tier 2 items, which that document frames as "closest to
'this is a coding agent, not a chat app with tools'". Four phases:

1. Workspace trust consent UI + a plain, always-on project rules file.
2. Checkpoints and `/rewind`.
3. Sandboxed shell execution.
4. Git remote operations (`push`, PR creation), gated.

## What already exists (read before planning further)

Amiro's agent core was rebuilt in
[docs/agentic-loop-implementation-plan.md](../agentic-loop-implementation-plan.md)
(landed 2026-08-16 through 2026-08-17) and its Skills system in
[docs/skills/](../skills/) (landed 2026-08-22, today). This plan builds on
top of both without re-opening them:

- **Path containment** (`internal/agent/workspace`) is separate from
  **permission** (`internal/agent/permission`) by design — containment is
  "is this path in scope", non-negotiable; permission is "is the agent
  allowed", policy. Phase 0 adds a third, orthogonal question — "has a
  human ever agreed to run an agent against this root at all" — and must
  not blur it into either existing one.
- **Modes are Plan / Interactive / Edit / Auto** (`permission.Mode`,
  `internal/agent/permission/permission.go`) — a fourth mode, `Edit`,
  exists beyond what the comparison doc's earlier audit recorded. Path
  scoping applies in every mode including Auto; External risk is asked in
  every mode except Auto.
- **The event log is the source of truth** for a turn
  (`internal/agent/session`, inverted 2026-08-17) — the transcript is a
  projection of it. Phase 1 reads this log; it does not add a second one.
- **`git` is a fixed subcommand allowlist** with push/pull/fetch/
  reset/rebase/checkout deliberately absent (`internal/ai/tools/git.go`).
  Phase 3 is the first time this plan is revisited, and it stays an
  allowlist, not a passthrough.
- **`task` subagents run synchronously inside one parent turn**, read-only,
  structurally unable to recurse (`internal/api/chat/subagent.go`).
- **`amiro run`** (`cmd/amiro/run.go`) is a one-shot headless turn with no
  server-side persistence beyond the normal thread.
- **The cross-surface test harness** (`tests/`, see the `test` skill) is
  built and in daily use — every deliverable below lands inside it, in the
  existing `tests/suites/<surface>/<feature>/` shape, not a new one.

## Surfaces in scope

All four, every phase. Amiro is one backend behind a desktop GUI, a browser
dashboard, a terminal UI and the backend's own HTTP surface — see the `ui`
and `backend` skills. No phase below ships desktop-only or web-only; where
a surface's version of a feature is deliberately thinner (e.g., the TUI's
rewind confirmation reuses the approval-dialog renderer rather than a new
one), that is named in the phase, not silently skipped.

## Principles

1. **Compose existing primitives before adding new ones.** Phase 1's
   checkpoints reuse the existing local blob store
   (`internal/storage`), not a new content store.
2. **A gate that cannot be seen is not a gate.** Every new consequential
   action (a trust grant, a rewind, a sandboxed command's real isolation
   status, a push) is visible in the same tool-card / approval-card
   language the existing permission engine already established — never a
   silent decision.
3. **Degrade honestly, never silently.** Sandboxing (Phase 2) is not
   available on every OS/environment; when it isn't, the tool result and
   the status bar say so plainly, the same rule Phase 5 of the agentic-loop
   plan used for LSP discovery. A missing capability is not hidden by
   pretending the safe case ran.

## Non-goals

- **True multi-agent parallelism at Cursor/Antigravity scale** (5–8
  concurrent background runs). Named in the comparison doc's Tier 3; out
  of scope here.
- **Browser automation / a self-testing subagent** (Antigravity's Browser
  Subagent). Named in the comparison doc's Tier 3; out of scope here.
- **A third-party plugin system.** Also Tier 3; unrelated to what these
  four phases unlock.
- **Windows process sandboxing.** Phase 2 documents Windows as unsandboxed
  for this round (job objects are real work, not a checkbox) rather than
  quietly shipping a weaker guarantee under the same claim as macOS/Linux.
- **Rewriting the plan-review / walkthrough artifacts.** Phase 1's
  checkpoints are a new capability alongside them, not a replacement.

## Decisions already made

See [README.md](README.md#decisions-already-made) — kept in one place so
they are not repeated, or accidentally re-litigated, per phase.
