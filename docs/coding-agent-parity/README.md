# Coding-Agent Parity Plan

Closes the top of the gap list in
[docs/future-implementation/amiro-vs-coding-agents-comparison.md](../future-implementation/amiro-vs-coding-agents-comparison.md):
workspace trust, checkpoints/rewind, sandboxed shell execution, and git
push/PR — the items that document ranks "closest to 'this is a coding
agent, not a chat app with tools'".

## Read in this order

| # | Document | What it settles |
|---|---|---|
| 00 | [Overview](00-overview.md) | Goals, what already exists, surfaces in scope, principles, non-goals |
| 01 | [Workspace trust & rules](01-workspace-trust-and-rules.md) | The trust-grant model; `AGENTS.md` vs. a Skill |
| 02 | [Checkpoints & rewind](02-checkpoints-and-rewind.md) | What gets captured, where it lives, what restore does |
| 03 | [Sandboxed execution](03-sandboxed-execution.md) | Per-platform isolation, the honest-degrade contract |
| 04 | [Git remote operations](04-git-remote-operations.md) | `push`/`create_pr` shape, credentials, the always-ask gate |
| — | [**Progress**](progress/README.md) | What is actually built, phase by phase |

## Progress

**[`progress/`](progress/README.md) is the record of what has actually
been built.** This folder and `phases/` describe intent; `progress/`
describes reality, kept deliberately apart so a confidently-written plan is
never mistaken for a status report.

| Phase | Status |
|---|---|
| 0 | ⚠️ Complete with gaps (4/6 criteria MET) — [record](progress/phase-00-workspace-trust-and-rules.md) |
| 1 | ⚠️ Complete with gaps (2/6 criteria MET literally; underlying behavior proven) — [record](progress/phase-01-checkpoints-and-rewind.md) |
| 2 | ⚠️ Complete with gaps (4/5 criteria MET; verified against a real bubblewrap backend, macOS unverified) — [record](progress/phase-02-sandboxed-execution.md) |
| 3 | ⚠️ Complete with gaps (3/5 criteria literally MET; the other 2 proven at the unit/HTTP layer, blocked from a literal pass by pnpm/PTY environment gaps) — [record](progress/phase-03-git-remote-operations.md) |

## Phases

The build order lives in [`phases/`](phases/README.md). Four phases, each
with its own exit criteria and an explicit dependency graph.

| Phase | Title | Size | Blocks |
|---|---|---|---|
| [0](phases/phase-00-workspace-trust-and-rules.md) | Workspace trust + `AGENTS.md` | M | — |
| [1](phases/phase-01-checkpoints-and-rewind.md) | Checkpoints & rewind | M | — |
| [2](phases/phase-02-sandboxed-execution.md) | Sandboxed shell execution | L | — |
| [3](phases/phase-03-git-remote-operations.md) | Git push + PR creation | M | — |

## Decisions already made

These were settled before the phase documents were written; they are not
open questions for implementation to re-litigate.

1. **Compose existing primitives before adding new ones.** Checkpoints
   reuse the local blob store; the trust prompt and rewind confirmation
   both reuse the existing approval-card renderer. No phase adds a second
   version of a mechanism Amiro already has.
2. **The rules file is named `AGENTS.md`**, not `.cursorrules` or
   `CLAUDE.md` — vendor-neutral, matching the reasoning
   `docs/skills/00-overview.md` already applied to the Skills format
   itself. See [01](01-workspace-trust-and-rules.md).
3. **A rules file is not a Skill, and the two stay conceptually
   separate** — `AGENTS.md` is read unconditionally every turn; Skills
   activate on demand. Conflating them would reintroduce the
   context-bloat problem Skills' progressive disclosure exists to prevent.
4. **Sandboxing degrades honestly, never silently.** Every `run_shell`
   result states whether it was actually isolated. Windows is documented
   as unsandboxed this round, not quietly shipped as equivalent to
   macOS/Linux. See [03](03-sandboxed-execution.md).
5. **Push and PR creation are gated tighter than `RiskExternal` alone** —
   a new `AlwaysAsk` predicate that asks even in Auto mode, because a push
   reaches a system outside the user's own machine, which nothing else in
   the tool set does today. See [04](04-git-remote-operations.md).
6. **No `gh` CLI dependency.** `create_pr` calls the GitHub REST API
   directly, consistent with the backend standard's "pure Go, no new
   runtime dependency" — the same reasoning that already kept `ripgrep` and
   tree-sitter out of other tools.
7. **GitHub only, this round.** GitLab/Bitbucket support is real but
   deferred, not blocking Phase 3.
