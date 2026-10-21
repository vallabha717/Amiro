# Progress

What has actually been built, as opposed to what is planned. The
[phases](README.md) hold the intent; this folder holds the record — dated,
with real numbers, and honest about what diverged.

**Last updated:** 2026-10-21 (Phase 00 shipped)

## Status

| Phase | Title | Status | Record |
|---|---|---|---|
| 00 | Pipeline core | ✅ Done — 2026-10-21 | [record](phase-00-pipeline-core.md) |
| 01 | LLM decision engine | ⬜ Not started — **unblocked** | — |
| 02 | Local delivery | ⬜ Not started — **unblocked** | — |
| 03 | External adapters | ⬜ Not started — blocked on 00 (done) → **unblocked** | — |
| 04 | Bell inbox UI | ⬜ Not started — blocked on 02, 03 | — |
| 05 | Rollout | ⬜ Not started — blocked on 04 | — |

## What works today

- `emit_signal` validates a Vellum-style signal, records event + decision +
  delivery rows, persists the Bell feed item, and publishes
  `notification_intent` with a `deliveryId`.
- `notify_send` agent tool emits through the same path.
- Proven by: `cargo test --manifest-path backend/Cargo.toml`
  (lib 246 passed; `notify_pipeline` 4 passed; all targets green).

## What does **not** exist yet

LLM decision (01), emitter switch + signal HTTP route (02), external
adapters (03), inbox UI (04), rollout cleanup (05).

## Next up

Phase 01 (LLM decision engine) and Phase 02 (local delivery) are both
unblocked and independent. Suggested order: 01 then 02, since 03 builds on
01's rendered copy.

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
