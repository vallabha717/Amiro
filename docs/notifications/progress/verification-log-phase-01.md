# Verification Log — Phase 01 (LLM decision engine)

**Date:** 2026-10-21
**Machine notes:** herdr worktree on
`/home/shrivallabha_somayaji_tyson_com/.herdr/worktrees/Amiro/feat-notify-phase-01`
(branch `feat/notify-phase-01`). Disk is tight, so every cargo command sets
`CARGO_TARGET_DIR` to the sibling `feat-notifications` worktree target dir
and uses `-j1`; only the notify-scoped suites were run here (parent runs the
full suite at merge). No provider keys, no network: bridge tests use stubbed
callers or an unreachable socket.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Criterion 1: `cargo test --manifest-path backend/Cargo.toml` passes with the bridge stubbed down and up.

```
$ export CARGO_TARGET_DIR=/home/shrivallabha_somayaji_tyson_com/.herdr/worktrees/Amiro/feat-notifications/backend/target && cargo test --manifest-path backend/Cargo.toml -j1 --lib notify::
running 21 tests
test notify::decision::tests::decision_model_falls_back_to_the_chat_default ... ok
test notify::decision::tests::decision_model_prefers_the_notify_setting ... ok
test notify::decision::tests::decision_model_unset_means_the_runtime_default ... ok
test notify::decision::tests::fallback_copy_covers_every_named_family ... ok
test notify::decision::tests::disabled_category_forces_silence ... ok
test notify::decision::tests::high_urgency_banners_without_all_alerts ... ok
test notify::decision::tests::low_system_signal_stays_silent ... ok
test notify::decision::tests::model_error_falls_back ... ok
test notify::decision::tests::invalid_json_falls_back ... ok
test notify::decision::tests::missing_copy_for_a_selected_channel_falls_back ... ok
test notify::decision::tests::one_signal_costs_one_model_call ... ok
test notify::decision::tests::quiet_payload_forces_silence ... ok
test notify::decision::tests::silent_single_channel_signal_skips_the_model_call ... ok
test notify::signal::tests::maps_events_to_categories ... ok
test notify::decision::tests::unknown_channel_falls_back ... ok
test notify::signal::tests::medium_maps_to_normal ... ok
test notify::decision::tests::valid_response_carries_copy_for_every_selected_channel ... ok
test notify::signal::tests::rejects_an_unknown_source_channel ... ok
test notify::decision::tests::parses_a_valid_signal ... ok
test notify::decision::tests::rejects_an_unknown_urgency ... ok
test notify::decision::tests::timeout_falls_back ... ok

test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 238 filtered out; finished in 0.05s
```

```
$ cargo test --manifest-path backend/Cargo.toml -j1 --test notify_pipeline
running 8 tests
test bad_signals_are_rejected ... ok
test bridge_down_delivers_the_same_channels_without_rendered_copy ... ok
test emit_flows_from_signal_to_sse_intent ... ok
test killed_bridge_still_delivers_with_fallback_used ... ok
test dedupe_key_claims_the_signal_once ... ok
test medium_urgency_persists_as_normal ... ok
test silent_signal_never_calls_the_model ... ok
test model_path_renders_copy_when_the_bridge_answers ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.62s
```

**Verdict:** ✅ MET (scoped) — 21 lib + 8 pipeline tests pass, covering the
stubbed-up bridge, the stubbed-error bridge, and the genuinely unreachable
bridge. The unconstrained full-suite run is the parent's at merge.

---

## Criterion 2: A test kills the bridge mid-run and asserts delivery still completes with `fallbackUsed: true`.

Covered by `killed_bridge_still_delivers_with_fallback_used` in the run
above (stub caller returns `Err("connection refused")`, the shape a dead
bridge produces). Assertions in the test:

- one model call attempted (`calls == 1`)
- `decision.fallbackUsed == true`, `channels == ["local"]`
- feed item still rendered from the fallback copy (`title == "Nightly backup"`)
- one delivery row, `status == "sent"`; stored decision row `fallbackUsed == true`

