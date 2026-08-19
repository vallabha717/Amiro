# Phase 1 — Harness foundation

> ✅ **Shipped 2026-08-19.** Implementation record:
> [`../progress/phase-01-harness-foundation.md`](../progress/phase-01-harness-foundation.md)
> · **Verification:** [`../progress/verification-log-phase-01.md`](../progress/verification-log-phase-01.md)
>
> Seven things diverged from what is written below — including deliverable
> 1's `replace amiro/backend` directive, which the Go compiler forbids. Read
> the progress record before treating anything here as the design.

**Depends on:** nothing · **Blocks:** everything · **Size:** L

The phase that makes every later phase cheap. Nothing here tests Amiro;
everything here is what the tests will stand on.

## Entry condition

**Met.** All four now pass with nothing changed — see the progress record.

Triage the four failures recorded in `docs/notes-backend-testing.md` —
especially `tests/e2e`'s `TestSidecar_*`, which fail with *"sidecar exited
or closed stdout before printing a PORT= line."* The entire harness reads
that line to find the backend. If it is genuinely broken, fix it; if it is
environmental, record the cause. Building on an unexplained failure in
exactly the mechanism you depend on is how a suite becomes untrustworthy on
day one.

## Deliverables

### 1. The module

```
tests/go.mod          module amiro/tests, go 1.26.5, replace amiro/backend => ../backend-go
tests/package.json    @amiro/tests — @playwright/test only
tests/Taskfile.yml    thin task wrappers over amirotest
tests/.gitignore      config.yaml, config.local.yaml, .env, logs/, node_modules/
tests/README.md       quickstart: copy the config, run the command
```

### 2. `harness/config`

- The full default tree in `defaults.go` as a Go value.
- Load → deep-merge (maps deep, lists replaced) → `${VAR}` expansion →
  `AMIRO_TEST_*` overlay → flag overlay.
- Strict unknown-key detection with a nearest-key suggestion.
- Validation with **all** errors reported at once, not the first.
- `amirotest config example` generating `config.example.yaml` from
  `defaults.go`, plus a `--check` mode CI uses to catch drift.
- Redacted marshalling for `run.json`.

Full schema: [02](../02-config.md) and
[reference/config.example.yaml](../reference/config.example.yaml).

### 3. `harness/run` + `harness/logging`

- Run id, `logs/<run-id>/` creation, `logs/latest` symlink, pruning to
  `logging.keepRuns`.
- `run.json` written before anything is spawned, so a crashed run is still
  diagnosable.
- NDJSON logger fanning to per-surface files and the merged
  `events.ndjson`, with serialised cross-process writes.
- Redaction at write time (never post-processing).
- `summary.md` / `summary.json` renderers, and `amirotest report`.

### 4. `harness/process`

The supervisor every spawned thing goes through:

- streaming stdio to disk as produced, never buffered to exit;
- readiness as a predicate with a deadline, never a sleep;
- process groups, so killing a parent kills its children;
- graceful stop → SIGTERM → 5s → SIGKILL;
- teardown assertions: the process exited, and its port is free.

### 5. `harness/backend`

- Build-and-cache `cmd/server` and `cmd/amiro` (hash the source tree; skip
  entirely when `backend.binary` is set).
- Per-test env from resolved config — the one place that knows `AMIRO_*`
  names.
- Spawn, parse `PORT=`, poll `/health`, return a `*Backend`.
- Fresh sqlite file / postgres schema per test; drop on cleanup.
- Workspace fixture copying.
- Temp HOME and `XDG_DATA_HOME`; mocked keyring.

### 6. `harness/apiclient`

Typed client for `/api/*` — test-owned, not generated from the server, so
drift shows up as a test failure rather than propagating silently. Logs
every exchange to `backend/http.ndjson`. Covers auth, threads, chat
(including SSE frame decoding via `internal/ai/uimessage`), agents, MCP,
workflows, archive, export, search, providers, user, admin, storage.

### 7. `harness/seed`

Declarative composable seeds applied through the real API. `seed.Default`
(admin, user, other) auto-applied unless `harness.NoSeed()`. See
[06](../06-fixtures-and-seeding.md).

### 8. `harness/selector` + `cmd/amirotest`

Selection resolution ([03](../03-selection.md)) and the CLI: `run`, `list`,
`doctor`, `record`, `report`, `env`, `config example`, `clean`. Plus the
tag system and `harness.New(t, harness.Tags(...))`.

### 9. `harness.New`

The single entry point, doing everything a test needs and registering
every cleanup:

```go
func New(t *testing.T, opts ...Option) *Harness
```

Self-bootstrapping: joins `AMIRO_TEST_RUN_DIR` if set, otherwise mints its
own run — which is what makes a bare `go test ./suites/backend/chat` work
with full artifacts.

### 10. The first smoke tests

`suites/backend/smoke/` — three tests that prove the foundation:

- the backend builds, starts, prints `PORT=`, and `/health` returns 200;
- `seed.Default` produces one admin and two users, and the admin is the
  first-registered account;
- the run directory afterwards contains `run.json`, `summary.json`,
  `events.ndjson`, and the backend's stdout log.

### 11. The first `suites/meta/` guards

- config example matches defaults;
- no orphan processes or bound ports after a run;
- no configured secret's literal value appears anywhere in the log tree.

## Exit criteria

1. `cd tests && go run ./cmd/amirotest doctor` reports the toolchain state accurately on a machine missing Node, and again on one missing cargo.
2. `amirotest run --surface backend --feature smoke` passes from a clean checkout with **no `config.yaml` and no API keys**.
3. `go test ./suites/backend/smoke/` alone produces a complete run directory.
4. Deleting `config.yaml`, then setting `AMIRO_TEST_RUN_PARALLEL=8`, then passing `--parallel 2` — the run uses 2, and `run.json` shows it.
5. A deliberately corrupted `config.yaml` (unknown key, bad enum, missing path) exits 2 with all three errors in one report and nothing spawned.
6. Two backends started concurrently do not collide on port, database, or app-data directory.
7. `amirotest list` prints every discovered address.

## Risks

- **Scope creep.** This phase can absorb infinite polish. The discipline: it is done when Phase 2 can be written without touching `harness/` again for anything but genuinely new capability.
- **The `replace` directive.** Importing `amiro/backend` for two types is convenient and could become a habit of reaching into internals. Add a `suites/meta/` guard listing the permitted imports.
- **Windows.** Process groups, PTYs and signals differ. Get `harness/process` right on Windows now; retrofitting it after four suites exist is much worse.
