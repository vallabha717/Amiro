# 02 — Checkpoints and rewind

Settles Phase 1: what gets captured, when, where it's stored, and what
"restore" actually does.

## What a checkpoint is

Not a full-workspace snapshot (git already exists for that, and duplicating
it invites the two falling out of sync). A checkpoint is **the pre-image
of every file a turn is about to write**, captured lazily on that turn's
*first* `write_file`/`edit_file`/`multi_edit` call, before the write lands.
A turn that never writes a file has no checkpoint and nothing to rewind —
the "rewind" affordance simply doesn't appear on it.

## Where the bytes live

The existing local blob store (`internal/storage`) — content-addressed by
the file's pre-image hash, one blob per distinct pre-image, so two turns
that both touch an unchanged `README.md` share one stored copy rather than
duplicating it. A new small table, `checkpoint_files (thread_id, turn_id,
path, blob_id)`, is the index; the blob store already handles the bytes.
This is a reuse of an existing subsystem, not a new storage layer — see
`00-overview.md` principle 1.

## What "restore" does, precisely

`restore_checkpoint(thread_id, turn_id)`:

1. Look up every `checkpoint_files` row for that turn.
2. For each, re-resolve the path through `workspace.Resolve` — the same
   containment check every write already goes through. A path that no
   longer resolves inside the root (deleted parent directory, moved
   workspace) is refused for *that file*, reported, and does not abort the
   rest of the restore.
3. Write the blob's bytes back to disk.
4. Append a `session.Event` recording the rewind itself — which files, to
   what turn — so a reload of the thread shows "restored to before turn
   N", not a silent edit with no history. This is the event log doing
   exactly what it was inverted to do in the agentic-loop work: one record,
   no second account of what happened.

**What restore does not do:** it does not touch the conversation transcript
itself (the assistant's messages from that turn stay visible — this is a
file-system rewind, not a "forget this happened") and it does not cascade
— restoring turn N does not also restore turn N+1's writes, even if N+1
touched the same file. A user who wants to go back further restores again,
explicitly, one turn at a time. Silently cascading is how a user loses work
they didn't ask to lose.

## Retention

Checkpoints are capped per thread (a fixed count, matching the shape of the
existing memory store's `200`-note cap with reinforcement eviction in
`internal/agent/memory`) — oldest evicted first once the cap is hit. This
is a deliberate, named bound, not an unbounded append that becomes a
storage problem nobody planned for.

## Surface behavior

| Surface | Affordance | Confirmation |
|---|---|---|
| Web | "Rewind to here" action on any assistant message with file-writing tool calls | A dialog listing exactly which files revert, reusing the existing per-message action-menu pattern |
| TUI | `/rewind` slash command, and Esc-Esc as a shortcut for "the most recent turn" | Renders through `component/approval`'s existing "show what's about to happen, from input alone" contract — the confirmation *is* the file list, nothing new to build for the rendering |
| Desktop | Same as web (one React codebase, three places — see the `ui` skill) | — |

## Failure modes

- **A checkpoint whose blob was evicted:** the restore affordance for that
  turn is simply not offered — checked at render time against
  `checkpoint_files`, not assumed to always exist.
- **Concurrent write during a restore:** the restore holds the same
  per-thread lock the permission engine's session grants already use
  (`internal/agent/permission/session.go`), so a rewind and a live turn
  cannot interleave writes to the same file.
- **A file that was deleted, not edited, by the turn:** `write_file`
  creating a new file has no pre-image (nothing existed) — its checkpoint
  entry records "did not exist", and restore *removes* the file rather than
  writing empty bytes. Recorded here because it is the one asymmetric case
  a first implementation is likely to miss.
