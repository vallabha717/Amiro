# Phases

> **Plan, not status.** What has actually been built is recorded in
> [`../progress/`](../progress/README.md). Phases 0 and 1 are done; phases
> 2–8 are not started. Where the built thing diverged from the plan below —
> and Phase 1 diverged in seven places, one of them because the plan asked
> for something the Go compiler forbids — the progress folder is the
> authority, not this one.

Nine phases. Each is independently shippable and leaves the repo in a
better state than it found it. Each has explicit entry conditions, a
deliverable list, and exit criteria that are checkable rather than
aspirational.

## Dependency graph

```
Phase 0  serve + embed  ─────────────┐
                                     ├──► Phase 5  UI (Playwright)  ──┐
Phase 1  harness ──┬──────────────── ┤                                │
                   │                 └──► Phase 6  desktop  ──────────┤
                   ├──► Phase 2  backend API ──┐                      │
                   │                           ├──► Phase 7  cross ───┴──► Phase 8  CI
                   └──► Phase 3  providers ────┤
                              │                │
                              └──► Phase 4  TUI
```

Phase 0 and Phase 1 are independent and can be built in parallel. After
Phase 1, phases 2 and 3 unlock the rest. **Both are done**, so every
remaining phase is unblocked in dependency terms; 2 and 3 are the ones that
unlock the breadth.

## The table

| # | Phase | Deliverable | Depends on | Rough size |
|---|---|---|---|---|
| [0](phase-00-serve-and-embed.md) | Serve the dashboard ✅ **done** | `amiro serve --host --port` with the UI embedded in the binary | — | M |
| [1](phase-01-harness-foundation.md) | Harness foundation ✅ **done** | `tests/` module, config, logging, process control, `amirotest` CLI | — | L |
| [2](phase-02-backend-api.md) | Backend API suite ✅ **done** | Every non-LLM route group under test against a real server | 1 | L |
| [3](phase-03-providers-and-agent.md) | Providers + agent loop ← **next** | Cassettes, fake provider, chat/tool/approval/MCP suites | 1, 2 | L |
| [4](phase-04-tui.md) | TUI suite | PTY driver, golden screens, asciinema, launch matrix, `amiro run` | 1, 3 | M |
| [5](phase-05-ui-playwright.md) | UI suite | Playwright with trace + video + HAR into the run directory | 0, 1, 3 | L |
| [6](phase-06-desktop.md) | Desktop suite | Tauri lifecycle, sidecar handoff, orphan kill, packaging | 0, 1 | M |
| [7](phase-07-cross-surface.md) | Cross-surface + resilience | Multi-surface journeys, failure injection, performance budgets | 2–6 | M |
| [8](phase-08-ci.md) | CI and guardrails | Workflows, gates, self-guards, reporting | 7 | M |

Sizes are relative, not calendar estimates: **S** ≈ a focused sitting,
**M** ≈ a few, **L** ≈ a sustained effort with several review points.

## Rules that apply to every phase

1. **A phase is done when its exit criteria are checkable by running
   something**, not when the code exists.
2. **Every phase adds to `suites/meta/`.** If a phase introduces a contract
   (an artifact must exist, a config key must round-trip, a route must be
   covered), it also adds the guard that enforces it. See [07](../07-ci.md).
3. **No phase may make the default run slower than 10 minutes.** If it
   does, the slow additions get tagged `slow` and the phase documents which.
4. **Every phase updates the docs it invalidates.** Particularly
   [02](../02-config.md) and [reference/tests-tree.md](../reference/tests-tree.md).
5. **Nothing regresses `backend-go`'s existing tests.** Phase 0 touches
   product code; every other phase is additive.

## A note on the four pre-existing failures

`docs/notes-backend-testing.md` records four suites failing as of
2026-08-16:

- `internal/auth`: `TestRegister_MakesTheFirstAccountAdminAndEveryLaterOneAPlainUser`
- `internal/httpserver`: `TestAdminRoutes_NonAdminGetsForbidden`,
  `TestRouter_McpDeleteRejectsNonOwnerAndSucceedsForOwner`
- `tests/e2e`: all four `TestSidecar_*`

**Resolved (2026-08-19).** Re-run during Phase 0: all four now pass, with
no change made to fix them, which supports the environment-specific
reading `docs/notes-backend-testing.md` already suspected. That file
records the update. Phase 1's entry condition is met and it is unblocked.

They were not this plan's job to fix, but two of them are directly load
bearing for it: the first-account-becomes-admin rule is what seeding
depends on ([06](../06-fixtures-and-seeding.md)), and the sidecar tests
prove the `PORT=` handoff the whole harness is built on. Triaging them was
Phase 1's entry condition precisely because a harness built on a broken
`PORT=` handoff would produce confusing failures forever.
