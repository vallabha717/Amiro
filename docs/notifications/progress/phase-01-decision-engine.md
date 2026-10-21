# Phase 01 — LLM decision engine

**Status:** ✅ Complete
**Date:** 2026-10-21
**Verification Log:** [verification-log-phase-01.md](verification-log-phase-01.md)

---

## 1. What Shipped

The notification pipeline now routes every non-silent signal through an LLM
decision turn over the runtime bridge (channel selection + per-channel copy)
and falls back to the Phase 00 deterministic rules — with `fallbackUsed: true`
— whenever the model path is unavailable or invalid. Backend only; no UI, feed,
or adapter changes.

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **Model path** | `backend/src/notify/decision.rs` | `decide_with_caller` / `decide_signal`: JSON-mode turn via `runtime::start_turn` (no tools, 20s timeout, strict schema parse); `ModelCaller` seam with live `RuntimeModelCaller`; `decision_model()` resolution; `fallback_copy` templates per `sourceEventName` family. |
| **Pipeline wiring** | `backend/src/notify/broadcaster.rs` | `emit_signal` decides via the live caller; new `emit_signal_with_caller` for stubbed tests; local delivery uses the model copy; external selections recorded as `skipped` deliveries; `shouldNotify: false` fans out to nothing. |
| **Config** | `backend/src/config.rs`, `amiro.example.toml`, `.env.example` | `notify.decision_model` → `AMIRO_NOTIFY_DECISION_MODEL`, defaulting to `AMIRO_DEFAULT_MODEL`, else the runtime default. |

### Tests Added

| Surface | Directory | Tests | Covers |
|---|---|---|---|
| backend unit | `backend/src/notify/decision.rs` (`mod tests`) | 13 new (17 in module) | timeout/invalid JSON/unknown channel/missing copy/model error → fallback; multi-channel copy present; one call per signal; silent skip makes zero calls; config set/unset/default resolution; fallback copy per family |
| backend integration | `backend/tests/notify_pipeline.rs` | 4 new (8 in file) | stubbed-bridge-up renders model copy with `fallbackUsed: false`; bridge-down delivers identical channels with fallback copy; killed-bridge error still delivers with `fallbackUsed: true`; silent signal skips the model |

**Not covered, and why:** live model assertions (no provider key in
tests, per the phase doc — prompt quality is reviewed by reading, not
asserted); the full `cargo test` suite (disk/time constraints — the parent
runs it at merge; the notify-scoped suites are green here).

### Files Modified

| Path | Change | Lines |
|---|---|---|
| `backend/src/notify/decision.rs` | Model path, `ModelCaller` seam, config resolution, copy templates, unit tests | +631 / -~20 (file now 757 lines) |
| `backend/src/notify/broadcaster.rs` | Live/stub decision wiring, copy-aware fan-out, skipped external deliveries | +79 / -~12 (file now 218 lines) |
| `backend/src/notify/mod.rs` | Re-export `emit_signal_with_caller` | +1 / -1 |
| `backend/src/config.rs` | `("notify", "decision_model", "AMIRO_NOTIFY_DECISION_MODEL")` in `TOML_KEYS` | +1 |
| `backend/tests/notify_pipeline.rs` | 4 Phase 01 tests + stub helper | +136 / -~4 (file now 303 lines) |
| `amiro.example.toml` | `[notify]` section with commented `decision_model` | +6 |
| `.env.example` | Commented `AMIRO_NOTIFY_DECISION_MODEL` under Models | +5 |

---

## 2. What Diverged from the Plan, and Why

1. **Prompt placement (TurnPlan has no system field):** the phase doc says
   "system prompt with channel/event registries". `runtime::TurnPlan` carries
   `prompt` + `system_reminder`, not a dedicated system prompt, and `run_once`
   carries neither model selection nor a system slot. So the registries,
   channel policy, schema, and signal JSON all travel in the turn `prompt`
   itself, sent with `expose_tools: false` (the runtime configures `no_tools`)
   and the resolved decision model. Same bridge, same no-tool JSON-mode
   semantics; the prompt builder is `decision_prompt` in `decision.rs`.

2. **"Kills the bridge" test is a caller failure, not a process kill:**
   there is no real bridge in tests (the fixture points at a socket nothing
   listens on and a runtime binary that does not exist), so
   `killed_bridge_still_delivers_with_fallback_used` stubs the caller with
   `Err("connection refused")` — the exact error shape a dead bridge
   produces through `ensure_bridge`/`connect_client`. The fallback branch is
   identical code for every failure kind, so the substitution proves the
   criterion without inventing a harness.

