# Progress

What has actually been built, as opposed to what is planned. The
[phases](../phases/README.md) hold the intent; this folder holds the
record — dated, with real numbers, and honest about what diverged.

**Last updated:** <YYYY-MM-DD, or "not started">

## Status

| Phase | Title | Status | Record |
|---|---|---|---|
| 0 | <Title> | ⬜ Not started — **unblocked** | — |
| 1 | <Title> | ⬜ Not started — blocked on 0 | — |
| … | | | |

Each phase's verification log holds the commands used to check it against a
real running system, with their output, so any claim here can be re-checked
rather than taken on trust.

## What works today

<Nothing yet. Replaced, as phases land, with the commands a reader can
actually run and the output they can expect.>

## What does **not** exist yet

<Every phase. Kept explicit and current as phases land, because a plan
folder full of confident prose reads as if it describes reality.>

## Next up

<The first unblocked phase, and any findings from the previous phase that
it should carry forward.>

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

Then update the status table above, and mark the phase doc itself.
