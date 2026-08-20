---
name: implement
description: How Amiro executes a planned phase and records it — the counterpart to the `plan` skill. Takes one phase from a `docs/<initiative>/phases/` folder, checks its entry conditions, builds it to Amiro's UI and backend standards (loading the `ui`, `backend` and `test` skills for those rules), ships the phase's end-to-end tests in `tests/` on every surface it touches, verifies every exit criterion by running real commands, then writes the `progress/phase-NN-<slug>.md` record and `progress/verification-log-phase-NN.md`, updates the progress status table, marks the phase doc shipped, and updates every doc the work invalidated. Use whenever asked to implement, build, execute or ship a phase or a planned feature in Amiro, to continue an in-progress initiative, or to record and document work that was just completed.
---

# Amiro Implementation Method

Execute **one phase** of a plan folder (`docs/<initiative>/`), prove it, and
leave a record someone can re-check without trusting you. `docs/testing/`
is the reference implementation of the output shape — read
`docs/testing/progress/phase-04-tui.md` and its verification log before
your first pass.

If there is no plan folder for the work, stop and use the `plan` skill
first. Implementing straight from a prompt is how a subsystem ends up with
no exit criteria and no record.

## The contract

> **A phase is done when its exit criteria are checkable by running
> something — not when the code exists.** The verification log holds real
> commands and their real output. If a criterion could not be met, it is
> recorded as PARTIAL or NOT MET with the reason, never quietly rounded up.

## Workflow

### 1. Load context before touching anything

- The phase doc: deliverables, exit criteria, dependencies, risks.
- `progress/README.md` — what actually exists, and what does not.
- **Every prior phase's "What diverged from the plan" section.** The plan
  is not the authority where the record contradicts it; that is the whole
  reason the two folders are separate.
- **The standards skills**, always, before writing a line:
  - `ui` — anything under `src/**` or `backend-go/internal/tui/**`
  - `backend` — anything under `backend-go/**`
  - **`test` — always.** Every phase ships tests; there is no exception,
    and no "tests come later".

  Read the ones that apply. Most phases touch both `ui` and `backend`,
  because a feature that adds an endpoint also adds the client call and the
  surfaces that use it — and all three surfaces then need covering.

### 2. Check entry conditions

Verify the phases this one depends on are actually done — by running their
exit-criteria commands, not by reading their status row. If an entry
condition fails, say so and stop rather than building on it.

### 3. Build it

- Deliver **the whole phase**, in the order its deliverables are listed.
- Stay in scope. Something real found outside it gets recorded as a
  follow-up, not fixed silently — unless it is cheap and blocks
  verification, in which case fix it and record that you did.
- Follow the standards skills. If a standard genuinely cannot be met here,
  that is a divergence, and it gets written down with the reason.
- Cover every surface the phase claims: desktop (Tauri), web
  (`amiro serve`), terminal (TUI), backend. A phase that silently covers
  one surface and claims all of them is the failure this method exists to
  prevent.
- **Write the tests as part of the build, not after it.** See step 3b.

### 3b. Ship the tests with the feature

Not a follow-up, not a later phase. Per the `test` skill:

| The phase touched… | It adds |
|---|---|
| A route, repository, migration, auth rule | `tests/suites/backend/<feature>/` |
| A TUI screen, keybinding, launch flag | `tests/suites/tui/<feature>/` |
| A dashboard page, component, gate | `tests/ui/specs/<feature>/` (+ `data-testid` in `src/`, + a page object) |
| Sidecar lifecycle, ports, packaging | `tests/suites/desktop/<feature>/` |
| Anything two surfaces must agree on | `tests/suites/cross/<feature>/` |
| A new contract, artifact or invariant | a guard in `tests/suites/meta/` |

Non-negotiables the guards already enforce: a new route is covered in
`suites/backend/` or waived in `suites/meta/waivers.yaml` with an owner and
a reason; a new migration has a `tests/migration` case on **both** dialects;
no `time.Sleep` in a Go suite and no `page.waitForTimeout` in a spec; no
suite imports another suite or the application; nothing slow enters the
default run untagged.

A phase whose feature code is finished but whose tests are not is **not
finished**. Do not proceed to step 4 without them.

### 4. Verify, for real

Run the actual commands. Capture the actual output. The standard gates:

```bash
pnpm check                                            # biome + tsc + vitest        (frontend)
cd backend-go && go build ./... && go vet ./... && go test ./...      (backend)
go build -tags embedui ./cmd/amiro                    # the embed seam, both builds
cd tests && go run ./cmd/amirotest run                # the cross-surface harness
cd tests && go run ./cmd/amirotest run --surface <s>  # one surface, while iterating
```

