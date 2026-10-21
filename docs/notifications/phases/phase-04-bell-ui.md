# Phase 04 — Bell inbox UI

**Depends on:** 02, 03 · **Blocks:** 05 · **Size:** L

**Surfaces touched:** web (desktop inherits the same build)

This phase will replace the clumsy Bell popover with a Vellum-style inbox:
filterable feed, detail view with delivery state and actions, and settings
including channel bindings — in English and Hindi, light and dark.

## What already exists

`notifications-bell.tsx` (to be split, not patched in place),
`notification-types.ts` / `notification-runtime.ts` (feed, stream, ack —
extended by Phases 02/03 with delivery states, resend, bindings), the admin
notifications page, the service worker. The old bell stays until the new
inbox renders all its states; no two bells ship.

## Deliverables

### 1. Inbox components (per [04-ui](../04-ui.md))

- `notifications-bell.tsx` (button + badge + shell), `notifications-feed.tsx`
  (All/Unread/category filters, rows), `notification-detail.tsx` (body,
  source links, per-channel delivery state, View/Resend/Dismiss),
  `notifications-settings.tsx` (toggles, quiet hours, channel connect
  cards). Each file under ~300 lines.
- API clients in `src/lib/backend/notifications-api.ts` (resend, bindings);
  `useSWR` + `mutate` after writes; `toast` feedback.
- Strings in `messages/en.json` + `messages/hi.json`; `data-testid`s per
  04-ui.

### 2. Test coverage

| Surface | Location | Covers |
|---|---|---|
| frontend | co-located `*.test.tsx` | filter logic, relative time, detail actions call the right clients |
| e2e | notifications journey steps | open bell → filter unread → open detail → mark read → badge clears; connect-card dummy flow; settings toggle persists |

**Deliberately not covered:** visual pixel-parity with Vellum (reviewed by
watching the recording, not asserted).

## Exit criteria

1. `pnpm check-types && pnpm lint && pnpm test` passes.
2. `pnpm check:i18n` passes (every new key in en + hi).
3. `pnpm build && pnpm --dir tests e2e --project <notifications-journey>`
   passes; `e2e:feature` video watched and linked in the progress record.
4. The old popover code is deleted in the same change (no dead bell).

## Risks

- **Scope creep into design-system work.** Mitigation: compose `ui/*`
  primitives only; no new generic components without a second feature that
  needs them.
- **Hindi string quality.** Mitigation: mirror existing tone in
  `messages/hi.json`; flag uncertain strings in the progress record for
  owner review.