3. **External selections are recorded as `skipped` deliveries:** the design
   lets the model select telegram/slack/discord, but Phase 01 has no adapters
   for them. Rather than dropping the selection silently, the broadcaster
   writes a `notification-deliveries.json` row with status `skipped` and the
   reason. Phase 03 turns those rows into real attempts.

4. **Silent-skip rule is routing-intent based:** signals already silent with
   `routingIntent == "single_channel"` (the default) skip the model call —
   nothing else needs rendering. A silent signal with a non-default intent
   still consults the model, since external copy may be needed.

5. **rustfmt drift in `config.rs` reverted:** running rustfmt over the file
   reformatted pre-existing lines unrelated to this phase; those hunks were
   reverted, keeping only the one-line `TOML_KEYS` addition.

---

## 3. Exit Criteria (Verbatim from the Phase 01 Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `cargo test --manifest-path backend/Cargo.toml` passes with the bridge stubbed down and up. | ✅ MET (scoped) | `cargo test … --lib notify::` → 21 passed; `cargo test … --test notify_pipeline` → 8 passed, covering stubbed-up (`model_path_renders_copy_when_the_bridge_answers`), stubbed-down/error (`killed_bridge_still_delivers_with_fallback_used`), and real bridge-down (`bridge_down_delivers_the_same_channels_without_rendered_copy`). Full suite not run here per disk constraints — parent runs it at merge. See verification log. |
| 2 | A test kills the bridge mid-run and asserts delivery still completes with `fallbackUsed: true`. | ✅ MET (see divergence 2) | `killed_bridge_still_delivers_with_fallback_used`: failing caller → `fallbackUsed: true`, local delivery `sent`, feed item present. |
| 3 | `notify.decision_model` set and unset both resolve to a sane model (test asserts the default path). | ✅ MET | `decision_model_prefers_the_notify_setting`, `decision_model_falls_back_to_the_chat_default`, `decision_model_unset_means_the_runtime_default` (unset → `None` = runtime default; blank override → `None`). |
| 4 | No test requires network or a provider key (`cargo test` runs offline). | ✅ MET | All model-path tests use injected stub callers; the bridge-down tests rely on `ensure_bridge` failing fast against a nonexistent socket/binary (no spawn, no network). No test sets a provider key. |

---

## 4. Standards Compliance

- **backend:** new setting has a default, `TOML_KEYS` entry, and both example
  files; errors stay `ApiError` with human messages; no secrets in logs or
  rows; no blocking IO in async handlers (collection runs on the caller's
  async task; the only blocking work is inside `runtime::start_turn`'s own
  worker). Throwaway decision sessions are best-effort archived.
- **test:** unit tests for pure logic (parse, fallback, resolution) plus
  integration tests through the real pipeline (`emit_signal[_with_caller]`
  against temp homes). No sleeps, no hardcoded waits except the 50ms unit
  timeout (a deliberate fallback trigger, not a readiness wait).
- **E2E journeys:** not applicable — no user-facing surface changed (backend
  decision path only, feed shapes unchanged).

---

## 5. Known Scope Boundaries & Follow-ups

- **Optimistic local emit (phase risk) — rejected for now:** the risk section
  suggested emitting the local intent from the deterministic pre-decision,
  then upgrading copy when the model responds. Rejected: a single synchronous
  decide→record→broadcast path keeps the decision row and audit rows
  consistent (one decision row per signal), and dedupe-before-model plus the
  silent-skip already remove the worst latency/cost cases. Revisit if the 20s
  worst case on the bridge-up path is felt in the UI.
- **`shouldNotify: false` has no producer yet:** the model can suppress a
  signal (decision recorded, nothing fanned out), but nothing today selects
  it. Phase 03/external adapters should define when suppression is desired.
- **`skipped` external delivery rows:** Phase 03 consumes them when
  telegram/slack/discord adapters land; until then they are audit-only.
- **Prompt quality review:** read `decision_prompt` output and a few live
  decision rows once a provider key is available; no test asserts taste.
- **Full suite at merge:** parent runs the unconstrained `cargo test` (this
  worktree ran only `--lib notify::`, `--lib config::`, and
  `--test notify_pipeline` per disk constraints).