- Run with `-race` for anything shared or concurrent.
- One criterion at a time, in the phase doc's own order and wording.
- A skipped test must be **reasoned** — a green run over a silently skipped
  surface is worse than a red one.
- `suites/meta` must be green. It is the guard layer: uncovered routes,
  sleeps, hardcoded waits, cross-suite imports, duplicate addresses and
  leaked secrets all fail there, and all of them are yours to fix.
- Confirm the new tests actually ran: `amirotest list --surface <s>` shows
  the new addresses, and the run's pass count went **up** by the number of
  tests you added. A new suite that silently matched nothing reads as green.

### 5. Write the record — both files, same day

`progress/phase-NN-<slug>.md` — from
[`PROGRESS-TEMPLATE.md`](PROGRESS-TEMPLATE.md):

1. **What shipped** — files created and modified, with line counts, and a
   **Tests Added** table: the suites and feature directories created, the
   test count per surface, and anything deliberately left uncovered with
   the reason (an absent toolchain, a dialect with no server here).
2. **What diverged from the plan, and why** — the most valuable section,
   and the one most often skipped. Every place the plan was wrong,
   incomplete, or impossible, with the reason. `docs/testing/`'s Phase 1
   has seven, one of which the Go compiler forbids outright.
3. **Exit criteria** — a table, criteria quoted verbatim from the phase
   doc, each ✅ MET / ⚠️ PARTIAL / ❌ NOT MET with the evidence.
4. **Standards compliance** — which of `ui` / `backend` / `test` applied,
   anything deliberately not followed, and the state of `suites/meta`.
5. **Known scope boundaries and follow-ups** — including real defects found
   and deliberately not fixed.

`progress/verification-log-phase-NN.md` — from
[`VERIFICATION-LOG-TEMPLATE.md`](VERIFICATION-LOG-TEMPLATE.md): one section
per criterion, each holding the command and its **real, pasted output**.
Never paraphrase output, never invent it, never write a command you did not
run.

### 6. Update everything the phase invalidated

Skipping this is how a plan folder rots. In order:

| File | Update |
|---|---|
| `progress/README.md` | Status row → ✅ Done + date, "Last updated", "What works today", "What does **not** exist yet", "Next up" |
| `phases/phase-NN-<slug>.md` | Add the `> **Shipped YYYY-MM-DD.**` banner pointing at the progress record |
| `phases/README.md` | Mark the row done; correct the phase table if the shape changed |
| `docs/<initiative>/README.md` | Status table, and any design doc statement this phase made false |
| The design docs (`0N-*.md`) | Config keys, schemas, trees this phase changed |
| `README.md` (repo root) | Only if a user-facing command, flag, prerequisite or layout changed |
| `tests/README.md` | If a suite, address or harness capability changed — and its "Not built yet" section, which goes stale fastest |
| `tests/config.example.yaml` | If the phase added a config key, plus the `suites/meta` drift guard that checks it |
| `tests/suites/meta/waivers.yaml` | If a route was deliberately left uncovered — owner and reason, never blank |

Correct any earlier claim this phase proved wrong, in the document that
made it, naming the correction. `docs/testing/` does this repeatedly — a
Phase 5 claim about the `embedui` seam is corrected in Phase 7's record.

### 7. Report

State plainly: what shipped, which criteria are MET / PARTIAL / NOT MET,
what diverged, what follow-ups were surfaced, and which phase is next. If
something did not work, say so with the output.

## Rules

1. **One phase per pass.** Finish it, record it, then start the next.
2. **Never write the progress record before the verification run.** It is a
   record, not a prediction.
3. **Divergence is expected; hiding it is not.** The plan was written before
   the code existed.
4. **A failing or partial criterion is recorded, not rounded up.** Phase 6
   shipped at 6/7 and said so.
5. **Follow-ups belong to whoever finds them to *record*, and to the plan to
   *schedule*.** Do not silently expand scope, and do not silently drop it.
6. **Additive by default.** A phase touching product code says so up front,
   and proves nothing regressed.
7. **Tests ship with the phase, on every surface it reaches.** "Tested in a
   later phase" is not an outcome this method accepts; an untestable-here
   criterion is recorded as PARTIAL with what it would take, per rule 4.

## Reference files in this skill

- [`PROGRESS-TEMPLATE.md`](PROGRESS-TEMPLATE.md) — the phase record.
- [`VERIFICATION-LOG-TEMPLATE.md`](VERIFICATION-LOG-TEMPLATE.md) — the verification log.

Related skills: `plan` (produces what this executes), `ui` and `backend`
(the standards this must build to), `test` (the harness, the surfaces, and
the coverage every phase owes).
