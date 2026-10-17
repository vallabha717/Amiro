# Progress

What has actually been built, as opposed to what is planned. The
[phases](../phases/README.md) hold the intent; this folder holds the
record — dated, with real numbers, and honest about what diverged.

**Last updated:** 2026-08-29

## Status

| Phase | Title | Status | Record |
|---|---|---|---|
| 0 | Workspace trust + `AGENTS.md` | ⚠️ Complete with gaps (4/6 criteria MET) | [phase-00](phase-00-workspace-trust-and-rules.md) |
| 1 | Checkpoints & rewind | ⚠️ Complete with gaps (2/6 criteria MET literally; the underlying behavior is proven correct — see the record) | [phase-01](phase-01-checkpoints-and-rewind.md) |
| 2 | Sandboxed shell execution | ⚠️ Complete with gaps (4/5 criteria MET; verified against a real bubblewrap backend on Linux, `sandbox-exec` on macOS unverified — no macOS host available) | [phase-02](phase-02-sandboxed-execution.md) |
| 3 | Git push + PR creation | ⬜ Not started — **unblocked** | — |

Each phase's verification log holds the commands used to check it against a
real running system, with their output, so any claim here can be re-checked
rather than taken on trust.

## What works today

**Workspace trust (Phase 0), backend enforcement — fully proven:**

```
cd tests && go run ./cmd/amirotest run --surface backend --feature workspacetrust
# 5 passed, 0 failed
```

An ungranted, interactively-opened workspace root refuses every
consequential tool call (write/exec/external) in every permission mode,
including Auto — `permission.Engine.WithTrust(false)`. A root matching the
server's own configured default (`AMIRO_WORKSPACE_ROOT`, a CLI flag, or the
TUI's own launch directory) is auto-granted with no prompt. A grant made
from one surface (the HTTP API, what the desktop/web trust prompt itself
calls) is honored immediately by another attached client with no separate
step — proven cross-surface via `--connect`. `AGENTS.md` (or
`.agents/AGENTS.md`) is read into every turn's system prompt, ahead of the
Skills catalog.

**Workspace trust, UI surfaces — implemented, partially proven:**

- Web: a trust prompt on first open of an ungranted project directory
  (checked on every `projectDirectory` change, including page load from a
  previously-persisted value, not only a fresh pick), and a Settings card
  listing granted roots with revoke. Spec written; **could not be
  executed** in the sandbox this shipped from (no `pnpm`, and the
  installed Chromium is missing a system library) — see
  [phase-00](phase-00-workspace-trust-and-rules.md)'s divergence 5.
- Terminal: the same prompt, reusing the tool-approval dialog's rendering
  with its own hint text. Correct by direct instrumentation and by 6
  deterministic unit tests; the 3 real-PTY tests are **tagged `flaky`**
  and excluded from the default run — see divergence 4.

**Checkpoints & rewind (Phase 1), backend capture/restore — fully proven:**

```
cd tests && go run ./cmd/amirotest run --surface backend --feature checkpoint
# 7 passed, 0 failed
```

A turn's first write to a given file (within that turn) captures the
file's pre-image — or records that it did not exist — into the same
content-addressed blob store attachments already use; restoring writes it
back, or deletes the file for one that was created, one file at a time,
never aborting the rest of a restore over one bad path. Proven correct via
a real, load-bearing bug found only by testing the actual default UI flow:
an approved write (the default permission mode) originally bypassed
capture entirely, fixed and pinned by a regression test — see
[phase-01](phase-01-checkpoints-and-rewind.md)'s divergence 7.

**Checkpoints & rewind, UI surfaces — implemented, proven with one caveat:**

- Web: "Rewind to here" on any assistant message that wrote a file, with a
  confirmation dialog. The Playwright spec passes reliably (6/8 runs this
  session after the divergence-7 fix, 0/8 before it) run directly —
  `amirotest`'s own `ui` surface still cannot launch at all here (no
  `pnpm`, same gap as Phase 0). One residual, unexplained failure with the
  same symptom survives the fix — see divergence 7's follow-up.
