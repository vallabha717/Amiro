# Phase 01 — LLM decision engine

> **Shipped 2026-10-21 (scoped 4/4 MET).** See [progress/phase-01-decision-engine.md](../progress/phase-01-decision-engine.md)
> for what was built, what diverged, and the verification log.

**Depends on:** 00 · **Blocks:** 03 · **Size:** L

**Surfaces touched:** backend (config + runtime bridge call)

This phase will route signals through a model call over the runtime bridge
(channel selection + per-channel copy) and fall back to the Phase 00
deterministic rules whenever the model path is unavailable or invalid.

## What already exists

Phase 00's `notify/decision.rs` (deterministic rules + `fallbackUsed` flag),
`runtime::start_turn` + `resolve_model` (`backend/src/runtime.rs`,
used by `chat.rs`), `backend/src/config.rs` + `amiro.example.toml` for new
settings. The decision row schema already carries `fallbackUsed`.

## Deliverables

### 1. Model path

- `notify/decision.rs`: `decide_llm` building the JSON-mode turn (system
  prompt with channel/event registries, signal JSON), 20s timeout, strict
  schema parse; any failure → deterministic fallback with `fallbackUsed:
  true`.
- Config `notify.decision_model` (default: resolved chat default) with an
  entry in `amiro.example.toml`/`.env.example`.
- Copy templates per `sourceEventName` for fallback rendering (schedule
  result, chat reply, heartbeat, test).

### 2. Test coverage

| Surface | Location | Covers |
|---|---|---|
| backend | unit tests in `decision.rs` | fallback on timeout/invalid JSON; per-channel copy present for selected channels; single call per signal |
| backend | `backend/tests/notify_pipeline.rs` (extend) | bridge-down run delivers identical channel set minus rendered copy |

**Deliberately not covered:** live model assertions (no provider key in
tests); prompt quality is reviewed by reading outputs, not asserted.

## Exit criteria

1. `cargo test --manifest-path backend/Cargo.toml` passes with the bridge
   stubbed down and up.
2. A test kills the bridge mid-run and asserts delivery still completes with
   `fallbackUsed: true`.
3. `notify.decision_model` set and unset both resolve to a sane model (test
   asserts the default path).
4. No test requires network or a provider key (`cargo test` runs offline).

## Risks

- **Latency on the notify path.** A 20s model call delays banners;
  mitigation: emit the local intent optimistically from the deterministic
  pre-decision, then upgrade copy when the model responds (design detail
  the implementer confirms or rejects in the progress record).
- **Cost per signal.** Mitigation: dedupe runs before the model call; silent
  pure-local signals may skip it (recorded per signal in the decision row).
