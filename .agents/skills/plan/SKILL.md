---
name: plan
description: How Amiro plans a body of work — the phased plan-folder method used by `docs/testing/`. Produces `docs/<initiative>/` containing an indexed README, numbered design documents that settle the open questions, a `phases/` folder of independently shippable phases with explicit dependencies, checkable exit criteria and their own end-to-end test coverage, and a seeded `progress/` folder that will later record what was actually built. Use whenever asked to plan, design, scope, spec, or produce an implementation plan or roadmap for a feature, subsystem, migration or refactor in Amiro — and before starting any change large enough to span more than one sitting. Planning only: it writes documents, never product code. The `implement` skill executes what this produces.
---

# Amiro Planning Method

Plan a body of work the way `docs/testing/` was planned: a folder of
documents that settle the design, a numbered sequence of independently
shippable phases, and a separate progress folder that later records
reality. Read `docs/testing/` before writing your first plan — it is the
reference implementation of everything below, and `docs/tui/` is a second,
lighter-weight example.

**This skill writes documents only.** No product code, no test code, no
"while I was here" fixes. Executing a phase is the `implement` skill's job.

## The one rule everything else follows from

> **`phases/` is intent. `progress/` is reality. They are kept in separate
> folders so a confidently-written plan is never mistaken for a status
> report.**

A plan document may be wrong; that is expected and fine. What is not
acceptable is a plan that *reads* as if it already exists. Never write "the
harness handles X" in a phase doc — write "Phase 3 will add X".

## Folder shape

```
docs/<initiative>/
├── README.md                 # the index: read-in-order table, status, decisions already made
├── 00-overview.md            # goals, surfaces in scope, principles, non-goals
├── 01-<area>.md              # one document per question the plan must settle
├── 02-<area>.md              # (architecture, config, selection, artifacts, CI, ...)
├── phases/
│   ├── README.md             # dependency graph, the phase table, rules for every phase
│   └── phase-NN-<slug>.md    # one file per phase, numbered from 00
├── progress/
│   └── README.md             # seeded now, "Not started"; filled in by `implement`
└── reference/                # optional: example configs, target trees, API surfaces
```

Numbering is two digits from `00`, and the slug is kebab-case and stable —
it appears in the phase file, the progress file and the verification log
(`phase-04-tui.md`, `progress/phase-04-tui.md`,
`progress/verification-log-phase-04.md`).

## Workflow

1. **Survey what already exists.** Read the relevant code, not just the
   docs. Every phase doc has a "What already exists" section, and it must be
   true. Note which existing tests, docs or contracts the work will
   invalidate.
2. **Load the standards skills.** `ui` and/or `backend`, whichever the work
   touches, **and `test` always**. A plan that proposes a Next.js route
   handler, a sqlite-only migration, or a private `writeJSON` helper is a
   plan that will be rejected during implementation — and a plan with no
   test coverage in its phases is one that cannot be verified at all.
3. **Settle the decisions before writing phases.** Anything genuinely open
   goes to the user as a question now; anything you can decide, decide, and
   record it under **"Decisions already made"** in `README.md` with the
   reasoning. That section exists to stop the same argument recurring in
   every phase.
4. **Write `00-overview.md`** — goals, which of Amiro's surfaces are in
   scope (desktop / web / terminal / backend), principles, and an explicit
   **non-goals** list.
5. **Write the design documents.** One numbered file per question that has
   an answer worth writing down once: architecture, folder layout, config
   schema, contracts, failure modes. Phases reference these; they do not
   restate them.
6. **Decompose into phases.** See the rules below. Draw the dependency
   graph as ASCII in `phases/README.md`, and give every phase a size
   (S ≈ a focused sitting, M ≈ a few, L ≈ sustained with review points).
7. **Seed `progress/README.md`** with the status table, every phase marked
   "⬜ Not started", and the "How to update this folder" section. It is
   created at plan time and stays empty of claims.
8. **Write `README.md` last** — the read-in-order table, the phase table
   with `Blocks`, a pointer to `progress/`, and the decisions section.
9. **Do not write code.** Hand off by naming the first unblocked phase.

Copy `PHASE-TEMPLATE.md` and `PROGRESS-README-TEMPLATE.md` from this skill's
directory rather than reinventing the section order.

