# Verification Log — Phase 00 (Pipeline core)

**Date:** 2026-10-21
**Machine notes:** shared 96G box; mid-run disk-full (100%) broke two link
steps with `ld signal 7 Bus error`; recovered via `cargo clean`; final runs
below are post-clean with `-j 1`.

Real commands and their real output. Nothing here is paraphrased,
reconstructed, or predicted; if it is in this file, it was run.

---

## Criterion 1: `cargo test --manifest-path backend/Cargo.toml` passes, including the new `notify_pipeline` suite.

```
$ cargo test --manifest-path backend/Cargo.toml -j 1 2>&1 | grep -E "^(test result|error(\[|:)|failures:)"
test result: ok. 246 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 7.27s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s
test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.17s
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 21.12s
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 26.03s
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
EXIT:0
```

(The `4 passed` line at 0.03s is `notify_pipeline`; the 246-line lib run
includes the 9 `notify::` unit tests and the `notify_send` tool test. The
`15 passed` line is the untouched `notifications.rs` suite.)

**Verdict:** ✅ MET — every target ok, zero failures.

---

## Criterion 2: A test asserts two emits with the same `dedupeKey` produce one delivery row and return the stored decision.

```
$ cargo test --manifest-path backend/Cargo.toml --test notify_pipeline 2>&1 | tail -n 8
running 4 tests
test bad_signals_are_rejected ... ok
test medium_urgency_persists_as_normal ... ok
test dedupe_key_claims_the_signal_once ... ok
test emit_flows_from_signal_to_sse_intent ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
```

**Verdict:** ✅ MET — `dedupe_key_claims_the_signal_once` asserts 1 event /
1 decision / 1 delivery row and `duplicate: true` with the stored decision
on replay.

---

## Criterion 3: A test asserts `urgency: "medium"` persists as `"normal"`.

Covered by the same run above (`medium_urgency_persists_as_normal` ok) plus:

```
$ cargo test --manifest-path backend/Cargo.toml --lib agent_mcp::tests::notify_send 2>&1 | tail -n 3
test agent_mcp::tests::notify_send_emits_through_the_pipeline ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

**Verdict:** ✅ MET — both the pipeline test and the tool test assert
persisted `normal`.

---

## Criterion 4: Existing `backend/tests/notifications.rs` passes unmodified.

Covered by the Criterion 1 run (`15 passed` target, file untouched —
`git status` shows no modification to it).

**Verdict:** ✅ MET.

---

## New test coverage actually runs

14 new tests, all discovered and executed (9 `notify::` lib + 4
`notify_pipeline` + 1 `agent_mcp` tool test). Proof: the suite totals went
up and each new address appears by name in the runs above
(`dedupe_key_claims_the_signal_once`,
`notify_send_emits_through_the_pipeline`, …).

## Guards

No `suites/meta` exists in this repo revision (retired with the Go
harness). The contract this phase introduces (one delivery row per signal)
is enforced by the dedupe test assertion, not a separate guard.

## Regression check

Full backend suite green per Criterion 1 (lib 246 + all integration
targets, 0 failed). Backend-adjacent gates (`pnpm check-types`, E2E) are
not applicable: the phase touches no TypeScript.

---

## Notes

- Two pipeline tests failed on first run for test-harness reasons, fixed
  in the test file: `rows()` now tolerates a never-written store file, and
  the SSE assertion filters the process-wide broadcast by `deliveryId`
  instead of assuming the next event is its own.
- `cargo test -j 1` and per-target runs are the working invocation on this
  box; default parallelism links OOM at 100% disk.
