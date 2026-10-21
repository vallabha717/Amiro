# Verification Log — Phase 03 (External adapters)

**Date:** 2026-10-21
**Machine notes:** disk critically tight (finished at 100% / 15M free);
`CARGO_TARGET_DIR` redirected to the sibling worktree's target dir per the
task brief (`.../feat-notifications/backend/target`, `-j 1` everywhere).
`node_modules` absent in this worktree: frontend gates ran via a read-only
symlink to the main checkout's identical install (package.json verified
identical). No live network in tests; no real tokens anywhere.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted.

---

## Criterion 1: `cargo test --manifest-path backend/Cargo.toml` passes with stub HTTP.

```
$ export CARGO_TARGET_DIR=/home/shrivallabha_somayaji_tyson_com/.herdr/worktrees/Amiro/feat-notifications/backend/target
$ cargo test --manifest-path backend/Cargo.toml -j 1 --test notify_channels --test notify_pipeline --test notifications
running 9 tests
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.81s
running 7 tests
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s
running 4 tests
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

$ cargo test --manifest-path backend/Cargo.toml -j 1 --lib notify::
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 239 filtered out; finished in 0.02s

$ cargo test --manifest-path backend/Cargo.toml -j 1 --lib agent_mcp
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 241 filtered out; finished in 0.43s
```

(9 = `notifications` route suite incl. pre-existing; 7 = new `notify_channels`;
4 = `notify_pipeline` Phase 00 regression; 14 = `notify::` lib incl. 4 new
pairing + decision/signal suites; 12 = `agent_mcp` incl. the new
`notify_channel_tools_list_bind_needs_secret_and_unbind`. The lib run shows
`253 tests` total in the binary — 252 filtered out. The full-workspace
`cargo test` was not run: only the new/affected suites, per the disk
constraint.)

**Verdict:** ✅ MET for the affected suites — stub HTTP only, no live network.

---

## Criterion 2: A test asserts a vault-stored token appears in no response, log, or persisted JSON (grep the temp home).

```
$ cargo test --manifest-path backend/Cargo.toml -j 1 --test notify_channels vault_token_appears_nowhere_observable
running 1 test
test vault_token_appears_nowhere_observable ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 6 filtered out; finished in 0.02s
```

The test binds slack with a vault token, then asserts the token string in
no response body, and walks every file under the temp home
(`store/notification-channels.json`, `store/*.json`, `protected/credentials.enc`)
asserting no file contains it. Log lines never interpolate the token:
`notify/adapters/http.rs::short_error` redacts request URLs (which embed the
Telegram token in the path) before they reach any `ApiError` message, and the
Slack/Discord adapters send tokens only as header values that are never
formatted into errors.

**Verdict:** ✅ MET.

---

## Criterion 3: `pnpm check-types && pnpm lint && pnpm test` passes for the connect UI.

```
$ ./node_modules/.bin/tsc --noEmit   # (.bin via read-only symlink; package.json identical)
src/components/file-preview/file-preview.tsx(238,12): error TS2307: Cannot find module 'mammoth/mammoth.browser' ...
src/components/file-preview/file-preview.tsx(239,12): error TS2307: Cannot find module 'dompurify' ...
src/components/file-preview/file-preview.tsx(358,46): error TS2307: Cannot find module 'docx-preview' ...
src/components/file-preview/file-preview.tsx(382,69): error TS2307: Cannot find module '@aiden0z/pptx2-renderer' ...
src/components/file-preview/file-preview.tsx(402,58): error TS2307: Cannot find module '@js-preview/excel' ...
src/lib/file-preview/file-preview.test.ts(1,19): error TS2307: Cannot find module 'jszip' ...
src/lib/file-preview/office.ts(1,19): error TS2307: Cannot find module 'jszip' ...
src/lib/file-preview/office.ts(116,84): error TS18046: 'm' is of type 'unknown'.
```

All 8 errors are in untouched `file-preview` files (missing optional
declarations in the shared install) — zero errors in any Phase 03 file,
including `tests/e2e/specs/13-notifications.spec.ts` (covered by root
tsconfig `include: tests/**/*.ts`).

```
$ ./node_modules/.bin/biome lint src/components/notifications/ src/lib/notifications/ \
    "src/app/(chat)/(admin)/admin/notifications/" tests/e2e/specs/13-notifications.spec.ts tests/e2e/support/config.ts
Checked 13 files in 21ms. No fixes applied.

$ node scripts/check-i18n.mjs
hi.json: 1030 keys match en.json

$ ./node_modules/.bin/vitest run src/components/notifications src/lib/notifications
 Test Files  4 passed (4)
 Tests  39 passed (39)
```

