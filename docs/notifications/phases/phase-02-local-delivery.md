# Phase 02 — Local delivery

> **Shipped 2026-10-21 with gaps (3/4 MET).** See [progress/phase-02-local-delivery.md](../progress/phase-02-local-delivery.md)
> for what was built, what diverged, and the verification log.

**Depends on:** 00 · **Blocks:** 04 · **Size:** M

**Surfaces touched:** backend, web, desktop (bridge payload only)

This phase will switch the three existing emitters (chat reply, schedule
result, heartbeat) to signals, extend the SSE intent with `deliveryId` and
deep-link target, and bring the web client to Vellum parity: quiet hours,
presence suppression, per-surface acks.

## What already exists

Emitters in `chat.rs`, `schedules.rs`, `heartbeat.rs` calling
`emit_notification`; SSE `stream_notifications`; client
`deliverNotification` (quiet hours, dedup, focused-thread path, desktop →
web → toast, ack per receipt class); service worker click routing;
`desktop_show_notification` Tauri bridge. All of it stays, reshaped onto
the pipeline.

## Deliverables

### 1. Backend emitter switch

- The three emitters build signals (`sourceEventName`, attention hints,
  `threadId`/`scheduleId` as context) and call `emit_signal`; the old
  direct-persist helper remains for compat (removal is Phase 05).
- SSE intent gains `deliveryId` + `deepLinkTarget`; `ack` keeps the four
  receipt classes and appends to `receipts[]`.

### 2. Web client parity

- `src/lib/notifications/notification-runtime.ts`: consume `deliveryId`,
  deep-link navigation via `deepLinkTarget`, keep quiet-hours/presence/dedup
  semantics; no new surfaces.
- Service worker: route clicks via `deepLinkTarget`.

### 3. Test coverage

| Surface | Location | Covers |
|---|---|---|
| backend | `backend/tests/notify_pipeline.rs` (extend) | each emitter's signal fields; intent carries `deliveryId` |
| frontend | `src/lib/notifications/*.test.ts` (extend) | quiet-hours gating, focused-thread suppression, ack mapping |
| e2e | notifications journey steps (number per `e2e-journeys` skill) | schedule-run → Bell badge → toast; click routes to thread |

**Deliberately not covered:** Bell visual redesign (Phase 04); the journey
asserts behavior through the current Bell.

## Exit criteria

1. `cargo test --manifest-path backend/Cargo.toml` passes.
2. `pnpm check-types && pnpm lint && pnpm test` passes.
3. `pnpm build && pnpm --dir tests e2e --project <notifications-journey>
   -g "<new step titles>"` passes and the feature video is watched.
4. No emitter calls the old direct-persist path (grep guard in the test).

## Risks

- **Double delivery during migration.** Old and new paths could both fire;
  mitigation: emitters call exactly one path; a test asserts one delivery
  row per signal.
