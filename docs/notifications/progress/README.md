# Progress

What has actually been built, as opposed to what is planned. The
[phases](README.md) hold the intent; this folder holds the record — dated,
with real numbers, and honest about what diverged.

**Last updated:** 2026-10-21 (Phase 00 shipped)

## Status

| Phase | Title | Status | Record |
|---|---|---|---|
| 00 | Pipeline core | ✅ Done — 2026-10-21 | [record](phase-00-pipeline-core.md) |
| 01 | LLM decision engine | ✅ Done 2026-10-21 (scoped 4/4 MET) | [record](phase-01-decision-engine.md) |
| 02 | Local delivery | ⚠️ Done with gaps 2026-10-21 (3/4 MET) | [record](phase-02-local-delivery.md) |
| 03 | External adapters | ⚠️ Done with gaps 2026-10-21 (3/4 MET) | [record](phase-03-external-adapters.md) |
| 04 | Bell inbox UI | ⚠️ Done with gaps 2026-10-21 (3/4 MET) | [record](phase-04-bell-ui.md) |
| 05 | Rollout | ⬜ Not started — blocked on 04 | — |

## What works today

- `emit_signal` validates a Vellum-style signal, records event + decision +
  delivery rows, persists the Bell feed item, and publishes
  `notification_intent` with a `deliveryId`.
- `notify_send` agent tool emits through the same path.
- Proven by: `cargo test --manifest-path backend/Cargo.toml`
  (lib 246 passed; `notify_pipeline` 4 passed; all targets green).

## What does **not** exist yet

External adapters (03), inbox UI (04), rollout cleanup (05).
Merged: Phase 02 (emitters on signals, intent with `deliveryId` +
`deepLinkTarget`), Phase 01 (LLM routing with deterministic fallback),
and Phase 03 (Telegram/Slack/Discord adapters, vault tokens, pairing,
channel connect UI, `13-notifications` journey). Merged-tree gates green:
lib notify 26, pipeline 12, notifications 9, channels 7, agent_mcp 38,
tsc clean for notifications, vitest 49, i18n parity.

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
