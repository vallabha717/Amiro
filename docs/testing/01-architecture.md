# 01 — Architecture

## Where it lives

```
Amiro/
├── backend-go/            # unchanged; keeps its own tests/ for in-module suites
├── src/                   # unchanged
├── src-tauri/             # unchanged
├── docs/testing/          # this plan
└── tests/                 # NEW — the whole test system
```

`tests/` is **its own Go module and its own npm package**. It is not part
of `backend-go`'s module and not part of the root `package.json` workspace.
That buys three things:

- Test-only dependencies (PTY drivers, asciinema writers, cassette
  libraries, Playwright) never enter the shipped binary's dependency graph.
- The suite can `go build` the backend from source *or* consume a
  prebuilt binary — CI does the latter, laptops do the former.
- Nothing in `tests/` can accidentally import `internal/...` and start
  asserting on implementation detail.

`tests/go.mod`:

```
module amiro/tests

go 1.26.5
```

> **Corrected in Phase 1 (2026-08-19).** This section originally specified
> `require amiro/backend` + `replace amiro/backend => ../backend-go`, so the
> harness could reuse `internal/ai/uimessage` frame types and
> `internal/appwiring.Lock`.
>
> **That is impossible.** Go forbids importing a path containing `internal`
> from outside the tree rooted at that directory's parent — here
> `backend-go/`, which `tests/` sits beside rather than inside. No `replace`
> directive changes a compiler rule about paths.
>
> Both types are transcribed instead (`harness/apiclient/stream.go`,
> `harness/backend/lock.go`), each with a test that fails if the real wire
> format drifts. The outcome is better than what was planned: `tests/` has
> **no dependency on the application at all**, which is what the three bullet
> points above actually wanted. `suites/meta` fails the build if that
> dependency ever appears. See
> [progress/phase-01](progress/phase-01-harness-foundation.md).

Everything the harness needs from the application is transcribed on purpose.

## The full tree

The target layout, in full, is in
[reference/tests-tree.md](reference/tests-tree.md). The shape:

```
tests/
├── config.example.yaml   ── annotated template, committed
├── config.yaml           ── yours, gitignored
├── go.mod · package.json · playwright.config.ts · Taskfile.yml
│
├── cmd/amirotest/        ── the one entrypoint binary
├── harness/              ── the shared Go library every suite imports
├── suites/               ── Go suites: backend/ tui/ desktop/ cross/
├── ui/                   ── TypeScript: Playwright specs, fixtures, page objects
├── fixtures/             ── data, not code: workspaces, seeds, MCP server, media
├── cassettes/            ── committed provider recordings
└── logs/                 ── gitignored, created per run
```

Two rules keep it navigable:

