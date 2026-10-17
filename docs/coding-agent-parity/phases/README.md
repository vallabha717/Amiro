# Phases

Four phases, closing Tier 1 and Tier 2 of
[docs/future-implementation/amiro-vs-coding-agents-comparison.md](../../future-implementation/amiro-vs-coding-agents-comparison.md).
Each phase document names its own dependencies and exit criteria; this file
is the map between them.

## Dependency graph

```
Phase 0                Phase 1                Phase 2                Phase 3
Workspace trust         Checkpoints             Sandboxed               Git remote
+ AGENTS.md             & rewind                execution               operations
    │                       │                       │                       │
    │                   (no deps)                   │                       │
```

Phase 1 has no dependencies and blocks nothing — it is planned alongside
the others because it is the safety net a user reaches for immediately
after trusting an agent to do more (Phase 0), not because anything else
requires it. Phases 0, 2 and 3 are independent of each other and could ship
in any order.

## The phase table

| Phase | Title | Size | Depends on | Blocks |
|---|---|---|---|---|
| [0](phase-00-workspace-trust-and-rules.md) | Workspace trust + `AGENTS.md` — ⚠️ shipped 2026-08-23, 4/6 criteria | M | — | — |
| [1](phase-01-checkpoints-and-rewind.md) | Checkpoints & rewind — ⚠️ shipped 2026-08-29, 2/6 criteria literally (behavior proven) | M | — | — |
| [2](phase-02-sandboxed-execution.md) | Sandboxed shell execution — ⚠️ shipped 2026-08-29, 4/5 criteria | L | — | — |
| [3](phase-03-git-remote-operations.md) | Git push + PR creation — ⚠️ shipped 2026-08-29, 3/5 criteria literally | M | — | — |

Phases 0, 1, 2 and 3 are each independently shippable and each leave the
product strictly better on their own. With all four shipped, the plan
itself is complete — see each phase's own progress record for exactly what
was proven where, and `docs/coding-agent-parity/README.md` for the
rolled-up status.

## Rules that apply to every phase

1. A phase is done when its exit criteria are **checkable by running
   something**, not when the code exists.
2. Every phase ships its own tests, in `tests/`, on every surface it
   touches — and adds the guard that enforces any contract it introduces.
3. A phase must not blow the project's stated budget (runtime, binary size,
   default test duration) — if it does, it says so and tags what.
4. Every phase updates the docs it invalidates, and names them. In
   particular: Phase 0–3 landing means
   `docs/future-implementation/amiro-vs-coding-agents-comparison.md`'s
   Tier 1/Tier 2 gap list is stale and must be revised, not left to imply
   these gaps still exist.
5. Nothing regresses existing tests. Additive by default; a phase that
   touches product code says so up front.
