# Phase 1 — Harness foundation

**Status:** ✅ Done — 2026-08-19
**Plan:** [phases/phase-01-harness-foundation.md](../phases/phase-01-harness-foundation.md)

The phase that makes every later phase cheap. Nothing here tests Amiro;
everything here is what the tests stand on.

## Entry condition

Met before any code was written. `docs/notes-backend-testing.md` recorded
four failures, including all four of `tests/e2e`'s `TestSidecar_*` — the
tests covering the `PORT=` stdout handoff the entire harness depends on to
find a backend. Re-run at the start of this phase:

```
--- PASS: TestSidecar_PrintsPortAndBindsLoopbackOnly (2.72s)
--- PASS: TestSidecar_HealthRejectsRequestWithoutToken (2.86s)
--- PASS: TestSidecar_HealthReturnsOkWithValidToken (2.66s)
--- PASS: TestSidecar_ShutsDownGracefullyOnSIGTERM (2.61s)
ok  	amiro/backend/tests/e2e	10.848s
```

All four pass with nothing changed, which supports the environment-specific
reading that note already suspected. Building the harness on an unexplained
failure in exactly the mechanism it depends on is how a suite becomes
untrustworthy on day one, so this was checked rather than assumed.

## What shipped

**Nothing outside `tests/` was touched.** The whole phase is a new module.

### The module

| File | Purpose |
|---|---|
| `tests/go.mod` | `module amiro/tests`, go 1.26.5. **No dependency on `amiro/backend`** — see divergence 1 |
| `tests/.gitignore` | `config.yaml`, `config.local.yaml`, `.env`, `logs/`, `node_modules/` |
| `tests/README.md` | 202 lines: quickstart, selection, configuration, artifacts, isolation table, how to write a test |
| `tests/Taskfile.yml` | Thin wrappers over `amirotest` — every task is one line, deliberately |
| `tests/package.json` | `@amiro/tests`, `@playwright/test` only. Committed; no install until Phase 5 |
| `tests/config.example.yaml` | 435 lines, **generated** from `defaults.go` |
| `tests/cassettes/README.md` | Placeholder so `providers.mode: replay` does not warn on a fresh checkout |
| `tests/fixtures/workspaces/basic/` | 4 files — the default agent file-tool sandbox |

Two dependencies, total: `gopkg.in/yaml.v3` and `github.com/jackc/pgx/v5`
(postgres schema-per-test).

### The harness

| Package | Files | LOC | Tests | Responsibility |
|---|---|---|---|---|
| `harness/config` | 9 | 1921 | 22 | Load → merge → `${VAR}` expand → env → flags → validate; redaction; example generation |
| `harness/run` | 2 | 812 | 12 | Run id, run directory, `latest` symlink, pruning, `run.json`, `summary.*`, `results.ndjson` |
| `harness/logging` | 4 | 529 | 8 | NDJSON fan-out, `events.ndjson`, write-time redaction, cross-process file locking |
| `harness/process` | 3 | 487 | 8 | Spawn, readiness predicates, process groups, graceful stop, teardown assertions |
| `harness/backend` | 6 | 942 | 16 | Build cache, per-test env, `PORT=` handoff, `/health`, database, workspace, discovery lock |
| `harness/apiclient` | 12 | 1680 | 12 | Typed `/api/*` client for every route family; SSE frame decoding; logs every exchange |
| `harness/seed` | 1 | 187 | — | Declarative fixtures applied through the **real** API |
| `harness/selector` | 2 | 467 | 11 | Discovery, surface/feature/grep/tag → runner invocations, tag decisions |
| `harness/assert` | 1 | 305 | 9 | Golden files with normalisation, `Eventually`, JSON subset, diff |
| `harness` (root) | 2 | 424 | — | `harness.New(t, opts...)` and the options |
| `cmd/amirotest` | 10 | 1116 | — | `run · list · doctor · record · report · env · config · clean` |

`harness/process` and `harness/logging` each carry a `_unix.go` /
`_windows.go` pair, and the module cross-compiles clean for
`GOOS=windows` and `GOOS=darwin`. The plan's Risks section flagged Windows
as a "get it right now, retrofitting after four suites exist is much worse"
item; that is why the split exists this early rather than when a Windows CI
job first appears.