## What makes a good phase

| Requirement | Test for it |
|---|---|
| **Independently shippable** | Merging only this phase leaves the repo better, not half-broken |
| **Explicit dependencies** | `Depends on: 1, 2 · Blocks: 7` at the top of the file |
| **Checkable exit criteria** | Every criterion is verified by *running something* and reading its output — never "X is implemented" or "the code is clean" |
| **Numbered deliverables** | A reader can tell what files will exist afterwards |
| **Named risks** | With the mitigation, not just the worry |
| **Bounded** | If it needs more than a handful of review points, split it |

Exit criteria are the part most often written badly. Compare:

- ❌ "The TUI suite is complete and reliable."
- ✅ "`amirotest run --surface tui` passes in under 3 minutes."
- ✅ "All three `amiro run` exit codes are asserted."
- ✅ "Zero sleeps in the suite — enforced by a `suites/meta/` grep guard."

Order phases so the thing everything else needs comes first
(`docs/testing/` built `amiro serve` as Phase 0 because UI E2E had nothing
to point at without it), and so each phase can actually be verified when it
lands.

## Testing is planned, not appended

**Every phase carries its own end-to-end tests as a deliverable.** There is
no "testing phase" at the end, and no phase whose tests are someone else's
problem. Load the `test` skill while decomposing, and for each phase write
down:

- **Which surfaces it touches** — backend · terminal · web · desktop — and
  therefore which of `tests/suites/<surface>/<feature>/` and
  `tests/ui/specs/<feature>/` gain directories. Name them in the
  deliverables, with the feature directory spelled out.
- **A `cross` test** whenever two surfaces must agree about the same thing.
  Two passing single-surface tests do not prove they see the same thread.
- **The guard** for any contract the phase introduces — a new route is
  already caught by `suites/meta/route_coverage_test.go`, but a new
  artifact, config key or invariant needs its own `suites/meta/` guard, and
  that guard is part of the phase, not a follow-up.
- **Exit criteria phrased as test commands**, because a criterion that is
  not runnable is not checkable:
  `` `amirotest run --surface tui --feature chat` passes in under 30s ``.
- **What is deliberately not covered**, and why — a toolchain that is
  absent, a dialect with no server here. Recorded up front, so the
  implementation records it as a reasoned skip rather than a silent one.

If a phase's deliverables list has no test entry, the phase is not
finished being planned.

## Rules that apply to every phase

Put a version of this list in `phases/README.md`, adapted to the initiative:

1. A phase is done when its exit criteria are **checkable by running
   something**, not when the code exists.
2. Every phase ships its own tests, in `tests/`, on every surface it
   touches — and adds the guard that enforces any contract it introduces.
3. A phase must not blow the project's stated budget (runtime, binary size,
   default test duration) — if it does, it says so and tags what.
4. Every phase updates the docs it invalidates, and names them.
5. Nothing regresses existing tests. Additive by default; a phase that
   touches product code says so up front.

## Cross-surface planning

Amiro is four surfaces off one backend: the Tauri desktop app, the browser
dashboard (`amiro serve`), the terminal UI, and the Go backend itself. When
you decompose, state per phase **which surfaces it touches**, and never let
a surface be silently skipped — a plan that quietly covers only the desktop
app is the failure mode this method exists to prevent. If a surface is out
of scope, put it in `00-overview.md`'s non-goals with the reason — and if
it is in scope, it has a test directory named in that phase's deliverables.

## When the initiative is small

Not everything needs nine phases and a `reference/` folder. For a smaller
piece of work, collapse to a single folder with three files —
`docs/<initiative>/README.md` (goals, design, decisions),
`implementation-plan.md` (phases inline), and `progress.md` (the build log,
one section per phase, newest phase appended) — which is exactly what
`docs/tui/` does. The rules do not change: phases, checkable exit criteria,
and intent kept separate from record.

## Reference files in this skill

- [`PHASE-TEMPLATE.md`](PHASE-TEMPLATE.md) — the section order for one phase document.
- [`PROGRESS-README-TEMPLATE.md`](PROGRESS-README-TEMPLATE.md) — the seeded `progress/README.md`.

Related skills: `test` (the coverage every phase must plan for), `ui` and
`backend` (the standards a plan must not contradict), `implement`
(executes what this produces).
