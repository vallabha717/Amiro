# Phase 04 — Bell inbox UI

**Status:** ⚠️ Complete with gaps (3/4 criteria MET)
**Date:** 2026-10-21
**Verification Log:** [verification-log-phase-04.md](verification-log-phase-04.md)

---

## 1. What Shipped

The monolithic bell popover is now a Vellum-style inbox: a thin bell shell
(button + badge + popover) hosting a filterable feed (All / Unread / per
category), a detail view with per-channel delivery state and View / Resend /
Dismiss actions, and an in-popover settings view with toggles, quiet hours,
and the Phase 03 channel connect cards reused as-is. The old popover code is
gone in the same change — there is exactly one bell. Strings are in English
and Hindi; light and dark use theme tokens only.

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **Bell shell** | `src/components/notifications/notifications-bell.tsx` (128) | Button + unread badge + popover shell; feed/detail/settings view switch; mark-all-read, clear-all, permission banner, desktop pill. |
| **Feed** | `src/components/notifications/notifications-feed.tsx` (175) | All/Unread/category filter tabs, unread-first newest-first rows, relative time, urgency marker (icon + text), explicit loading/error/empty states. |
| **Feed helpers** | `src/components/notifications/feed-helpers.ts` (78) | `FeedFilter`, `filterNotifications`, `describeRelativeTime` / `formatRelativeTime`. |
| **Presenters** | `src/components/notifications/notification-presenters.tsx` (105) | `CategoryIcon`, `categoryBadgeClass`, `UrgencyMarker`, `channelLabel`, `DeliveryStatusBadge`. |
| **Detail** | `src/components/notifications/notification-detail.tsx` (288) | Full body, source links, per-channel delivery state with sent/failed/skipped badges, View / mark read-unread / Dismiss, resend per failed or skipped external channel. |
| **Settings** | `src/components/notifications/notifications-settings.tsx` (200) | Toggles, quiet hours, and the Phase 03 `ChannelConnectCards` reused (not rebuilt). |
| **API client** | `src/lib/backend/notifications-api.ts` (76) | `fetchNotificationDeliveries`, `resendNotificationDelivery`; re-exports the Phase 03 binding clients from one surface. |
| **Deliveries endpoint** | `backend/src/routes/notifications.rs` (+61) | `GET /api/notifications/{id}/deliveries`: rows for the item's delivery id plus resend rows under the same signal; 404 on unknown id; metadata only, never a token. |
| **Strings** | `messages/en.json` + `messages/hi.json` (+89/+89) | New `Notifications.Bell/.Feed/.Detail/.Settings/.Categories` sections, key-identical with matching `{placeholders}`. |
| **E2E journey** | `tests/e2e/specs/13-notifications.spec.ts` (+81) | New bell-inbox test: seed → open → filter unread → detail with deliveries → mark read → mark-all clears badge → sound toggle persists via API; plus the `10-schedules.spec.ts` bell-testid migration (+8/-8). |

### Tests Added

| Surface | Location | Tests | Covers |
|---|---|---|---|
| web | `notifications-feed.test.tsx` (193) | 8 | filter logic (dismissed excluded, unread-first ordering, unread/category filters), relative-time buckets + invalid input, render: filters/rows/quick actions/urgency marker, empty/loading/error states |
| web | `notification-detail.test.tsx` (134) | 4 | detail shell + actions, per-channel rows with resend only for failed externals, loading/error/empty delivery states, no view action without a source |
| web | `notifications-bell.test.tsx` (177) | 6 | shell testids, filters + header actions + settings entry, empty state, permission banner, desktop pill, badge hidden when all read |
| web | `notifications-settings.test.tsx` (76) | 1 | toggles + quiet-hours switch + one connect card per channel (reuse, not rebuild) |
| web | `src/lib/backend/notifications-api.test.ts` (82) | 3 | deliveries URL + normalization, resend URL/method/body, binding re-exports |
| backend | `backend/tests/notifications.rs` (+79) | 1 | `deliveries_endpoint_returns_per_channel_rows`: 404/401, row merge across resend signal, no cross-item or cross-user leak |
| e2e | `13-notifications.spec.ts` | 1 | bell inbox journey (written, not executed — see §3.3) |

**Not covered, and why:** visual pixel-parity with Vellum (reviewed by
watching the recording per the phase doc, not asserted); live delivery to a
real provider (no bot tokens in CI — same standing exclusion as Phase 03).

### Files Modified

| Path | Change | Lines |
|---|---|---|
| `backend/src/routes/notifications.rs` | `notification_deliveries` handler + route registration | +61 / -0 |
| `backend/tests/notifications.rs` | deliveries endpoint test | +79 / -0 |
| `messages/en.json`, `messages/hi.json` | Bell/Feed/Detail/Settings/Categories sections | +89 / -0 each |
| `src/components/notifications/notifications-bell.tsx` | rewritten: shell only (was the 532-line popover) | +128 / −532 |
| `src/components/notifications/notifications-bell.test.tsx` | rewritten for the new shell + testids | +177 / −114 |
| `tests/e2e/specs/10-schedules.spec.ts` | bell testids migrated to the 04-ui set | +4 / −4 |
| `tests/e2e/specs/13-notifications.spec.ts` | bell inbox journey test | +81 / -0 |

---

## 2. What Diverged from the Plan, and Why