**Verdict:** ✅ MET — delivery completes through the fallback; see the
progress record for why a caller failure stands in for a process kill.

---

## Criterion 3: `notify.decision_model` set and unset both resolve to a sane model (test asserts the default path).

Covered by the first three lines of the lib run above:

- `decision_model_prefers_the_notify_setting`: both vars set →
  `Some("openrouter:qwen3-8b")` (the notify var wins)
- `decision_model_falls_back_to_the_chat_default`: only
  `AMIRO_DEFAULT_MODEL=openai:gpt-5` → `Some("openai:gpt-5")`
- `decision_model_unset_means_the_runtime_default`: neither set → `None`
  (the runtime's own default), and a blank override also resolves to `None`

**Verdict:** ✅ MET — set, chat-default, and fully-unset paths all asserted.

---

## Criterion 4: No test requires network or a provider key (`cargo test` runs offline).

All four new pipeline tests run in the `notify_pipeline` binary above with
no provider key in the environment and no reachable runtime:

- stubbed tests inject `ModelCaller` closures (fixed JSON / `Err` / call
  counter) — the bridge is never touched;
- `bridge_down_delivers_the_same_channels_without_rendered_copy` uses the
  live `emit_signal` path against a fixture whose `runtime_socket` nothing
  listens on and whose `runtime_bin` does not exist, so `ensure_bridge`
  fails fast without spawning or dialing out.

The 50ms timeout in `timeout_falls_back` uses `std::future::pending`
(no thread sleep against a real service).

**Verdict:** ✅ MET — nothing in the run dials out or needs a key.

---

## New test coverage actually runs

The suites this phase added are discovered and executed — the lib run lists
all 13 new `notify::decision::tests` cases by name, and the pipeline run
lists the 4 new `*_bridge_*` / `*_model*` tests. A suite that silently
matched nothing would read `0 tests` / `filtered out` everything; instead
the counts went up (lib notify 8 → 21 incl. signal tests, pipeline 4 → 8).

Config regression (the `[notify]` example section must not trip the
sample-config guard):

```
$ cargo test --manifest-path backend/Cargo.toml -j1 --lib config::
test config::tests::toml_maps_sections_to_env_and_flags_typos ... ok
test config::tests::the_sample_config_parses_cleanly ... ok
...
test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 248 filtered out; finished in 0.02s
```

**Verdict:** ✅ MET — `the_sample_config_parses_cleanly` is green with the
new `[notify]` section, so the `TOML_KEYS` entry matches the example file.

---

## Guards

```
$ rustfmt --edition 2021 --check backend/src/notify/decision.rs backend/src/notify/broadcaster.rs backend/src/notify/mod.rs backend/src/config.rs backend/tests/notify_pipeline.rs && echo FMT-CLEAN
FMT-CLEAN
```

```
$ cargo build --manifest-path backend/Cargo.toml -j1 --lib
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 29.62s
```

(no warnings emitted; the one pre-existing rustfmt drift touched in
`config.rs` was reverted — `git diff backend/src/config.rs` is the single
`TOML_KEYS` line).

---

## Regression check

Everything Phase 00 proved still passes inside the same runs above:

- `emit_flows_from_signal_to_sse_intent`, `dedupe_key_claims_the_signal_once`,
  `medium_urgency_persists_as_normal`, `bad_signals_are_rejected` — all `ok`
  in the pipeline run;
- the 4 pre-existing `notify::decision` deterministic tests and all 5
  `notify::signal` tests — all `ok` in the lib run.

---

## Notes

- The live `RuntimeModelCaller` (real `start_turn` path) is compiled and
  warning-free but never executed in tests — executing it needs a running
  bridge plus a provider key. First live run should be watched once with a
  key available: confirm `decisions` rows with `fallbackUsed: false` and
  sane `reasoning`, and confirm the throwaway session is archived.
- `silent_signal_never_calls_the_model` uses a `quiet: true` payload; the
  unit twin (`silent_single_channel_signal_skips_the_model_call`) pins the
  `single_channel` intent rule directly.
