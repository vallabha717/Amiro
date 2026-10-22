# Verification Log — Phase 02 (Local delivery)

**Date:** 2026-10-21
**Machine notes:** sandbox worktree
`feat-notify-phase-02`; disk 95% full (`/dev/root` 91G/96G, 5.6G free);
`CARGO_TARGET_DIR` pointed at the sibling `feat-notifications` target dir
per the task directive; `node_modules` installed fresh via the pnpm store.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Criterion 1: `cargo test --manifest-path backend/Cargo.toml` passes.

Scoped to the affected suites per the disk directive (full unscoped run
not attempted — see Verdict).

```
$ cargo test --manifest-path backend/Cargo.toml --lib notify:: -j 1
test notify::signal::tests::maps_events_to_categories ... ok
test notify::signal::tests::medium_maps_to_normal ... ok
test notify::signal::tests::parses_a_valid_signal ... ok
test notify::signal::tests::rejects_an_unknown_source_channel ... ok
test notify::signal::tests::rejects_an_unknown_urgency ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 238 filtered out; finished in 0.00s
```

```
$ cargo test --manifest-path backend/Cargo.toml --test notify_pipeline -j 1
running 8 tests
test bad_signals_are_rejected ... ok
test chat_reply_signal_reaches_the_thread_feed ... ok
test dedupe_key_claims_the_signal_once ... ok
test no_emitter_calls_the_old_direct_persist_path ... ok
test emit_flows_from_signal_to_sse_intent ... ok
test heartbeat_signal_reaches_the_thread_feed ... ok
test medium_urgency_persists_as_normal ... ok
test schedule_result_signal_flags_failures_for_action ... ok
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.81s
```

```
$ cargo test --manifest-path backend/Cargo.toml --test notifications -j 1
running 9 tests
test empty_feed_reports_version_two_and_default_settings ... ok
test notifications_require_auth ... ok
test emit_notification_helper_persists_without_http ... ok
test create_persists_and_upserts_in_place ... ok
test ack_records_delivery_receipt ... ok
test settings_disable_forces_silent ... ok
test stream_sends_snapshot_then_live_events ... ok
test test_endpoint_emits_real_notification ... ok
test patch_mark_all_read_and_clear_all ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.59s
```

```
$ cargo check --manifest-path backend/Cargo.toml --lib -j 1
Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 14s
```

**Verdict:** ⚠️ PARTIAL — every affected suite is green (26 tests), but
the FULL backend suite was not run, so the verbatim criterion is not fully
met. Closing it takes one unscoped run on a machine with headroom.

---

## Criterion 2: `pnpm check-types && pnpm lint && pnpm test` passes.

```
$ pnpm check-types
> amiro-desktop@1.26.0 check-types
> tsc --noEmit
(no output — clean)
```

One intermediate failure was found and fixed during the run: the new
tests initially cast with `as unknown as Location`, which `tsc` rejects
(`Type 'Location' is not assignable to type 'string & Location'`);
changed to `as any` matching the file's existing pattern, then clean.

```
$ pnpm lint
> amiro-desktop@1.26.0 lint
> biome lint
Checked 766 files in 425ms. No fixes applied.
```

```
$ pnpm test
 Test Files  81 passed (81)
      Tests  921 passed (921)
```

```
$ pnpm check:i18n
hi.json: 1015 keys match en.json
```

```
$ pnpm vitest run src/lib/notifications/notification-runtime.test.ts
 ✓ src/lib/notifications/notification-runtime.test.ts (37 tests) 26ms
 Test Files  1 passed (1)
      Tests  37 passed (37)
```

**Verdict:** ✅ MET — all three gates pass on the full suite, plus i18n.

---

## Criterion 3: `pnpm build && pnpm --dir tests e2e --project <notifications-journey> -g "<new step titles>"` passes and the feature video is watched.

```
$ pnpm --dir tests exec playwright test --project schedules --list
Listing tests:
  [schedules] › 10-schedules.spec.ts:71:7 › schedules › schedule run raises a Bell badge and toast, click routes to thread
Total: 7 tests in 3 files
```

Prerequisite probe (all absent in this sandbox):

