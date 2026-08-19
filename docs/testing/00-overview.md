# 00 — Overview

## Why this exists

Most of Amiro is written by AI agents. Agents are good at producing code
that compiles and bad at knowing whether the thing still works when you
click it. The defence against that is not more unit tests — the repo
already has ~180 `*_test.go` files — it is a test system that **drives the
real binaries the way a user does** and leaves behind enough evidence to
tell you exactly where a run went wrong.

Everything below follows from that: real processes, real HTTP, real
terminals, real browsers, real recordings.

## The four surfaces

| Surface | What ships | Entrypoint today | Test strategy |
|---|---|---|---|
| **Backend** | HTTP API, ~120 routes under `/api/*`, agent loop, MCP, workflows | `backend-go/cmd/server` | Spawn the real binary, drive it over HTTP with a typed client |
| **TUI** | `amiro` chat / `amiro run` / `amiro auth` | `backend-go/cmd/amiro` | Spawn under a PTY, send keys, assert on rendered frames |
| **UI** | Next.js static export (`output: "export"` → `out/`) | none yet — see Phase 0 | Playwright against the real backend serving the real bundle |
| **Desktop** | Tauri v2 shell spawning the sidecar | `src-tauri` | Drive the lifecycle: spawn, `PORT=` handoff, shutdown, orphan kill |

### The gap Phase 0 closes

There is no way to serve the dashboard today. `next.config.ts` is
`output: "export"`, so `out/` is a static bundle with no server; the Go
side has no `http.FileServer` anywhere (`grep -rn "embed.FS"` finds only
`internal/db/migrate.go`); and `cmd/amiro` has no `serve` subcommand.
`cmd/server` deliberately binds `127.0.0.1` and refuses to be anything but
a loopback sidecar.

So "run the TUI with a dashboard, served on `0.0.0.0` with `--port`" is a
feature that has to be built before it can be tested. That is
[Phase 0](phases/phase-00-serve-and-embed.md).

## Principles

1. **Real processes over in-process handlers.** `httptest.NewServer` proves
   the handler; it does not prove the binary starts, binds, migrates,
   authenticates, and shuts down. The root `tests/` tree only ever talks to
   spawned binaries. In-process handler tests keep living next to the code
   they test — those are not this plan's job.

2. **One artifact directory per run.** Every process, every surface, every
   language writes under `tests/logs/<run-id>/`. The harness exports
   `AMIRO_TEST_RUN_DIR` so Playwright and the Tauri driver land in the same
   tree without knowing anything about the harness.

3. **Deterministic by default, real on demand.** Replayed provider traffic
   makes the suite fast, free, and assertable. `--live` proves the
   recordings still match reality. Both use the identical code path — the
   only difference is whether the recorder is in front of the network.

4. **Every granularity is a first-class command.** `--surface ui
   --feature chat` is not a convenience wrapper; it is the primary way the
   suite is used during development. See [03](03-selection.md).

5. **Config is all-optional.** A contributor with no `config.yaml` and no
   API keys still gets a green run — in `fake` provider mode. Adding keys
   upgrades fidelity; it is never a prerequisite.

6. **Failures explain themselves.** A red test points at a run directory
   containing the request that failed, the frame that was wrong, the video
   of the click, the server's stderr around that timestamp, and a merged
   timeline that interleaves all of them.

7. **No test imports backend internals.** `tests/` is a black box consumer.
   The one exception is the typed API client under `harness/apiclient/`,
   which is a *test-owned* transcription of the wire format — if it drifts
   from `internal/api`, that is a finding, not a maintenance chore.

## Scope

**In scope.** Everything under [`phases/`](phases/README.md): API contract
coverage for all route groups, the agent loop with tools and approvals, TUI
interaction and rendering, browser E2E with recordings, desktop lifecycle,
cross-surface state sharing, resilience, performance budgets, CI.

**Out of scope.**
- Replacing the existing colocated `*_test.go` unit tests. They stay.
- `backend-go/evals/` — LLM quality evaluation is a different discipline
  with different success criteria. This plan tests that the harness *runs*;
  it does not score model output.
- Load testing beyond the coarse budgets in
  [Phase 7](phases/phase-07-cross-surface.md).
- Testing third-party providers themselves. We test our handling of their
  responses, including their failure modes.

## Non-goals worth stating explicitly

- **100% coverage is not a target.** Route-group completeness and
  user-journey completeness are.
- **The suite is not allowed to be slow by default.** Budget: the full
  default run finishes in under 10 minutes on a laptop. Anything slower is
  tagged and excluded from the default selection.
- **No test may depend on another test's leftovers.** Every test gets a
  fresh database and a fresh workspace copy.

## Success criteria for the whole plan

- `cd tests && amirotest run` passes from a clean checkout with **no
  `config.yaml` and no API keys**.
- `amirotest run --surface ui --feature chat` runs exactly the chat browser
  specs and nothing else, in under 60 seconds.
- Every failure produces a run directory a person (or an agent) can read
  without re-running anything.
- `amirotest run --live` proves the cassettes still match the real APIs.
- CI blocks a merge on the default run; a nightly job runs `--live`.