### The suites

| Suite | Tests | LOC | What it proves |
|---|---|---|---|
| `suites/backend/smoke` | 3 | 332 | The backend builds, starts, prints `PORT=`, answers `/health`; seeding produces the real permission model; a run leaves a complete artifact tree |
| `suites/meta` | 11 | 558 | The guards — config drift, secret leaks, orphans, port leaks, concurrency isolation, import boundaries, no-sleep, address uniqueness |

**Totals: 65 Go files · 8870 non-test LOC · 3134 test LOC · 112 test
functions.** All passing.

## What diverged from the plan, and why

### 1. `tests/` does not `replace amiro/backend`, and cannot

The plan specified:

```
require amiro/backend v0.0.0
replace amiro/backend => ../backend-go
```

so the harness could reuse `internal/ai/uimessage` (chat stream frames) and
`internal/appwiring.Lock` (the discovery file).

**This is impossible.** Go forbids importing a path containing `internal`
from outside the tree rooted at that `internal` directory's parent. The
parent here is `backend-go/`; module `amiro/tests` sits beside it, not
inside it. No `replace` directive changes that — it is a compiler rule about
paths, not a module-resolution question.

Both types are transcribed instead:

- `harness/apiclient/stream.go` — `Frame`, `FrameType`, the SSE scanner
- `harness/backend/lock.go` — `Lock`, 3 fields

The result is better than what was planned. `tests/go.mod` has **no
dependency on the application at all**, so the test system talks to Amiro
over HTTP, a PTY and a browser exactly as a user does — which is what
[01-architecture](../01-architecture.md) wanted in the first place. The
plan's own Risks section worried that "importing `amiro/backend` for two
types is convenient and could become a habit of reaching into internals";
the language removed the risk entirely.

The cost of transcription is drift, and it is paid rather than accepted:

- `TestStream_DecodesTheFrameTypesTheServerActuallyWrites` decodes the wire
  form of a complete turn — every frame kind, tool calls, data parts,
  metadata.
- `TestBackend_BuildsStartsAndAnswersHealth` reads a **real**
  `sidecar.lock.json` written by a **real** server and checks the pid, port
  and token all match what the harness observed independently.
- `suites/meta/boundary_test.go` fails the build if any file in the module
  ever imports `amiro/backend`, so the door stays shut for a *non*-internal
  package appearing later.

### 2. `config.example.yaml` is generated, so it is not byte-identical to the plan's reference

[reference/config.example.yaml](../reference/config.example.yaml) is
hand-annotated and shows commented-out sample provider entries. The
committed `tests/config.example.yaml` is generated from `defaults.go` by
`amirotest config example`, so:

- `providers.llm` renders as `llm: []` with the sample structure **in the
  comment block** rather than as commented-out YAML;
- `ui.viewport` is nested rather than inline flow style.

Generation is worth the cosmetic difference because it makes a specific
class of lie impossible. The usual way a config template's comments become
false is that someone changes a default and nobody regenerates. Two guards
now prevent it:

- `TestConfigExample_MatchesTheDefaults` — the committed file is exactly
  what the generator emits.
- `TestConfigExample_ParsesBackToExactlyTheDefaults` — loading the file
  reproduces `Defaults()` **exactly**, by `reflect.DeepEqual`. So "delete
  `config.yaml`" and "copy the example verbatim" genuinely produce the same
  run, which is what [02-config](../02-config.md) promises.

The plan's reference file remains the design document; the generated file is
the artifact.

### 3. `run.surfaces` defaults to five surfaces, not four

The plan's default is `[backend, tui, ui, desktop]`. `meta` was added.

The guards are what catch the test system itself degrading — config drift, a
leaked secret, an orphaned process, a suite importing another suite. They
cost under a second. A default run that skipped them would let exactly the
degradation they exist to catch land unnoticed, which defeats the point of
writing them.

### 4. Surfaces run sequentially, not concurrently

