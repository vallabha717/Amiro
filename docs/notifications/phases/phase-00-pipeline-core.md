# Phase 00 — Pipeline core

> **Shipped 2026-10-21.** See [progress/phase-00-pipeline-core.md](../progress/phase-00-pipeline-core.md)
> for what was built, what diverged, and the verification log.

**Depends on:** — · **Blocks:** 01, 02, 03 · **Size:** M

**Surfaces touched:** backend

This phase will create the `notify` domain (signal, stores, deterministic
decision, broadcaster, local adapter) and a signal-emit path alongside the
existing routes, without changing any current emitter or route behavior.

## What already exists

`backend/src/routes/notifications.rs` (feed, settings, SSE, ack),
`backend/src/state.rs` (`read_json`/`write_json`, store lock, `AuthUser`,
`ApiError`), `backend/tests/notifications.rs` (route tests to keep green).
Nothing in this phase deletes or renames those.

## Deliverables

### 1. `notify` domain

- `backend/src/notify/mod.rs`, `signal.rs` (signal + attention hints +
  source channel/event registries), `store.rs` (events/decisions/deliveries
  JSON files, feed helpers), `decision.rs` (deterministic rules: silence,
  category gating, dedupe), `broadcaster.rs` (fan-out + delivery rows +
  SSE publish), `adapters/mod.rs` + `adapters/local.rs` (`ChannelAdapter`
  trait + local adapter).
- `notify` wired into `backend/src/lib.rs`; no route changes yet except an
  internal `emit_signal(state, uid, signal)` used by tests.

### 2. Agent tool

- `notify_send` in `backend/src/agent_mcp.rs` calling the same emit path as
  the routes will; secret-needing flows return the secure card, never raw
  values.

### 3. Test coverage

| Surface | Location | Covers |
|---|---|---|
| backend | `backend/tests/notify_pipeline.rs` | signal→decision→delivery row→SSE intent; 401/400 cases; `medium`→`normal` alias; dedupeKey replay returns stored decision |
| backend | unit tests in `decision.rs` | silence matrix, category gating, fallback copy |

**Deliberately not covered:** model routing (Phase 01), external sends
(Phase 03), UI (Phase 04).

## Exit criteria

1. `cargo test --manifest-path backend/Cargo.toml` passes, including the new
   `notify_pipeline` suite.
2. A test asserts two emits with the same `dedupeKey` produce one delivery
   row and return the stored decision.
3. A test asserts `urgency: "medium"` persists as `"normal"`.
4. Existing `backend/tests/notifications.rs` passes unmodified.

## Risks

- **Store-file contention.** Three new files plus feed writes under one
  async mutex could serialize emitters; mitigation: keep critical sections
  to read-modify-write only, no network inside the lock (adapters send after
  release).
