# Verification Log — Phase 04 (Bell inbox UI)

**Date:** 2026-10-21
**Machine notes:** worktree on `feat/notify-phase-04`; the sanctioned
`feat-notify-phase-03/node_modules` symlink was missing packages this tree
declares (`jszip`, `dompurify`, …), so a real `pnpm install` (offline store)
replaced it. No provider API key exists in this environment, and none was
asked for — the E2E `provider` dependency (and therefore the `notifications`
project) skips via `need()`.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Criterion 1: `pnpm check-types && pnpm lint && pnpm test` passes.

```
$ pnpm check-types
> tsc --noEmit
(exit 0, no diagnostics)
```

**Verdict:** ✅ MET — full-repo typecheck is clean, including the rewritten
bell, the new feed/detail/settings components, the API client, and both
edited E2E specs (`tests/**/*.ts` are in `tsconfig.json` scope).

```
$ pnpm lint
> biome lint
Checked 783 files in 432ms. No fixes applied.
```

**Verdict:** ✅ MET — whole-repo lint clean.

```
$ ./node_modules/.bin/vitest run   (== `pnpm test`)
 Test Files  88 passed (88)
      Tests  945 passed (945)
   Start at  14:27:35
   Duration  29.10s (transform 6.86s, setup 30ms, collect 34.98s, tests 7.60s, environment 2ms, prepare 12.20s)
```

**Verdict:** ✅ MET — the entire frontend suite passes, including the 18
new/rewritten notifications tests (27/27 in the notifications area).
Note: before the fresh `pnpm install`, 8 unrelated files failed to load
(`jszip` et al. missing from the stale symlink); all pass now, and none of
them was touched by this phase.

Scoped backend check for the new route (full backend suite left to the
merge, per task constraints):

```
$ cargo test --manifest-path backend/Cargo.toml --test notifications
running 10 tests
test deliveries_endpoint_returns_per_channel_rows ... ok
test stream_sends_snapshot_then_live_events ... ok
test settings_disable_forces_silent ... ok
test patch_mark_all_read_and_clear_all ... ok
...
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
```

---

## Criterion 2: `pnpm check:i18n` passes (every new key in en + hi).

```
$ node scripts/check-i18n.mjs
hi.json: 1109 keys match en.json
```

**Verdict:** ✅ MET — every new `Notifications.Bell/.Feed/.Detail/
.Settings/.Categories` key exists in both locales with matching
`{placeholders}`.

---

## Criterion 3: `pnpm build && pnpm --dir tests e2e --project <notifications-journey>` passes; `e2e:feature` video watched and linked in the progress record.

```
$ pnpm build
> next build
▲ Next.js 16.1.6 (Turbopack)
✓ Compiled successfully in 57s
  Running TypeScript ...
  Collecting page data using 3 workers ...
  Generating static pages using 3 workers (41/41) in 1095.1ms
  Finalizing page optimization ...
Route (app) ... (41 static routes, incl. /admin/notifications)
BUILD-EXIT:0
```

**Verdict on the build half:** ✅ — static export completes; `out/index.html`
is fresh (2026-10-21 14:38).

The journey half was **not executed**, so there is no video to watch or
link. The exact command (also in the spec header) is:

```
node tests/e2e/fixtures/notify-stub-server.mjs 38971 &
AMIRO_NOTIFY_TELEGRAM_BASE_URL=http://127.0.0.1:38971/tg \
AMIRO_NOTIFY_SLACK_BASE_URL=http://127.0.0.1:38971/slack \
AMIRO_NOTIFY_DISCORD_BASE_URL=http://127.0.0.1:38971/dc \
pnpm --dir tests e2e --project notifications
```

Blocker, verified by reading (not by burning secrets or binaries): the
`notifications` project declares `dependencies: ["provider"]`, and
`02-provider.spec.ts` starts with `need(provider.apiKey,
"provider.apiKey")` → `base.skip(...)`. With no key in this environment
Playwright runs onboarding, skips provider, and skips every dependent —
including the new bell-inbox test. `need()` is the sanctioned skip
mechanism and no secret may be requested to work around it. The new test
uses only fixtures/dummies (`/api/notifications/test`,
`secret-prompt-input` + `channel-chat-id-*`, API polling) and restores the
sound toggle it flips.

**Verdict:** ⚠️ PARTIAL — journey written, registered, and type-clean, but
unexecuted; closing it needs one keyed run plus the `e2e:feature` video
link in the phase record.

---

## Criterion 4: The old popover code is deleted in the same change (no dead bell).

```
$ grep -rn "notifications-unread-toggle\|notifications-bell-detail\|notification-category-\|notifications-settings-link\|notifications-bell-list\|notifications-bell-button\|data-notification-id" src/ tests/ --include=*.tsx --include=*.ts
(no output)
```

**Verdict:** ✅ MET — zero references to any old-popover testid remain;
the single `notifications-bell.tsx` is the 128-line shell.

---

## New test coverage actually runs

```
$ ./node_modules/.bin/vitest run src/components/notifications src/lib/backend/notifications-api.test.ts
 ✓ src/components/notifications/channel-connect-cards.test.tsx (3 tests)
 ✓ src/components/notifications/notification-detail.test.tsx (4 tests)
 ✓ src/components/notifications/notifications-bell.test.tsx (6 tests)
 ✓ src/components/notifications/notifications-feed.test.tsx (8 tests)
 ✓ src/components/notifications/notifications-settings.test.tsx (1 test)
 ✓ src/lib/backend/notifications-api.test.ts (3 tests)
 Test Files  6 passed (6)
      Tests  27 passed (27)
```

```
$ cargo test --manifest-path backend/Cargo.toml --test notifications deliveries_endpoint
running 1 test
test deliveries_endpoint_returns_per_channel_rows ... ok
test result: ok. 1 passed; 0 failed
```

---

## Guards

- `biome lint` whole-repo clean (see Criterion 1); no new generic `ui/*`
  primitive was added (`git status` shows none under `src/components/ui/`).
- No secret in any fixture: the E2E additions use `need()` +
  dummy values only (`DUMMY_TOKEN`, `e2e-chat-1`); `grep -rn
  "liveTelegramToken" tests/e2e/specs/13-notifications.spec.ts` shows it
  only read from config via `need()`.
- No `page.waitForTimeout`; waits are `expect(...).toBeVisible({timeout})`
  and `expect.poll(..., {timeout})`, matching the existing specs.

---

## Regression check

- Full `vitest run`: 88 files / 945 tests green (above).
- `cargo test --test notifications`: 10/10, including all 9 pre-existing
  tests in the file — the new route registration regressed nothing.
- `10-schedules.spec.ts` bell assertions migrated to the 04-ui testids
  (`notifications-bell`, `notifications-feed`, `notification-detail`);
  typecheck covers the edited specs.

---

## Notes

- Disk pressure from the Phase 03 record is gone on this box (`/dev`
  shows ~44G free at build time); the fresh `pnpm install` and `pnpm
  build` both fit. The `out/` directory is gitignored build output.
- The `e2e:feature` video step is the only remaining gap; everything
  needed to close it (keyed run + link) is documented in §3 and in the
  phase record's follow-ups.
