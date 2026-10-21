# Phase 05 — Rollout

**Depends on:** 04 · **Blocks:** — · **Size:** S

**Surfaces touched:** backend, web, docs

This phase will remove the deprecated direct-persist path, add contract
guards, run the full verification set, and update every doc the initiative
invalidated.

## What already exists

Everything from Phases 00–04. The old `emit_notification` direct-persist
helper is still called by nothing (Phase 02 switched all emitters); this
phase deletes it.

## Deliverables

### 1. Cleanup + guards

- Delete the deprecated direct-persist path and its tests; compat shims
  (`medium` alias, id generation) stay and stay tested.
- A `meta` guard asserting every `notify/adapters/*.rs` file has a stubbed
  test module (no untested adapter lands later).
- Docs: `docs/SCHEDULES.md` notification section, `README.md` if behavior
  claims changed, this folder's cross-links.

### 2. Test coverage

| Surface | Location | Covers |
|---|---|---|
| backend | `cargo test --manifest-path backend/Cargo.toml` (full) | whole suite green, no skips added |
| frontend | `pnpm check-types && pnpm lint && pnpm test && pnpm check:i18n` | all green |
| e2e | full notifications journey + schedules/chat journeys | no regressions on neighboring journeys |

## Exit criteria

1. Full backend suite green; grep finds no `emit_notification` direct-path
   callers outside compat shims.
2. Full frontend gates green (`check-types`, `lint`, `test`, `check:i18n`).
3. Notifications journey plus the chat and schedules journeys pass;
   feature video watched.
4. `docs/notifications/progress/README.md` status table shows 00–05 shipped
   with records.

## Risks

- **Neighboring journey flakes.** Mitigation: compare against the base
  revision before calling a failure a regression (test-skill flake policy).
