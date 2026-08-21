# Phases

Seven phases, numbered from 00. `phases/` is intent; the record of what was
actually built lives in [`../progress/`](../progress/README.md).

## Dependency graph

```
        ┌──────────────────────────────────┐
        │ 0 · discovery core + read API    │  backend
        └───────────────┬──────────────────┘
                        │
        ┌───────────────┴──────────────────┐
        │ 1 · disclosure + activation      │  backend
        └───┬───────────┬───────────┬──────┘
            │           │           │
    ┌───────┴────┐ ┌────┴──────┐    │
    │ 2 · web /  │ │ 3 · TUI / │    │        web+desktop · terminal
    └───────┬────┘ └────┬──────┘    │
            │           │           │
            │           │      ┌────┴──────────────────┐
            │           │      │ 4 · authoring API     │  backend
            │           │      └────┬──────────────────┘
            │           │           │
            │           │      ┌────┴──────────────────┐
            └───────────┼──────┤ 5 · Skills UI + AI    │  web+desktop
                        │      └────┬──────────────────┘
                        │           │
                   ┌────┴───────────┴──────────────────┐
                   │ 6 · decommission agents           │  all
                   └───────────────────────────────────┘
```

2 and 3 are independent of each other and of 4; 4 and 5 can proceed while
the palettes are being built. 6 is last because it removes the thing the
Skills UI replaces, and doing it earlier leaves the dashboard with a hole.

## The phase table

| # | Title | Surfaces | Size | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| [0](phase-00-discovery.md) | Discovery core + read API | backend | M | — | 1, 2, 3, 4 | ✅ Shipped |
| [1](phase-01-activation.md) | Disclosure, activation tool, skill mentions | backend | M | 0 | 2, 3, 6 | ✅ Shipped |
| [2](phase-02-web-palette.md) | `/` palette in the web composer | web · desktop | M | 1 | 6 | ✅ Shipped |
| [3](phase-03-tui-palette.md) | `/` palette in the TUI | terminal | S | 1 | 6 | ✅ Shipped |
| [4](phase-04-authoring-api.md) | Create / edit / delete API | backend | M | 0 | 5 | ✅ Shipped |
| [5](phase-05-skills-ui.md) | Skills section + Generate with AI | web · desktop · backend | L | 4 (2 for the palette chip) | 6 |
| [6](phase-06-decommission-agents.md) | Remove agents | backend · web · desktop · terminal | M | 1, 2, 3, 5 | — |

Sizes: S ≈ a focused sitting · M ≈ a few · L ≈ sustained with review points.

## Rules that apply to every phase

1. A phase is done when its exit criteria are **checkable by running
   something**, not when the code exists.
2. Every phase ships its own tests, in `tests/`, on **every surface it
   touches** — and adds the `suites/meta/` guard for any contract it
   introduces. A new route is already caught by
   `suites/meta/route_coverage_test.go`; a new invariant is not, and its
   guard is part of the phase, not a follow-up.
3. **The standard is not renegotiated per phase.** Frontmatter fields, name
   rules and the disclosure tiers come from
   [`../reference/agent-skills-standard.md`](../reference/agent-skills-standard.md).
   A phase that needs to deviate says so in its Open questions and updates
   `../README.md`'s decisions section — it does not quietly diverge.
4. **No duplicates ever reach a client.** Dedup happens once, in the
   backend. A phase that adds client-side dedup has broken rule 4 and
   should fix the backend instead.
5. **`~/.agents/skills/` is the only writable directory.** Any phase that
   writes elsewhere is wrong, and the meta guard from Phase 4 will say so.
6. Every phase updates the docs it invalidates, and names them —
   `tests/README.md`'s stale "Not built yet" section included, since these
   phases add suites it claims do not exist.
7. Nothing regresses existing tests. Phases 0–5 are additive; Phase 6 is
   the only one that deletes product code, and it says so up front.
8. Skills are untrusted text. A phase that puts skill content into a prompt,
   a log, or an artifact routes it through the wrapping and redaction
   described in [`../03-authoring-and-safety.md`](../03-authoring-and-safety.md).