1. **No deliveries API existed to read.** The phase doc says delivery
   states "come from Phases 02-03 APIs", but Phases 02-03 only *wrote*
   per-channel rows to `notification-deliveries.json` (for the resend
   handler and agent tools) — no route exposed them per notification.
   Added the minimal additive read route `GET
   /api/notifications/{id}/deliveries` (same auth, store lock, and
   metadata-only discipline as its neighbours) plus a backend integration
   test, instead of leaving the detail view's delivery section without a
   source. No existing route or shape changed.

2. **Shared helpers live in two small modules, not inside the four files.**
   Keeping `CategoryIcon`/`DeliveryStatusBadge` and the pure filter/time
   helpers inside the components pushed `notifications-feed.tsx` to 368
   lines; extracting `feed-helpers.ts` (78) and
   `notification-presenters.tsx` (105) keeps every file under ~300 lines
   per 04-ui.md while staying inside `components/notifications/`.

3. **Category names are translated.** The old badge used the English-only
   `categoryLabel()` helper; the new feed/filter tabs read
   `Notifications.Categories.*` so Hindi UI has no English pills. The
   helper itself is untouched (other surfaces still use it).

4. **Real `pnpm install` instead of the phase-03 symlink.** The sanctioned
   symlink target is missing packages this tree declares (`jszip`,
   `dompurify`, `mammoth`, `docx-preview`, …), which failed typecheck,
   unit tests, and would have failed `pnpm build`. Installed fresh in this
   worktree (offline store, ~seconds); the phase-03 tree was not modified.
   This also fixed 8 pre-existing failures/errors outside the
   notifications area (all missing-dependency load errors).

5. **Resend rows are merged by signal, not just by delivery id.** Resends
   mint a new delivery id under the original signal id, so the endpoint
   collects rows by both — the detail view shows the retry history, not
   just the first broadcast.

---

## 3. Exit Criteria (Verbatim from the Phase 04 Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `pnpm check-types && pnpm lint && pnpm test` passes. | ✅ MET | `tsc --noEmit` exit 0; `biome lint` 783 files clean; full `vitest run` 88 files / 945 tests green — see verification log. |
| 2 | `pnpm check:i18n` passes (every new key in en + hi). | ✅ MET | `node scripts/check-i18n.mjs` → `hi.json: 1109 keys match en.json`. |
| 3 | `pnpm build && pnpm --dir tests e2e --project <notifications-journey>` passes; `e2e:feature` video watched and linked in the progress record. | ⚠️ PARTIAL | `pnpm build` passes (static export complete). The journey is written and type-clean but not executed: this environment holds no provider API key, so the `provider` dependency (and therefore the `notifications` project) skips via `need()` — and secrets must never be requested or configured to work around that. No video exists to watch or link. Exact run command is in the spec header and the verification log. |
| 4 | The old popover code is deleted in the same change (no dead bell). | ✅ MET | The 532-line popover is replaced by the 128-line shell; repo-wide grep for every old testid (`notifications-unread-toggle`, `notifications-bell-detail`, `notification-category-*`, `notifications-settings-link`, `notifications-bell-list`, `notifications-bell-button`, `data-notification-id`) returns zero hits. |

---

## 4. Standards Compliance

- **`ui`:** pages untouched (bell lives in the header); logic in
  `components/notifications/`; API calls only in
  `src/lib/backend/notifications-api.ts` (via `apiJson`) and the existing
  `lib/notifications/` clients; strings in en+hi with identical keys and
  `{placeholders}`; theme tokens only; `ui/*` primitives composed
  (no new generic primitive); lucide icons; sonner toasts on every write;
  icon-only buttons have `aria-label`, feed is a `ul`, detail heading is
  an `h2`, rows are keyboard-reachable buttons; `data-testid`s per 04-ui.md.
- **`backend`:** route added with `AuthUser`, store-locked JSON reads,
  `ApiError` statuses, no request-data `unwrap`, metadata-only response —
  same shape as the neighbouring handlers. Scoped `cargo test --test
  notifications` 10/10; full backend suite not run (parent covers backend
  at merge, per task constraints).
- **`test`:** unit tests ship with the code on every touched surface;
  backend integration test for the new route; E2E step written per the
  user-visible rule but unexecuted (see §3.3). No sleeps, no hardcoded
  waits (`expect.poll` with timeouts), no cross-suite imports, no secret
  in any fixture (`need()` skips with reason).

---

## 5. Known Scope Boundaries & Follow-ups

- **Hindi strings need an owner review.** The new `Notifications.*`
  Hindi strings mirror the tone of the existing `Channels` section, but
  several are fresh translations (flag candidates: `Feed.minutesAgo`
  `{n} मि॰ पहले`, `Detail.resendChannel`, `Settings.*Description`,
  `Categories.*`). Listed for the owner before ship.
- **E2E still needs a keyed run.** With a provider key configured,
  run the spec-header command and attach the `e2e:feature` video link
  here. Nothing in the journey needs editing first.
- **Feed does not yet surface `deliveryReceipt` per row.** The receipt
  badge (web/desktop/toast class) shows in the detail header only; row
  space was kept quiet per the Vellum pattern. One-line addition if the
  owner wants it.
- **Admin notifications page keeps its own settings copy.** The bell
  settings view and `/admin/notifications` share `ChannelConnectCards`
  and the same settings endpoint, but the toggle rows are duplicated
  markup, not a shared component. Unify only when a third surface needs
  them (per the no-generic-primitive rule).