- Terminal: `/rewind` and Esc-Esc, reusing the tool-approval dialog's
  rendering. Correct by direct instrumentation and by 9 deterministic unit
  tests; the 5 real-PTY tests (plus the 1 cross-surface test) are **tagged
  `flaky`** — a real, reproducible PTY-harness bug (a session
  intermittently echoes a just-sent line a second time) found during this
  phase's own testing, unrelated to checkpoints — see divergence 5.

**Sandboxed shell execution (Phase 2), Linux/bubblewrap — fully proven:**

```
cd tests && go run ./cmd/amirotest run --surface backend --feature sandbox
# 6 passed, 0 failed, 1 reasoned skip
```

Every `run_shell` call on Linux, when `bwrap` is installed and actually
able to create namespaces (smoke-tested, not just checked for on `PATH`),
is confined to the workspace root for writes and denied network by
default — a real, listening loopback server proves the denial is a genuine
"no route" rather than a dead port, and the same server is reachable once
the command's prefix is on the new `SandboxNetworkAllow` config. Every
result honestly reports `Sandboxed`/`SandboxBackend`, including the "no
backend available" fallback, proven environment-independent by physically
removing `/usr/bin/bwrap` and re-running the relevant unit tests — see
[phase-02](phase-02-sandboxed-execution.md)'s verification log.

**Sandboxed shell execution, macOS/`sandbox-exec` — implemented, not yet
verified:**

`seatbelt.go` exists, mirrors `bubblewrap.go`'s structure exactly, and
cross-compiles clean for `darwin/arm64` — but no macOS host was available
in the sandbox this shipped from, so it has never run against a real
`sandbox-exec` binary. A real, named gap, not implied coverage.

**Sandboxed shell execution, status surfaces — proven:**

The TUI status bar's `sandbox:<backend>` field is covered by a golden test
across all four states (`unset`/`bubblewrap`/`seatbelt`/`none`); the
web/desktop `TerminalWindow` badge is covered by inspecting the React
element tree `runShell.Expanded` returns (no jsdom in this repo's test
setup, so no rendered-DOM check exists to run even bypassing the missing
`pnpm`).

## What does **not** exist yet

Phase 3 in full. Specifically: no `push`/`create_pr` git operations —
`amiro run` and `task` subagents are both still request-scoped. Phase 2's
own remaining gap: `sandbox-exec` isolation on
macOS has never run against a real macOS host in this project's own
testing (the code exists, is wired identically to the proven Linux path,
and cross-compiles clean — it is simply unverified).

## Next up

Phase 3 is unblocked. Phases 0–2 shipped this session. Several open items
from Phases 0–2 are worth picking up
opportunistically by whoever next has a working `pnpm`/browser, a macOS
host to verify `sandbox-exec` on, or wants to chase the newly-found
real-PTY duplicate-echo bug (which very likely affects other `tests/suites/
tui/` suites too, not just Phase 1's) or the `tui/skills` slash-palette
row-budget overflow found during Phase 2's own testing (pre-existing,
Phase 1's `/rewind` addition, not Phase 2's bug) — see each phase's own
"Known Scope Boundaries & Follow-ups" — but none of them block starting
Phase 3.

## How to update this folder

When a phase ships, add `phase-NN-<slug>.md` and
`verification-log-phase-NN.md` here recording:

1. **What shipped** — files created and modified, with line counts.
2. **What diverged from the plan, and why.** The most valuable section and
   the one most likely to be skipped. A plan written before the code always
   gets something wrong; the record of *what* and *why* is what stops the
   next person re-litigating a decision already made with better
   information.
3. **How it was verified** — commands and their real output, not assertions
   that it works.
4. **Exit criteria**, checked off against the phase doc's own list.
5. **Follow-ups surfaced** — things found along the way that belong to a
   later phase.

Then update the status table above, and mark the phase doc itself with the
`> **Shipped YYYY-MM-DD.**` banner from `PHASE-TEMPLATE.md`.
