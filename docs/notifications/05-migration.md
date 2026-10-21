# 05 — Migration

## Existing data

`store/notifications.json` (v2 feed) and `store/notification-settings.json`
stay authoritative for the feed and settings. Phases add files; they do not
rewrite these. New audit files start empty: `notification-events.json`,
`notification-decisions.json`, `notification-deliveries.json`,
`notification-channels.json`.

## Compat shims (permanent, tested)

- Inbound `urgency: "medium"` maps to `normal` in `build_item`; outbound
  always writes `normal`. A backend unit test pins this.
- Inbound payloads without `deliveryId` get one generated (uuid), so old
  emitters keep working.
- Old receipt-less items render as delivered-locally; no backfill.
- `notify_send` agent tool accepts the old flat fields (title, body,
  category, urgency) and builds the signal server-side.

## Rollout order

Phase 00 keeps every existing route green. Phase 02 switches the three
emitters to signals behind the same function names. Phase 05 removes the
deprecated direct-persist path only after the new pipeline owns all traffic,
and documents the removed code. No phase ships a half-migrated emitter.
