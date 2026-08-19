# Amiro Testing Plan

The plan for building one test system that covers all four surfaces Amiro
ships: the **Go backend**, the **`amiro` TUI**, the **web dashboard UI**,
and the **Tauri desktop app** — with real values, real processes, real
recordings, and a single run-scoped `logs/` tree you can trace a failure
through.

## Read in this order

| # | Document | What it settles |
|---|---|---|
| 00 | [Overview](00-overview.md) | Goals, the four surfaces, scope, principles, non-goals |
| 01 | [Architecture](01-architecture.md) | The `tests/` tree, the Go harness, module layout, run lifecycle |
| 02 | [Config](02-config.md) | `config.yaml` schema, every default, precedence order |
| 03 | [Selection](03-selection.md) | Run all / one surface / one feature / one test |
| 04 | [Artifacts & Logs](04-artifacts-and-logs.md) | `logs/<run-id>/` layout, traces, video, casts, HAR |
| 05 | [Recording & Replay](05-recording-and-replay.md) | Cassettes, live mode, the fake provider, redaction |
| 06 | [Fixtures & Seeding](06-fixtures-and-seeding.md) | Deterministic DB seeds, workspaces, MCP fixture server |
| 07 | [CI & Guardrails](07-ci.md) | Gates, matrices, flake policy, cost control |
| — | [**Progress**](progress/README.md) | What is actually built, phase by phase |

## Progress

**[`progress/`](progress/README.md) is the record of what has actually been
built.** This folder and `phases/` describe intent; `progress/` describes
reality, and they are deliberately kept apart so a confidently-written plan
is never mistaken for a status report.

| Phase | Status |
|---|---|
| [0 — Serve the dashboard](progress/phase-00-serve-and-embed.md) | ✅ Done, 2026-08-19 |
| [1 — Harness foundation](progress/phase-01-harness-foundation.md) | ✅ Done, 2026-08-19 |
| 2–8 | Not started (Phase 2 is unblocked) |

The test system is real and runs today:

```bash
cd tests && go run ./cmd/amirotest run
```

15 tests, green, in about three seconds, with no `config.yaml` and no API
keys — which is the central design rule rather than a courtesy. See
[`tests/README.md`](../../tests/README.md) for how to use it.

## Phases

The build order lives in [`phases/`](phases/README.md). Nine phases,
each with its own file, its own exit criteria, and an explicit dependency
on the ones before it.

| Phase | Title | Blocks |
|---|---|---|
| [0](phases/phase-00-serve-and-embed.md) | Serve the dashboard (`amiro serve`) ✅ **done** | 5, 6, 7 |
| [1](phases/phase-01-harness-foundation.md) | Harness foundation + `amirotest` CLI | everything |
| [2](phases/phase-02-backend-api.md) | Backend API suite (non-LLM routes) | 3, 7 |
| [3](phases/phase-03-providers-and-agent.md) | Providers, cassettes, agent-loop suite | 4, 5, 7 |
| [4](phases/phase-04-tui.md) | TUI suite (PTY, golden screens, casts) | 7 |
| [5](phases/phase-05-ui-playwright.md) | UI suite (Playwright, trace + video) | 7 |
| [6](phases/phase-06-desktop.md) | Desktop suite (Tauri lifecycle) | 7 |
| [7](phases/phase-07-cross-surface.md) | Cross-surface, resilience, performance | 8 |
| [8](phases/phase-08-ci.md) | CI, guardrails, reporting | — |

## Reference

- [Target `tests/` tree](reference/tests-tree.md) — the full directory listing
- [`config.example.yaml`](reference/config.example.yaml) — annotated, every key

## Decisions already made

These were settled before the plan was written; they are not open questions.

1. **Provider traffic is hybrid** — record once against real APIs, replay by
   default. `--live` re-records. See [05](05-recording-and-replay.md).
2. **`amiro serve` gets built first** — the dashboard-on-`0.0.0.0` command is
   Phase 0, because real UI E2E has nothing to point at without it.
   *Shipped 2026-08-19; see the phase's Outcome section for the two places
   the implementation diverged from the plan.*
3. **`tests/` is a root-level tree**, its own Go module plus its own npm
   package. `backend-go/tests/` stays where it is for in-module suites.
4. **A Go harness owns orchestration**; Playwright owns the browser and
   reads the same `config.yaml` and writes into the same run directory.
5. **Every level of granularity is runnable** — all surfaces, one surface,
   one feature, one test. See [03](03-selection.md).
6. **Everything in `config.yaml` is optional.** Anything unset falls back to
   a documented default, and a missing file is a valid run.