(39 = bell 7 + channels-api 2 + connect-cards 3 + runtime/types 27
pre-existing; the page smoke test's 2 run separately, green.)

```
$ ./node_modules/.bin/vitest run "src/app/(chat)/(admin)/admin/notifications/page.smoke.test.tsx"
 Test Files  1 passed (1)
 Tests  2 passed (2)
```

**Verdict:** ⚠️ PARTIAL — every scoped gate for the touched surface passes;
full-repo `pnpm check-types/lint/test` were not run (no local install; the
`file-preview` errors are pre-existing and unrelated).

---

## Criterion 4: E2E connect flow passes with fixtures; live-send step skips with reason when unconfigured.

Not run. What was proven instead, and the exact blocker:

- Backend failure behavior (the "failed/skipped row recorded, no exception"
  half) is proven by `one_channel_failing_never_blocks_others`
  (local sent + telegram sent + slack failed) and `resend_records_a_new_delivery_row`.
- UI composition (section renders, one card per channel, secret-card token
  entry) is proven by the vitest component + smoke tests above.
- The journey is written, registered (`notifications` project), and
  type-clean; the stub answers the exact provider shapes the adapters parse.

Blocker: with the runtime binary (341M) and backend binary built, the disk
hit 100% (15M free), so `pnpm build` (`out/index.html`, required by
global-setup) could not run and the isolated instance could not boot.
The run command, once ~1G is free:

```
node tests/e2e/fixtures/notify-stub-server.mjs 38971 &
AMIRO_NOTIFY_TELEGRAM_BASE_URL=http://127.0.0.1:38971/tg \
AMIRO_NOTIFY_SLACK_BASE_URL=http://127.0.0.1:38971/slack \
AMIRO_NOTIFY_DISCORD_BASE_URL=http://127.0.0.1:38971/dc \
pnpm --dir tests e2e --project notifications
```

Prereqs: `tests/e2e.config.json` (gitignored) with `target.backendBin` and
`target.runtimeBin` pointing at built binaries and `out/` built via
`pnpm build`; no `notify.liveTelegramToken` needed (live step then skips
with `not configured: notify.liveTelegramToken`).

**Verdict:** ⚠️ PARTIAL — journey ready but unexecuted; failure semantics
covered one layer down.

---

## New test coverage actually runs

```
$ cargo test --manifest-path backend/Cargo.toml -j 1 --test notify_channels
running 7 tests
test bind_validates_input_and_tokens ... ok
test bind_verify_unbind_flow ... ok
test channels_require_auth ... ok
test one_channel_failing_never_blocks_others ... ok
test resend_records_a_new_delivery_row ... ok
test slack_and_discord_bind_verify_and_send ... ok
test vault_token_appears_nowhere_observable ... ok
test result: ok. 7 passed; 0 failed
```

All 7 new integration tests are discovered and executed (no silent match
of nothing). New lib tests: 4 pairing unit + 1 agent-tool test, all listed
green in the Criterion 1 runs.

---

## Guards

The retired `suites/meta` harness has no equivalent to run. Its concerns
are covered directly: every new route is hit by `notify_channels.rs`
(list/bind/unbind/resend); no sleeps or hardcoded waits in backend tests;
no cross-suite imports; the secret-leak guard is
`vault_token_appears_nowhere_observable`; `check:i18n` enforces string
parity.

---

## Regression check

- `notify_pipeline` (4) + `notifications` (9) + `--lib notify::` (14) +
  `--lib agent_mcp` (12): all green after the change (outputs above).
- Frontend `notifications` area vitest: 39/39 green (incl. pre-existing bell
  tests).
- `git status` shows only intended files: 5 modified + 7 new backend files,
  page + 5 new web files, messages ×2, 4 e2e-config files + 2 new e2e files,
  2 progress docs. A repo-wide `rustfmt` drift incident during verification
  was fully reverted (see phase record §2.4).

---

## Notes

- The stub-env race: `notify_channels.rs` tests share process-global env
  vars, so they serialize on a poison-safe static mutex; verified green both
  serially (`--test-threads=1`) and with default parallelism.
- Two genuinely confusing failures while verifying, both fixed in the tests:
  the copied session header carried the wrong bearer token (fixed to the
  fixture's `tok`), and the slack stub compared against the session token
  instead of the slack token (fixed to `GOOD-SLACK-TOKEN`).
- The e2e stub was started detached during verification and stopped
  afterwards; port 38971 confirmed closed. `/tmp` leftovers from failed runs
  removed; pre-existing `/tmp/amiro-*` dirs from other agents untouched.