[03-selection](../03-selection.md) specifies "surfaces run in parallel with
each other by default". They currently run one after another.

`go test` already parallelises **within** a surface (`run.parallel` becomes
`-parallel`), which is where the actual wall-clock is. Cross-surface
concurrency mainly matters once the UI and desktop surfaces exist to overlap
with — and doing it now would interleave two runners' stdout with no way to
read it. Deferred to Phase 5, when there is a second runner to overlap and a
reason to solve the output-multiplexing problem properly. Recorded here so
it is a decision rather than an omission.

### 5. Postgres schema-per-test is written but unexercised

`harness/backend/db.go` implements it: `CREATE SCHEMA`, `search_path` in the
DSN, `DROP SCHEMA ... CASCADE` on cleanup, for both URL and keyword DSN
forms. Schema names are hashed when long, because postgres truncates
identifiers at 63 bytes and two long test names sharing a prefix would then
collide — the exact failure per-test isolation exists to prevent.

**No postgres server exists in this environment, so the connect/create/drop
path has never actually run.** What *is* tested is everything reachable
without a server: DSN rewriting for both forms, and identifier derivation
including the length and character-set constraints. Treat the live path as
unverified until Phase 2's migration suite exercises it.

sqlite — the default, and what every test here uses — is fully exercised.

### 6. `harness.New` needs no `TestMain`

The plan implies an orchestrator writes the summary at the end. Instead every
process appends to `results.ndjson` as it goes, and the summary is
re-rendered from that file on each result.

The reason is that "once at the end" does not happen when a run is
interrupted — and an interrupted run is exactly when someone wants to read
what got as far as passing. A `go test` binary with no `TestMain`, a shard
killed by a timeout, and the Playwright reporter all now contribute
identically, and `amirotest report` rebuilds a summary from the results file
when `summary.json` is missing.

### 7. Keyring isolation is real on Linux, not on macOS

[06-fixtures-and-seeding](../06-fixtures-and-seeding.md) calls for a mocked
keyring. `go-keyring`'s mock is in-process only and the backend under test is
a **spawned binary**, so it cannot apply.

What `harness/backend.Env()` does instead is strip
`DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR`, which makes
`internal/secrets.KeyringStore`'s keyring call fail and its documented
`keys.json` fallback — inside the per-test app-data directory — take over.
That is a genuine fix on Linux and in CI.

On macOS `go-keyring` shells out to `/usr/bin/security`, which no
environment variable redirects. The harness **emits a `keyring not
isolated` event** on darwin rather than letting a test believe it is
isolated when it is not. A real fix needs either a `destructive` tag on the
affected tests or a PATH-shimmed `security`; deferred, and flagged as a
follow-up.

## Two real bugs the guards caught on their first run

Worth recording because they are the return on writing the guards at all,
rather than after four suites exist.

**A session bearer token was being logged in the clear.** `http.ndjson`
recorded request and response bodies as JSON-encoded **strings**, which are
opaque to the redactor's field-name pass — so `{"token":"d89b2f75..."}`
inside a quoted string sailed past `providers.redact` intact. Fixed by
recording bodies as embedded JSON (`apiclient.body`) so the redactor walks
into them. `TestRedactor_DescendsIntoNestedJSONByFieldName` pins it.

**Redaction markers were being HTML-escaped into invisibility.**
`encoding/json` escapes `<` and `>` by default, so every marker was written
as `\u003credacted:sha256:...\u003e` — unreadable in a log, and invisible to
any grep for the marker, *including the guard that proves redaction
happened*. The guard was being defeated by the encoder rather than
by a leak. Fixed with a non-escaping encoder throughout `harness/logging`;
`TestRedaction_MarkersAreNotHTMLEscaped` pins it.

A third, smaller one: `run.json` was serialising Go field names
(`BindHost`) and raw nanosecond durations (`1800000000000`). That file is the
answer to "what was this run configured with?", and it has to answer in the
same vocabulary the user typed. Fixed by mirroring all 87 `yaml` tags as
`json` tags and giving `Duration` a JSON marshaller.

