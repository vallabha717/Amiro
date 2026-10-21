# 01 — Architecture

## What already exists

- `backend/src/routes/notifications.rs`: feed persistence
  (`store/notifications.json`, `store/notification-settings.json`), `silent`
  policy, `emit_notification` helper, SSE stream, CRUD + ack + settings
  routes. Callers: `chat.rs` (chat_reply), `schedules.rs` (schedule_result),
  `heartbeat.rs` (heartbeat).
- `src/lib/notifications/`: `notification-types.ts` (item, settings, parse,
  normalize), `notification-runtime.ts` (dedup, desktop/web/toast delivery,
  `useNotificationStream`, ack).
- `src/components/notifications/notifications-bell.tsx`: current popover.
- `public/amiro-notifications-sw.js`: click-to-focus routing.
- `backend/tests/notifications.rs`: route integration tests.
- Runtime bridge: `runtime::start_turn` (`backend/src/runtime.rs`,
  `backend/src/chat.rs`) runs model turns from the backend — the decision
  engine's model path.

## The pipeline (Vellum, ported to Amiro)

```
producer → signal → event row → decision → broadcast → adapters → deliveries
                              (LLM, else      (SSE + local +
                               deterministic)  telegram/slack/discord)
```

New Rust domain `backend/src/notify/` (top-level domain per backend skill;
several route groups plus background work):

| Module | Owns |
|---|---|
| `notify/signal.rs` | `NotificationSignal`: signalId, createdAt, sourceChannel, sourceContextId, sourceEventName, contextPayload, attentionHints (requiresAction, urgency, isAsyncBackground, visibleInSourceNow), dedupeKey, routingIntent, routingHints |
| `notify/store.rs` | JSON audit files + feed; store-locked read-modify-write via `state.rs` helpers |
| `notify/decision.rs` | Deterministic rules (silence, recipient gating, dedupe) + LLM call shaping |
| `notify/broadcaster.rs` | Fan-out to adapters, delivery rows, `notification_intent` SSE publish |
| `notify/adapters/` | `local.rs`, `telegram.rs`, `slack.rs`, `discord.rs` — one `ChannelAdapter` trait |

Stores under `AMIRO_HOME/store`: `notification-events.json`,
`notification-decisions.json`, `notification-deliveries.json` (new audit),
plus the existing `notifications.json` (feed) and
`notification-settings.json`.

## Event and delivery shapes

Signal and delivery payloads mirror Vellum's `ChannelDeliveryPayload`:
`deliveryId`, `sourceEventName`, per-channel `copy` (title, body,
deliveryText), `deepLinkTarget` (`threadId`/`scheduleId`), `urgency`,
`silent`, `approvalContext` for approval cards. The SSE `notification_intent`
keeps its current fields and gains `deliveryId` and `deepLinkTarget`.

## Deliberate divergences from Vellum

- Urgency `normal` stays canonical; `medium` is accepted as an alias.
- Receipt classes stay surface-named (`desktop_native`, `web_notification`,
  `in_app_toast`, `client_os_posted`) — they describe Amiro's real
  surfaces, unlike Vellum's provider-side classes.
- No `platform` adapter, no `targetActorPrincipalId` hub scoping (single-user
  server; `AuthUser` scoping already isolates users).
- Feed and audit coexist: the Bell feed (`notifications.json`) remains the
  inbox; audit files are the trail, not the UI source.
