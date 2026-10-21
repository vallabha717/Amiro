# 02 — Decision engine

## How the model is reached

The backend already runs model turns through the runtime bridge
(`runtime::start_turn` with a `TurnPlan`, as `chat.rs` does). The decision
engine reuses that path: a small JSON-mode turn with **no tools**, a pinned
system prompt (registry of source channels, event names, channel policy),
and a response schema of `{ shouldNotify, selectedChannels, copy,
silent, dedupeKey, reasoning }`. Config `notify.decision_model` names the
model; default is the resolved chat default. Timeout 20s.

## Fallback (not optional)

When the runtime is unreachable, the model errors, times out, or returns
invalid JSON, `notify/decision.rs` decides deterministically: Vellum's
`isLocalNotificationSilent` rules (quiet payload, chat-reply toggle,
`allAlertsEnabled`, urgent/completion exemption), category enablement, and
the producer's channel hints. Fallback copy is the signal's title/body plus
the existing per-category default action. The decision row records
`fallbackUsed: true` either way.

## Budgets

- One model call per signal, not per channel; copy for all selected channels
  comes from that single response.
- Signals already decided `silent` by attention hints skip the model call
  only when nothing else needs rendering (external channels still need copy).
- Dedupe runs before the model call: repeated `dedupeKey` short-circuits to
  the stored decision.

## Test seams

Pure rules live in `decision.rs` unit tests (no runtime needed). The LLM
path is tested with a stubbed bridge response plus a live-offline contract:
fallback tests kill the bridge and assert identical delivery outcomes minus
the rendered copy. No test requires a provider key.
