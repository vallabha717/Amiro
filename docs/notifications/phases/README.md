# Phases

Dependency graph (arrows mean "blocks"):

```
00 pipeline core ──┬──▶ 01 LLM decision ──┐
                   ├──▶ 02 local delivery ─┼──▶ 04 bell UI ──▶ 05 rollout
                   └──▶ 03 ext adapters ───┘
```

01, 02, 03 are independent of each other once 00 lands and can proceed in
parallel worktrees. 04 needs 02 (delivery states it renders) and 03
(channel bindings it manages). 05 closes the rollout.

| Phase | Title | Size | Rule note |
|---|---|---|---|
| 00 | [Pipeline core](phase-00-pipeline-core.md) | M | ✅ Done 2026-10-21 |
| 01 | [LLM decision engine](phase-01-decision-engine.md) | L | Review point: prompt + schema |
| 02 | [Local delivery](phase-02-local-delivery.md) | M | Emitters switch to signals |
| 03 | [External adapters](phase-03-external-adapters.md) | L | Review point: token flow |
| 04 | [Bell inbox UI](phase-04-bell-ui.md) | L | Review point: visual pass |
| 05 | [Rollout](phase-05-rollout.md) | S | ✅ Done 2026-10-21 |

## Rules for every phase

1. Done means exit criteria pass by running the listed commands, not that
   code exists.
2. Each phase ships its own tests on every surface it touches: backend
   integration (`backend/tests/*.rs`), frontend unit (`*.test.ts(x)`), and
   Playwright journey steps for anything user-visible.
3. Additive by default; a phase touching existing product code says so up
   front and keeps existing tests green.
4. Secrets stay in the vault; nothing sensitive in logs, responses, or
   fixtures.
5. Every phase updates the docs it invalidates and names them.
6. Strings go to `messages/en.json` and `messages/hi.json` together.