And one that was not a bug: the smoke suite's secret sweep failed on
`appdata/sidecar.lock.json`. That file is written by the **server**, at
0600, and is *supposed* to contain the shared secret — it is how `amiro`
discovers a running backend. Redacting it would break the feature under
test. The sweep now excludes captured application state (`appdata/`, `db/`,
`workspace/`, `home/`) with the reasoning recorded at both call sites: the
rule is that nothing the *harness* writes may leak, not that the application
may not keep its own secrets in its own state directory.

## Exit criteria

All seven from the phase doc, verified against real output — see
[verification-log-phase-01.md](verification-log-phase-01.md).

- [x] **1.** `amirotest doctor` reports the toolchain accurately with a
      component missing. **cargo is genuinely absent on this machine**, and
      doctor says so *and what it means*: "the desktop surface needs it;
      `desktop.enabled: auto` means it skips, not fails" — then exits 0,
      Ready. Repeated with `pnpm` hidden from `PATH`.
- [x] **2.** `amirotest run --surface backend --feature smoke` passes from a
      clean checkout with **no `config.yaml` and no API keys**: 3 passed, 0
      failed, exit 0.
- [x] **3.** `go test ./suites/backend/smoke/` alone produces a complete run
      directory — `run.json`, `summary.md`, `summary.json`,
      `results.ndjson`, `events.ndjson`, plus per-test stdio, `http.ndjson`
      and the isolated `appdata/ db/ workspace/ home/`.
- [x] **4.** No `config.yaml`, `AMIRO_TEST_RUN_PARALLEL=8`, `--parallel 2`
      → the run uses **2**, and `run.json` shows both the final value and
      `envApplied: ["run.parallel"]`, so *why* is answerable from the file.
- [x] **5.** A corrupted `config.yaml` exits **2** with all three errors in
      one report — unknown key with line number and a `did you mean
      "parallel"?` suggestion, bad enum with the valid set, missing path —
      and **no `logs/` directory is created at all**: nothing was minted,
      nothing was spawned.
- [x] **6.** Two backends started concurrently collide on nothing —
      `TestBackends_StartedConcurrentlyDoNotCollide` asserts distinct port,
      app-data directory and database from two `t.Parallel()` subtests.
- [x] **7.** `amirotest list` prints all 14 discovered addresses across 2
      features.

## Risks the plan named, and how they landed

**Scope creep.** The discipline was "done when Phase 2 can be written
without touching `harness/` again for anything but genuinely new
capability". Phase 2 needs: suites under `suites/backend/<feature>/`, and
`apiclient` methods for route families it exercises. Every route family
already has typed methods. `harness/` should not need structural change.

**The `replace` directive.** Removed entirely — see divergence 1 — and
replaced with a guard that fails the build if the dependency ever appears.

**Windows.** `harness/process` and `harness/logging` are build-tagged, the
module cross-compiles clean, and the one genuine platform gap (no POSIX
process groups) is documented at the code where it matters rather than
discovered later. `AssertPortFree` exists as a *separate* assertion from
`AssertStopped` precisely because on Windows a detached grandchild can
survive the stop — the port check is what catches it.

## Follow-ups for later phases

| Item | Phase | Why it waits |
|---|---|---|
| Cross-surface concurrency + output multiplexing | 5 | Needs a second runner to overlap with |
| Exercise the postgres path against a real server | 2 | Migration suite is where it earns its place |
| macOS keyring isolation (PATH shim or `destructive` tag) | 4/6 | Only bites suites that write provider keys |
| `harness/cassette`, `harness/fakeprovider` | 3 | `providers.mode` is plumbed; the proxy is not built |
| `harness/pty`, asciinema `.cast` writing | 4 | TUI surface |
| `playwright.config.ts`, `harness/browser`, `pnpm install` | 5 | UI surface |
| `run.retries` / `attempt-N/` directories | 7 | Config key exists and validates; the retry loop is not wired |
| `run.keepArtifacts` pruning of heavy artifacts | 7 | Validated and recorded; nothing heavy is produced yet |
| `run.costCeilingUsd` enforcement | 3 | Needs real provider calls to have a cost to cap |