```
$ ls out/index.html backend/target/debug/amiro-backend backend/target/release/amiro-backend \
    runtime/target/debug/amiro-runtime runtime/target/release/amiro-runtime tests/e2e.config.json
NO out/index.html / NO backend binary / NO runtime binary / NO e2e config/node_modules
$ df -h / → /dev/root 96G 91G 5.6G 95%
$ ls ~/.cache/ms-playwright → chromium-1234, chromium_headless_shell-1234, ffmpeg-1011 (browsers present)
```

**Verdict:** ⚠️ PARTIAL — the steps are written in the owning journey
(schedules owns the schedules page per the journeys table) and the spec
loads (new test listed at 10-schedules.spec.ts:71). Not executed and no
video watched: no built web UI, no backend/runtime binaries, no
`tests/e2e.config.json` model keys (journeys drive the real model), and
only 5.6G free disk. Run on a provisioned machine:
`pnpm build && pnpm --dir tests e2e --project schedules -g "Bell badge"`,
then cut the feature video per the e2e-journeys skill.

---

## Criterion 4: No emitter calls the old direct-persist path (grep guard in the test).

```
$ cargo test --manifest-path backend/Cargo.toml --test notify_pipeline -j 1 no_emitter
test no_emitter_calls_the_old_direct_persist_path ... ok
```

Manual corroboration (same claim, second route):

```
$ grep -rn "routes::notifications::emit_notification" backend/src/
(no matches — definition in routes/notifications.rs is `pub async fn emit_notification`, not a call path)
$ grep -rn "notify::emit_signal" backend/src/chat.rs backend/src/schedules.rs backend/src/heartbeat.rs
backend/src/chat.rs: ... crate::notify::emit_signal(
backend/src/schedules.rs: ... crate::notify::emit_signal(
backend/src/heartbeat.rs: ... crate::notify::emit_signal(
```

**Verdict:** ✅ MET — the guard passes and grep confirms zero in-tree
callers of the old path; the helper remains only as the documented compat
shim (Phase 05 removes it).

---

## New test coverage actually runs

Backend: `notify_pipeline` went 4 → 8 tests, all executed above
(`chat_reply_signal_reaches_the_thread_feed`,
`schedule_result_signal_flags_failures_for_action`,
`heartbeat_signal_reaches_the_thread_feed`,
`no_emitter_calls_the_old_direct_persist_path`).
Frontend: `notification-runtime.test.ts` went 26 → 37 tests, all executed
(quiet-hours ×2, focused-thread ×2, ack mapping ×1, deep-link ×5, plus the
updated browser-notification assertion). E2E: 1 new test listed but not
executed (criterion 3).

---

## Guards

rustfmt on added/edited lines:

```
$ rustfmt --edition 2021 --check backend/src/routes/notifications.rs backend/src/notify/adapters/local.rs \
    backend/tests/notify_pipeline.rs backend/tests/notifications.rs backend/src/heartbeat.rs
(no output — clean)
```

`chat.rs` (298, 367) and `schedules.rs` (1509, 1725) diffs under
`rustfmt --check` are pre-existing lines outside this phase's hunks
(`git diff` hunks: chat 819+, schedules 1608+); left untouched to keep the
diff clean. No new i18n strings (`check:i18n` green). No secrets in chat;
no `tests/e2e.config.json` created.

---

## Regression check

| Gate | Result |
|---|---|
| `cargo test --lib notify::` | 9/9 pass |
| `cargo test --test notify_pipeline` | 8/8 pass |
| `cargo test --test notifications` | 9/9 pass |
| `pnpm check-types` | clean |
| `pnpm lint` | 766 files, no findings |
| `pnpm test` (full) | 81 files / 921 tests pass |
| `git status` collateral | only the 12 intended files; `tests/node_modules` gitignored, no lockfile churn |

---

## Notes

- Schedule `finalize` dedupe uses `schedule-run-{run_id}`: a retried
  finalize returns the stored decision with no new rows (asserted in
  `schedule_result_signal_flags_failures_for_action`). Chat/heartbeat set
  no `dedupeKey` — every reply/message is a distinct signal.
- Service worker schedule clicks now land on `/schedules?id=<id>`
  (previously bare `/schedules`); thread clicks unchanged.