1. **`suites/<surface>/<feature>/` is the selection contract.** The
   directory path *is* the test's address. `--surface backend --feature
   chat` resolves to `./suites/backend/chat/...` with no registry, no
   config file, and nothing to keep in sync. Same for
   `ui/specs/<feature>/`.
2. **`harness/` is the only place with shared code.** A suite never imports
   another suite. If two suites need the same helper, it moves to
   `harness/`.

## The harness

`tests/harness/` is a plain Go library. Every Go suite imports it; the
`amirotest` binary is a thin CLI over it; Playwright consumes its output
via files and environment variables.

| Package | Responsibility |
|---|---|
| `harness/config` | Load `config.yaml`, apply defaults, overlay env and flags, validate. The single source of truth for [02](02-config.md). |
| `harness/run` | Mint the run ID, create `logs/<run-id>/`, write `run.json`, own the run manifest and the final summary. |
| `harness/logging` | Structured NDJSON logger fanning into per-surface files *and* the merged `events.ndjson` timeline. |
| `harness/process` | Spawn, wait-for-readiness, stream stdio to disk, graceful stop, kill orphans. Every child process in the system goes through here. |
| `harness/backend` | Build (or locate) `cmd/server` / `cmd/amiro`, start it with a per-test env, parse the `PORT=` line, poll `/health`, hand back a `*Backend`. |
| `harness/apiclient` | Typed HTTP client for `/api/*`. Test-owned; logs every exchange to `backend/http.ndjson`. |
| `harness/seed` | Deterministic database fixtures: users, threads, agents, MCP configs, workflows, archives. |
| `harness/cassette` | Record/replay HTTP proxy sitting in front of provider base URLs. See [05](05-recording-and-replay.md). |
| `harness/fakeprovider` | Deterministic OpenAI/Anthropic-shaped server for tests that need a provider but not a real response. |
| `harness/pty` | PTY allocation, key injection, ANSI screen buffer, frame capture, asciinema `.cast` writing. |
| `harness/browser` | Bridge only: resolves the UI base URL, writes `ui/.env.run` for Playwright, collects Playwright's JSON report back into the run summary. |
| `harness/selector` | Parses `--surface/--feature/--grep/--tag` into concrete `go test` and `playwright test` invocations. |
| `harness/assert` | Golden-file compare with redaction, JSON subset matching, eventually-consistent polling. |

### Why Go owns orchestration

The center of gravity is Go: the backend, the TUI, the agent loop, the
sidecar lifecycle. Three of the four surfaces are natively testable in Go
with no subprocess indirection. Making Node the orchestrator would mean
every backend and TUI assertion travels through `go test` stdout parsing.

Playwright stays in TypeScript because it is the only serious browser
driver and reimplementing its trace/video pipeline would be absurd. The
seam between them is deliberately thin and file-based:

```
Go harness                                    Playwright
──────────                                    ──────────
resolve config.yaml ──────────────────────►  reads tests/logs/<run>/run.json
start backend, get URL ───────────────────►  reads AMIRO_TEST_BASE_URL
create logs/<run>/ui/ ────────────────────►  reads AMIRO_TEST_RUN_DIR
                       ◄────────────────────  writes trace.zip / video / HAR there
collect results.json  ◄────────────────────  writes ui/results.json
```

Playwright's config reads `run.json` if `AMIRO_TEST_RUN_DIR` is set and
otherwise bootstraps its own run directory by calling
`amirotest env --surface ui`. That is what makes `pnpm playwright test`
work standalone — see [03](03-selection.md).

## Run lifecycle

```
amirotest run --surface ui --feature chat
   │
   ├─ 1. resolve config      defaults ← config.yaml ← AMIRO_TEST_* ← flags
   ├─ 2. validate            unknown keys, bad enums, unreachable paths → fail now, not mid-run
   ├─ 3. mint run            logs/2026-08-19T14-32-05Z-a1b2c3/ + run.json
   ├─ 4. build               go build ./cmd/server ./cmd/amiro   (cached; skipped if binary: set)
   │                         next build                           (skipped if out/ is fresh)
   ├─ 5. resolve selection   → playwright test ui/specs/chat
   ├─ 6. per-test setup      fresh sqlite file · fresh workspace copy · seeded accounts
   │                         cassette proxy up · backend spawned · /health green
   ├─ 7. execute             stream events into events.ndjson as they happen
   ├─ 8. per-test teardown   graceful stop → SIGKILL after 5s → assert no orphans
   ├─ 9. collect             merge Go + Playwright results, prune artifacts per keepArtifacts
   └─ 10. report             summary.md + summary.json + exit code
```

Steps 6–8 are per *test*, not per run. Isolation is non-negotiable: a
shared database is the single most common source of order-dependent
flakes, and this suite will run in parallel.

### Process supervision

Every spawned process is owned by `harness/process`, which guarantees:

- stdout and stderr are streamed to disk **as they are produced**, not
  buffered until exit — a hung process still leaves logs.
- readiness is a *predicate*, never a sleep. Backend: the `PORT=` line then
  `GET /health` returning 200. TUI: the first non-empty rendered frame.
  UI: the dashboard's root element.
- a process group is used, so killing the parent kills its children — this
  matters for the desktop suite, where Tauri spawns the sidecar.
- teardown asserts the process actually exited and no listener is left on
  its port. A leaked backend is reported as a test failure, not ignored.

## What a suite looks like

```go
// tests/suites/backend/thread/list_test.go
package thread_test

func TestListThreads_ReturnsOnlyTheCallersOwn(t *testing.T) {
    h := harness.New(t)                  // config + run dir + t.Cleanup, all resolved
    be := h.Backend()                    // fresh db, spawned binary, healthy
    alice := be.SignIn(h.Accounts.User)
    bob   := be.SignIn(h.Accounts.Other)

    alice.CreateThread("alice thread")
    bob.CreateThread("bob thread")

    got := alice.ListThreads()
    h.AssertLen(got, 1)
    h.AssertEqual(got[0].Title, "alice thread")
}
```

`harness.New(t)` is the whole entry ceremony. It reads the same
`config.yaml` whether it was invoked by `amirotest` or by a bare
`go test ./suites/backend/thread`, so an editor's "run test" gutter button
works with zero setup.

## Build and dependency notes

- **Go version** must track `backend-go/go.mod` (`go 1.26.5`).
- **Binary caching.** `harness/backend` hashes the backend source tree and
  reuses a built binary across tests in a run. `config.backend.binary`
  skips the build entirely — that is CI's path.
- **`out/` freshness.** The UI surface needs `pnpm build`. The harness
  compares `out/`'s mtime against `src/`'s newest file and rebuilds only
  when stale, unless `ui.mode: static` points at a prebuilt directory.
- **Playwright browsers** are installed by `pnpm playwright install
  --with-deps chromium` in Phase 5's setup task, not at test time.
