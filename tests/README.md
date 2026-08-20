# Amiro tests

The whole test system: one harness, one command, one run directory.

```bash
cd tests
go run ./cmd/amirotest doctor     # what is installed, and what each gap means
go run ./cmd/amirotest run        # run everything
```

**You do not need a `config.yaml`, and you do not need any API keys.** A
clean checkout with neither is a valid, passing configuration — that is the
central design rule, not a courtesy. Copy
[`config.example.yaml`](config.example.yaml) to `config.yaml` only when you
want to change something; every key in it is optional and documents its own
default.

The plan this implements is in
[`docs/testing/`](../docs/testing/README.md); what is actually built so far
is in [`docs/testing/progress/`](../docs/testing/progress/README.md).

## Running exactly what you want

The directory path *is* the test's address — `suites/<surface>/<feature>/`
and `ui/specs/<feature>/`. There is no registry to keep in sync; adding a
feature means creating a directory.

```bash
amirotest run                                  # everything
amirotest run --surface backend                # one surface
amirotest run --surface backend --feature chat # one feature of one surface
amirotest run --feature chat                   # that feature on EVERY surface
amirotest run --tag smoke                      # by tag, across surfaces
amirotest list                                 # every address that exists
```

`amirotest` is never the *only* way in. The harness self-bootstraps, so the
native runners work with no ceremony and produce the same artifacts:

```bash
go test ./suites/backend/smoke/ -run TestBackend_BuildsStartsAndAnswersHealth -v
pnpm playwright test ui/specs/chat/streaming.spec.ts --headed   # from Phase 5
```

That matters most for agents and editors: a single failing test gets the
full artifact trail without anything knowing the CLI exists.

## Configuring it

Precedence, lowest to highest:

```
defaults (harness/config/defaults.go)
  ← config.yaml
  ← config.local.yaml     (gitignored, per-machine)
  ← AMIRO_TEST_* env
  ← CLI flags
```

Maps merge deep; **lists are replaced wholesale** — setting
`providers.llm` replaces the default list rather than appending to it,
because a partial list is what you meant.

Anything in the file can be set from the environment instead:

```bash
go run ./cmd/amirotest env --list        # every variable and the key it sets
AMIRO_TEST_RUN_PARALLEL=8 amirotest run
AMIRO_TEST_PROVIDERS_MODE=live amirotest run
```

Secrets belong in `tests/.env` (gitignored) and are referenced as
`${ANTHROPIC_API_KEY}` — or `${VAR:-fallback}`. An unset variable expands to
empty and means *not configured*: a provider whose `apiKey` ends up blank is
dropped, and `run.json` records that it was.

A bad `config.yaml` reports **every** problem at once, with line numbers and
a nearest-key suggestion, and runs nothing (exit code 2).

## Where the evidence goes

Every run creates one directory, and everything every surface produces goes
inside it. `logs/latest` points at the newest.

```
logs/<run-id>/
├── run.json          resolved config (redacted), selection, git sha, toolchain
├── summary.md         human-readable report
├── summary.json       machine-readable, one entry per test
├── results.ndjson     append-only outcomes — survives an interrupted run
├── events.ndjson      THE MERGED TIMELINE: every surface, one clock
└── backend/<test-id>/
    ├── server.stdout.log · server.stderr.log
    ├── http.ndjson    every request/response, redacted at write time
    ├── appdata/ · db/ · workspace/ · home/    this test's isolated world
```

`events.ndjson` is the one to reach for first:

```bash
go run ./cmd/amirotest report --timeline --test 'backend/smoke/TestBackend_BuildsStartsAndAnswersHealth'
```

Redaction happens **at write time**, never as a later pass — a secret that
reaches disk once has leaked. `suites/meta` greps the whole log tree for
every configured secret and fails if one appears.

## What isolation you get

Per test, all inside the run directory and all torn down afterwards:

| Resource | What the test gets |
|---|---|
| Backend process | Its own, on an OS-assigned port |
| Database | A fresh sqlite file (or a fresh postgres schema, dropped on cleanup) |
| Workspace | A **copy** of `fixtures/workspaces/basic` → `AMIRO_WORKSPACE_ROOT` |
| App data | `<runDir>/backend/<test-id>/appdata/` → `AMIRO_APP_DATA_DIR` |
| HOME | A temp HOME, so `~/.config/amiro/config.yaml` is the test's, not yours |
| Auth token | A fresh random one, registered with the redactor |
| Keyring | The session bus is stripped, so provider keys land in the run directory |

Nothing is shared, so nothing is order-dependent, so parallelism is safe by
construction. Teardown *asserts* the process exited and its port is free — a
leaked backend is reported as a failure here rather than breaking an
unrelated test twenty minutes later.

## Writing a test

```go
func TestListThreads_ReturnsOnlyTheCallersOwn(t *testing.T) {
    h := harness.New(t)          // config + run dir + isolated backend + cleanups
    alice := h.As("user")        // a seeded, signed-in identity
    bob := h.As("other")

    // ... exercise the API through the typed client ...
}
```

`harness.New(t)` is the whole entry ceremony. Useful options:

| Option | For |
|---|---|
| `harness.Tags("smoke")` | Declare cross-cutting properties; selection honours them |
| `harness.NoSeed()` | A genuinely empty database — first-run and onboarding tests |
| `harness.NoBackend()` | Config and run directory only; no server started |
| `harness.With(fn)` | Override config for this test alone |
| `harness.Seeds(...)` | Extra fixtures beyond the default accounts |

Three seeded identities exist, and the order they are created in is
load-bearing: `internal/auth` makes the **first** registered account the
admin, so `admin` is always registered first. `user` and `other` are two
distinct non-admins, which is what every "can B see A's data?" test needs.

## Layout

```
cmd/amirotest/   the one entrypoint binary
harness/         the shared library every suite imports
  config/        load, merge, expand, validate, redact — one source of truth
  run/           run id, run directory, run.json, summary
  logging/       NDJSON fan-out, events.ndjson, write-time redaction
  process/       spawn, readiness predicates, process groups, teardown asserts
  backend/       build cache, per-test env, PORT= handoff, /health, db, workspace
  apiclient/     typed /api/* client; logs every exchange
  seed/          declarative fixtures, applied through the REAL API
  selector/      surface/feature/grep/tag → runner invocations
  assert/        golden files, normalisation, Eventually, JSON subset
suites/          Go suites — the path IS the address
  backend/smoke/ the three tests that prove the foundation
  meta/          the guards: tests OF the test system
fixtures/        data, not code
cassettes/       committed provider recordings (populated in Phase 3)
logs/            gitignored, one directory per run
```

Two rules keep it navigable: **`harness/` is the only place with shared
code** — a suite never imports another suite, and `suites/meta` fails the
build if one does. And **nothing here imports the application** — the test
system talks to Amiro over HTTP, a PTY and a browser, exactly as a user
does.

## Suite status

All core testing surfaces are active: `meta/`, `backend/`, `tui/`, `ui/`, `cross/`, and `desktop/`. All tests run via `go run ./cmd/amirotest run` or `go test` within individual suite directories. See [`docs/testing/progress/`](../docs/testing/progress/README.md) for the testing foundation record and [`docs/skills/progress/`](../docs/skills/progress/README.md) for the skills initiative progress records.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Everything selected passed, or skipped for a recorded reason |
| 1 | At least one test failed |
| 2 | Configuration error — nothing ran |
| 3 | Infrastructure failure — a binary would not build, a port would not bind, a runner was missing |

2 and 3 are distinct from 1 on purpose. "The suite could not run" and "the
code is broken" demand different responses.
