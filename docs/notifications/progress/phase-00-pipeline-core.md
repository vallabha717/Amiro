# Phase 00 — Pipeline core

**Status:** ✅ Complete
**Date:** 2026-10-21
**Verification Log:** [verification-log-phase-00.md](verification-log-phase-00.md)

---

## 1. What Shipped

The `notify` domain now exists in the backend: signals validate and enter
an audit trail, a deterministic decision routes every signal to the local
channel, the broadcaster persists the feed item and publishes the
`notification_intent` SSE event, and the agent can send notifications with
`notify_send`. Surfaces reached: backend only.

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| Notify domain | `backend/src/notify/mod.rs` | Module tree + `emit_signal`/`subscribe` re-exports |
| Signals | `backend/src/notify/signal.rs` | Vellum-style signal validation, urgency alias, event→category map |
| Audit stores | `backend/src/notify/store.rs` | `notification-events/decisions/deliveries.json` read-modify-write |
| Deterministic decision | `backend/src/notify/decision.rs` | Silence policy, category gating, fallback copy |
| Broadcaster | `backend/src/notify/broadcaster.rs` | Owns the SSE fan-out; `emit_signal` pipeline |
| Channel adapters | `backend/src/notify/adapters/{mod,local}.rs` | `ChannelAdapter` trait + local (feed + SSE) adapter |
| Agent tool | `backend/src/agent_mcp.rs` (`notify_send`) | Tool definition, handler, and test calling the pipeline |

### Tests Added

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend | `backend/src/notify/` unit tests | 9 | signal validation, urgency alias, category map, silence matrix |
| backend | `backend/tests/notify_pipeline.rs` | 4 | signal→decision→delivery→SSE; dedupe claim; `medium` alias; 400s |
| backend | `backend/src/agent_mcp.rs` test | 1 | `notify_send` emits through the pipeline, alias persists `normal` |

**Not covered, and why:** model routing (Phase 01), external sends
(Phase 03), UI (Phase 04). The phase touches no UI surface.

### Files Modified

| Path | Change | Lines |
|---|---|---|
| `backend/src/routes/notifications.rs` | Fan-out moved to broadcaster; feed helpers `pub(crate)`; stream subscribes to new channel | +8 / −16 |
| `backend/src/agent_mcp.rs` | `notify_send` tool + handler + test | +49 / −0 |
| `backend/src/lib.rs` | `pub mod notify;` | +1 / −0 |

---

## 2. What Diverged from the Plan, and Why

1. **Fan-out ownership moved, not duplicated.** The plan said the
   broadcaster "does SSE publish" alongside the existing channel. Keeping
   two channels would split subscribers, so the broadcaster now owns the
   single process-wide channel and `routes/notifications.rs` delegates to
   it. Same events, same filtering, one owner.
2. **No HTTP signal route in Phase 00.** The plan's test coverage names
   "401/400 cases". Auth (401) only exists at the HTTP layer, which Phase
   00 deliberately does not add — so the 401 case is not applicable yet.
   400 validation is tested through `emit_signal` directly. The signal HTTP
   route arrives with Phase 02's emitter switch.
3. **Desugared async trait method.** `async fn` in the `ChannelAdapter`
   trait trips the `async_fn_in_trait` lint (auto-trait bounds). The trait
   now declares `fn send(...) -> impl Future<...> + Send`, which the local
   adapter satisfies with its existing `async` block. Same call syntax.
4. **New files are rustfmt-clean; the tree is not.** `cargo fmt --check`
   reports drift across the whole pre-existing backend (rustfmt version
   skew). Only the touched regions were verified clean; reformatting the
   tree is out of scope.
5. **Disk pressure forced a mid-phase `cargo clean`.** The box hit 100%
   disk during the first full-suite link (`ld` bus error, an environment
   failure, not a code failure). After `cargo clean` the suite passed; a
   second clean (`-p amiro-backend`) after verification left 9G free for
   peer agents. Recorded as a follow-up for CI sizing.

---

## 3. Exit Criteria (Verbatim from the Phase 00 Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `cargo test --manifest-path backend/Cargo.toml` passes, including the new `notify_pipeline` suite. | ✅ MET | Full suite green (lib 246 passed incl. 9 notify + 1 tool test; `notify_pipeline` 4 passed; all other targets ok, 0 failed). See verification log. |
| 2 | A test asserts two emits with the same `dedupeKey` produce one delivery row and return the stored decision. | ✅ MET | `dedupe_key_claims_the_signal_once`: 1 event, 1 decision, 1 delivery row; second emit returns `duplicate: true` with the stored decision. |
| 3 | A test asserts `urgency: "medium"` persists as `"normal"`. | ✅ MET | `medium_urgency_persists_as_normal` + `notify_send` tool test assert persisted `normal`. |
| 4 | Existing `backend/tests/notifications.rs` passes unmodified. | ✅ MET | Target passes (15 passed in the full run); the file was not touched. |

---

## 4. Standards Compliance

`backend` applied: new domain in `backend/src/notify/` with `pub fn`
routes untouched, `AuthUser`-free internal path (uid passed in by callers
that already authenticated), JSON persistence under `AMIRO_HOME/store`
with the store lock, `ApiError(StatusCode, message)` with no secrets, no
`unwrap()` on request data, rustfmt-clean new code, public items
documented. `test` applied: unit + integration coverage per the test
skill; no network, no `~/.amiro`, temp homes per test. `ui` N/A (no UI
surface). There is no `suites/meta` in this repo revision (retired with
the Go harness); the equivalent guard (one delivery row per signal) is a
test assertion.

---

## 5. Known Scope Boundaries & Follow-ups

- **Signal HTTP route:** belongs to Phase 02 (emitter switch). Until then
  only `emit_signal` (Rust) and `notify_send` (agent tool) can inject
  signals.
- **LLM decision:** Phase 01. `fallback_used: true` is recorded on every
  Phase 00 decision by design.
- **External adapters:** Phase 03. `channels` is always `["local"]` today.
- **Disk/CI sizing:** this box runs at ~91% disk with one backend target
  dir; parallel full-workspace links OOM the linker. Phase 05 should note
  `-j 1` and per-target runs as the working invocation.
- **Cross-test SSE interference (handled):** the broadcast channel is
  process-wide, so the pipeline test skips foreign intents by `deliveryId`
  instead of assuming the next event is its own. Future SSE tests must do
  the same.
