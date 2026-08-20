# Phase NN — <Title>

**Status:** ✅ Complete | ⚠️ Complete with gaps (N/M criteria MET)
**Date:** YYYY-MM-DD
**Verification Log:** [verification-log-phase-NN.md](verification-log-phase-NN.md)

---

## 1. What Shipped

One paragraph, past tense, saying what now exists that did not before.
Name the surfaces it reaches (backend · desktop · web · terminal).

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **<Name>** | `path/to/file.go` | What it does, in one sentence. |

### Tests Added

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend | `tests/suites/backend/<feature>/` | N | … |
| terminal | `tests/suites/tui/<feature>/` | N | … |
| web | `tests/ui/specs/<feature>/` | N | … |
| cross | `tests/suites/cross/<feature>/` | N | … |
| meta | `tests/suites/meta/<guard>_test.go` | N | the contract it enforces |

**Not covered, and why:** <an absent toolchain, a dialect with no server
here, a criterion needing a companion suite — with what it would take.
"Nothing" is a legitimate answer only if it is true.>

### Files Modified

| Path | Change | Lines |
|---|---|---|
| `path/to/existing.ts` | What changed and why | +NN / -NN |

---

## 2. What Diverged from the Plan, and Why

The most valuable section in this file. Every place the plan was wrong,
incomplete, or impossible — with the reason, so nobody re-litigates a
decision already made with better information. "Nothing diverged" is a
legitimate answer only if it is true.

1. **<Short title of the divergence>:**
   What the plan said, what is actually the case, what was done instead,
   and why. Cite the file or the error that forced it.

2. **<Short title>:**
   …

---

## 3. Exit Criteria (Verbatim from the Phase NN Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | <quoted verbatim from the phase doc> | ✅ MET | <the command, the number, the assertion — pointing at the verification log> |
| 2 | <quoted verbatim> | ⚠️ PARTIAL | What was met, what was not, and what it would take. |
| 3 | <quoted verbatim> | ❌ NOT MET | Why, and where it is now tracked. |

---

## 4. Standards Compliance

Which of the `ui` / `backend` / `test` standards applied, and anything
deliberately not followed, with the reason. Every phase touches `test`, so
that row is never absent: state that `suites/meta` is green — no uncovered
route, no sleep, no hardcoded wait, no cross-suite import, no duplicate
address, no leaked secret — or say which guard is failing and why.

---

## 5. Known Scope Boundaries & Follow-ups

- **<Boundary>:** what this phase deliberately did not cover, and where it
  belongs instead.
- **<Defect found, not fixed>:** what it is, why it was out of scope, and
  what a reader should do about it.
- **<Follow-up for a later phase>:** stated as a task, not a wish.
