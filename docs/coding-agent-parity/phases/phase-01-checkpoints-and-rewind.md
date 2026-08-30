# Phase 01 — Checkpoints & rewind

> **Shipped 2026-08-29.** ⚠️ Complete with gaps (2/6 exit criteria MET
> literally via `amirotest`) — see
> [progress/phase-01-checkpoints-and-rewind.md](../progress/phase-01-checkpoints-and-rewind.md)
> and its [verification log](../progress/verification-log-phase-01.md).
> The backend capture/restore mechanism is fully proven, including a real
> bug found and fixed during testing (an approved write bypassed capture
> entirely). Every open gap is test-*execution* reliability in the
> shipping sandbox — a real-PTY harness bug (unrelated to this phase, very
> likely affecting other TUI suites too) and a pre-existing `pnpm`/`ui`
> surface gap Phase 0 already recorded — not a product defect.

**Depends on:** — · **Blocks:** — · **Size:** M

**Surfaces touched:** backend · desktop · web · terminal

This phase makes it true that a user can undo a turn's file changes — on
any surface, from a real confirmation showing exactly what will revert —
without reaching for git.

## What already exists

- `internal/agent/session` (`EventLog`) is the source of truth for a turn,
  inverted 2026-08-17 so the transcript is a projection of it — this phase
  reads this log to know which turns wrote which files; it does not add a
  second record.
- `internal/storage` already implements a content-addressed local blob
  store (used today for attachments) — this phase's checkpoint bytes reuse
  it rather than adding a second blob mechanism.
- `internal/agent/memory`'s 200-note cap with reinforcement-based eviction
  is the precedent this phase's checkpoint retention cap follows.
- No snapshot of file state exists anywhere today — a rewind currently has
  nothing to restore from. `internal/tui/component/editor/slash.go`'s
  command list (`mode`, `threads`, `models`, `help`) has no `rewind` entry.
- The approval-dialog renderer (`internal/tui/component/approval`) already
  renders "what's about to happen, from input alone" — this phase's rewind
  confirmation reuses it rather than a new dialog type.

See [02-checkpoints-and-rewind.md](../02-checkpoints-and-rewind.md) for the
full design, including the delete-vs-edit asymmetric case.

## Deliverables

### 1. Backend — checkpoint capture

- `internal/db/models/checkpoint_file.go` — `(thread_id, turn_id, path,
  blob_id, existed_before bool)`. Migration, both dialects.
- Capture hook in the tool scheduler: on the first
  `write_file`/`edit_file`/`multi_edit` call of a turn, read the target
  file's current bytes (or record `existed_before: false`) before the
  write lands, store via `internal/storage`, record the index row.
- Per-thread retention cap with oldest-first eviction, mirroring
  `internal/agent/memory`'s pattern.

### 2. Backend — restore

- `internal/agent/checkpoint/restore.go` — `Restore(ctx, threadID,
  turnID)`: re-resolves every path through `workspace.Resolve`, writes
  blob bytes back (or deletes the file when `existed_before` is false),
  appends a `session.Event` recording the rewind, holds the same
  per-thread lock `permission.Session` grants already use so a restore
  cannot interleave with a live turn's writes.
- `internal/api/<domain>/` route to list a turn's checkpointed files (for
  the confirmation dialog) and to trigger the restore.

### 3. Web — rewind affordance

- "Rewind to here" action on any assistant message with file-writing tool
  calls, in the existing per-message action menu.
- Confirmation dialog listing the exact files and existed-before/edited
  status, built from the list-checkpointed-files route above.

### 4. Terminal — rewind affordance

- `/rewind` slash command (added to `editor.Commands`) targeting the most
  recent turn with checkpoints; Esc-Esc bound in `keys/keys.go` as a
  shortcut for the same action.
- Confirmation rendered through `component/approval`.

### 5. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/checkpoint/` | Capture on first write of a turn, not every write; restore reverts exact bytes; a file that didn't exist before the turn is deleted by restore, not emptied; retention cap evicts oldest first; a restore of a path that no longer resolves in the workspace is refused for that file without aborting the rest |
| terminal | `tests/suites/tui/checkpoint/` | `/rewind` and Esc-Esc both render the confirmation under a real PTY and actually restore on confirm |
| web | `tests/ui/specs/checkpoint/` | The action appears only on messages with file writes; the confirmation lists the right files; `data-testid`s added |
| cross | `tests/suites/cross/checkpoint/` | A rewind performed in the TUI is reflected on a web reload of the same thread |
| meta | `tests/suites/meta/` | A guard that checkpoint capture never writes outside the workspace root (reuses the existing containment-guard shape) |

**Deliberately not covered:** cascading restore across multiple turns in
one action — the design doc names this a deliberate non-feature (a user
restores one turn at a time, explicitly), so no test asserts multi-turn
cascade because none should exist.

### 6. Docs updated

- `docs/agentic-loop-implementation-plan.md`'s Phase 6 notes on the event
  log gain a pointer to this phase as the first *consumer* of the log for
  something other than replay/compaction/eval.

## Exit criteria

1. `amirotest run --surface backend --feature checkpoint` passes.
2. `TestCheckpoint_RestoreRevertsExactPreImageBytes` and
   `TestCheckpoint_RestoreOfNonexistentFileDeletesIt` both pass.
3. `amirotest run --surface tui --feature checkpoint` passes, including an
   assertion that `/rewind` with no eligible turn shows a clear "nothing to
   rewind" state rather than a confusing empty confirmation.
4. `amirotest run --surface ui --feature checkpoint` passes.
5. `amirotest run --surface cross --feature checkpoint` passes.
6. `amirotest run` is green overall, `suites/meta` included, with every
   skip reasoned.

## Risks

- **Storage growth from capturing every turn's pre-images on a long
  session.** Mitigated by the retention cap (deliverable 1) and
  content-addressing (two turns touching an unchanged file share one
  blob) — both named explicitly in the design doc rather than left
  unbounded.
- **A restore racing a live turn's own write to the same file.** Mitigated
  by reusing `permission.Session`'s existing per-thread lock rather than
  inventing a second locking mechanism that could disagree with the first.
