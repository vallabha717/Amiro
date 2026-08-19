# Verification log — Phase 1

Real commands and their real output, captured on **2026-08-19** on
`linux/amd64`, Go 1.26.5, Node v22.23.2, pnpm 11.21.0, **no cargo**.

Every claim in [phase-01-harness-foundation.md](phase-01-harness-foundation.md)
should be re-checkable from here rather than taken on trust. Paths are
abbreviated to `tests/` for readability; nothing else is edited.

---

## 1. The environment

```console
$ go version
go version go1.26.5 linux/amd64
$ node --version
v22.23.2
$ pnpm --version
11.21.0
$ cargo --version
bash: cargo: command not found
$ git --version
git version 2.54.0
```

The missing cargo is not a problem to work around — it is what makes exit
criterion 1 testable on this machine rather than hypothetically.

---

## 2. Entry condition — the four previously-failing tests

```console
$ cd backend-go && go test ./tests/e2e/ -run 'TestSidecar' -v
--- PASS: TestSidecar_PrintsPortAndBindsLoopbackOnly (2.72s)
--- PASS: TestSidecar_HealthRejectsRequestWithoutToken (2.86s)
--- PASS: TestSidecar_HealthReturnsOkWithValidToken (2.66s)
--- PASS: TestSidecar_ShutsDownGracefullyOnSIGTERM (2.61s)
PASS
ok  	amiro/backend/tests/e2e	10.848s
```

And the other two the note recorded:

```console
$ go test ./internal/auth/ ./internal/httpserver/
ok  	amiro/backend/internal/auth	3.035s
ok  	amiro/backend/internal/httpserver	(cached)
```

Nothing was changed to make these pass. The `PORT=` handoff the whole
harness depends on is trustworthy.

---

## 3. Exit criterion 1 — `doctor` reports the toolchain accurately

```console
$ cd tests && go run ./cmd/amirotest doctor
tests directory   .../Amiro/tests
config            none -- every value is a default, which is a valid, passing configuration

  ✓ go     go version go1.26.5 linux/amd64
  ✓ node   v22.23.2
  ✓ pnpm   11.21.0
  - cargo  not found
           the desktop surface needs it; desktop.enabled: auto means it skips, not fails
  ✓ git    git version 2.54.0

providers         replay
                  no provider keys configured -- provider-backed tests use canned responses
cassettes         .../Amiro/tests/cassettes
logs              .../Amiro/tests/logs (keeping the newest 20 runs)

Ready. Anything marked - above causes a surface to skip itself with a recorded reason, not to fail.
exit=0
```

Note what each missing tool line does: it states the consequence, not just
the fact. "cargo: not found" alone would send someone to install Rust to fix
a test they were not running.

Repeated with the Node toolchain removed from `PATH`:

```console
$ env PATH=/usr/local/go/bin:/usr/bin:/bin go run ./cmd/amirotest doctor
  ✓ go     go version go1.26.5 linux/amd64
  ✓ node   v26.6.0
  - pnpm   not found
           the ui surface needs it; without it, ui skips
  - cargo  not found
           the desktop surface needs it; desktop.enabled: auto means it skips, not fails
  ✓ git    git version 2.54.0
exit=0
```

(A system `node` still resolves at `/usr/bin`; `pnpm` does not, which
exercises the same path.)

---

## 4. Exit criterion 2 — a clean checkout, no config, no keys

```console
$ ls config.yaml
no config.yaml present

$ go run ./cmd/amirotest run --surface backend --feature smoke
run 2026-08-19T08-26-09Z-86e29c
  tests/logs/2026-08-19T08-26-09Z-86e29c
  providers: replay · parallel: 4

── backend ──
ok  	amiro/tests/suites/backend/smoke	0.606s

# Amiro test run 2026-08-19T08-26-09Z-86e29c

**PASSED** · 3 passed · 0 failed · 0 skipped · 1.8s
Started 2026-08-19T08:26:09Z · selection: --surface backend --feature smoke · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |      3 |      0 |       0 |    598ms |

Artifacts: tests/logs/2026-08-19T08-26-09Z-86e29c
exit=0
```

---

## 5. Exit criterion 3 — a bare `go test` produces the full artifact tree

```console
$ rm -rf logs && go test ./suites/backend/smoke/
ok  	amiro/tests/suites/backend/smoke	1.313s

$ find logs/2026-*/ -maxdepth 1 -type f | sort
logs/2026-08-19T08-18-58Z-7cc665/events.ndjson
logs/2026-08-19T08-18-58Z-7cc665/results.ndjson
logs/2026-08-19T08-18-58Z-7cc665/run.json
logs/2026-08-19T08-18-58Z-7cc665/summary.json
logs/2026-08-19T08-18-58Z-7cc665/summary.md

$ ls logs/2026-*/backend/backend-smoke-TestRun_ProducesACompleteArtifactTree/
appdata
home
http.ndjson
server.stderr.log
server.stdout.log
workspace
```

No orchestrator was involved. `harness.New` minted the run itself, which is
what makes an editor's run-test button and an agent iterating on one failing
test produce the same evidence as a full run.

---

## 6. Exit criterion 4 — precedence: flags beat env beats file

```console
$ AMIRO_TEST_RUN_PARALLEL=8 go run ./cmd/amirotest run \
    --surface backend --feature smoke --parallel 2
run 2026-08-19T08-19-10Z-60db78
  providers: replay · parallel: 2

$ python3 -c "import json; m=json.load(open('logs/latest/run.json')); ..."
run.parallel      = 2
envApplied        = ['run.parallel']
configFrom        = None
```

The flag wins. `run.json` records both the resolved value **and** that the
environment participated, so "why is this 2?" is answerable from the file
without re-deriving the chain.

---

## 7. Exit criterion 5 — a corrupted config reports everything and runs nothing

```console
$ cat config.yaml
run:
  paralel: 8
  keepArtifacts: sometimes
backend:
  binary: /definitely/not/here/amiro-server

$ ./amirotest run --surface backend --feature smoke
amirotest: 3 configuration errors:
  - tests/config.yaml:2: unknown key "run.paralel" (did you mean "parallel"?)
  - run.keepArtifacts: "sometimes" is not valid (want one of: always, on-failure, never)
  - backend.binary: /definitely/not/here/amiro-server does not exist

Nothing was run. Every key in config.yaml is optional -- deleting the offending line is always a valid fix.

$ echo $?
2

$ ls logs
ls: cannot access 'logs': No such file or directory
```

Three distinct classes of problem — unknown key, bad enum, missing path —
reported together, with a line number and a suggestion on the one that has
them. And the absent `logs/` directory is the load-bearing part: exit code 2
means *nothing was minted and nothing was spawned*, not "it failed partway".

(The exit code is read from a compiled binary. `go run` reports its own
status of 1 and prints `exit status 2` to stderr, which would obscure the
distinction between exit codes 1, 2 and 3 that the whole scheme rests on.)

---

## 8. Exit criterion 6 — concurrent backends collide on nothing

```console
$ go test ./suites/meta/ -run TestBackends_StartedConcurrentlyDoNotCollide -v
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide
=== PAUSE TestBackends_StartedConcurrentlyDoNotCollide/first
=== PAUSE TestBackends_StartedConcurrentlyDoNotCollide/second
=== CONT  TestBackends_StartedConcurrentlyDoNotCollide/first
=== CONT  TestBackends_StartedConcurrentlyDoNotCollide/second
--- PASS: TestBackends_StartedConcurrentlyDoNotCollide (0.00s)
    --- PASS: TestBackends_StartedConcurrentlyDoNotCollide/first (0.71s)
    --- PASS: TestBackends_StartedConcurrentlyDoNotCollide/second (0.71s)
PASS
ok  	amiro/tests/suites/meta	0.718s
```

Two real servers, overlapping, asserting distinct port, app-data directory
and database.

---

## 9. Exit criterion 7 — `list` prints every address

```console
$ ./amirotest list
meta
  meta/meta  (11 tests)
      meta/meta/TestBackends_StartedConcurrentlyDoNotCollide
      meta/meta/TestConfigExample_MatchesTheDefaults
      meta/meta/TestConfigExample_ParsesBackToExactlyTheDefaults
      meta/meta/TestConfig_MissingFileIsAValidConfiguration
      meta/meta/TestEveryTestAddressIsUnique
      meta/meta/TestLogs_ContainNoConfiguredSecretInTheClear
      meta/meta/TestNoTestImportsTheApplicationModule
      meta/meta/TestRedactor_ReplacesAPasswordSentThroughTheRealAPI
      meta/meta/TestSuitesDoNotImportEachOther
      meta/meta/TestSuitesDoNotSleep
      meta/meta/TestTeardown_LeavesNoProcessAndNoBoundPort

backend
  backend/smoke  (3 tests)
      backend/smoke/TestBackend_BuildsStartsAndAnswersHealth
      backend/smoke/TestRun_ProducesACompleteArtifactTree
      backend/smoke/TestSeed_MakesTheFirstAccountAdminAndTheOthersPlainUsers

14 tests across 2 features.
```

---

## 10. A full default run — and what it says about the surfaces that do not exist

```console
$ ./amirotest run
run 2026-08-19T08-21-14Z-685d12
  providers: replay · parallel: 4

── meta ──
ok  	amiro/tests/suites/meta	0.703s
── backend ──
ok  	amiro/tests/suites/backend/smoke	0.592s

# Amiro test run 2026-08-19T08-21-14Z-685d12

**PASSED** · 15 passed · 0 failed · 0 skipped · 3.3s
Started 2026-08-19T08:21:14Z · selection: --surface meta,backend,tui,ui,desktop · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |      3 |      0 |       0 |    583ms |
| meta    |     12 |      0 |       0 |    869ms |

- **tui** did not run: no suite exists yet under suites/tui/
- **ui** did not run: no suite exists yet under ui/specs/
- **desktop** did not run: no suite exists yet under suites/desktop/

Artifacts: tests/logs/2026-08-19T08-21-14Z-685d12
```

Those last three lines are the point. A selected surface that contributed
nothing has to say so; "ui: 0 tests" reading as green when there is no UI
suite at all is the single failure mode a test system must not have.

---

## 11. The merged timeline

```console
$ ./amirotest report --timeline \
    --test 'backend/smoke/TestBackend_BuildsStartsAndAnswersHealth'
08:21:17.195  backend  test      started  {"id":"backend-smoke-TestBackend_BuildsStartsAndAnswersHealth","tags":["smoke"]}
08:21:17.209  backend  process   spawn  {"name":"server","path":"~/.cache/amiro-tests/bin/server-3f9c1ec5ddfc4b08","pid":56578}
08:21:17.299  backend  process   ready  {"matched":"PORT=","name":"server","value":"36833"}
08:21:17.300  backend  process   backend ready  {"appDataDir":"tests/logs/.../appdata","driver":"sqlite","pid":56578,"url":"http://127.0.0.1:36833"}
08:21:17.304  backend  http      GET /health  {"ms":3,"status":200}
08:21:17.314  backend  process   stopped  {"graceful":true,"name":"server"}
08:21:17.315  backend  process   backend stopped  {"exitCode":0,"port":36833}
08:21:17.315  backend  test      passed  {}
```

Spawn → `PORT=` parsed → healthy → one request → graceful stop → port
released, on one clock. That is what a UI failure will be diagnosed against
once the browser is appending to the same file.

---

## 12. Redaction, end to end

One line of `http.ndjson` from the registration the seeder performs,
pretty-printed:

```json
{
  "method": "POST",
  "path": "/api/auth/register",
  "request": {
    "email": "admin@amiro.test",
    "name": "admin",
    "password": "<redacted:sha256:cc32eb88>"
  },
  "response": {
    "token": "<redacted:sha256:d6f6805e>",
    "user": {
      "email": "admin@amiro.test",
      "id": "151a3da2-77e6-410a-b154-f3182558a574",
      "name": "admin",
      "role": "admin"
    }
  },
  "status": 201,
  "ms": 68,
  "test": "meta/meta/TestRedactor_ReplacesAPasswordSentThroughTheRealAPI"
}
```

Both the password and the issued session token are fingerprinted; everything
else survives, because a log that redacts too much stops being useful.

Before the fix recorded in the phase document, `response.token` was in the
clear — the body was embedded as a JSON *string*, which the field-name pass
cannot see into. `suites/meta` caught it on its first run.

---

## 13. `run.json` speaks config.yaml's vocabulary

```json
{
  "config": {
    "backend": {
      "binary": "",
      "bindHost": "127.0.0.1",
      "database": { "driver": "sqlite", "dsn": "", "keepOnSuccess": false },
      "env": {},
      "port": 0,
      "startupTimeout": "30s",
      "workspaceRoot": ""
    },
    "desktop": { "startupTimeout": "1m30s", ... },
```

`bindHost`, not `BindHost`; `"30s"`, not `30000000000`. Both were wrong
initially — Go's default JSON encoding uses field names, and `time.Duration`
marshals as nanoseconds. A file whose job is answering "what was this
configured with?" has to answer in the vocabulary the user typed.

---

## 14. The guards are not vacuous

A guard that passes because it checks nothing is worse than no guard. The
config-drift check was verified by breaking it on purpose — `Parallel: 4` →
`Parallel: 6` in `defaults.go`, nothing else touched:

```console
$ go test ./suites/meta/ -run TestConfigExample_MatchesTheDefaults
    config.example.yaml has drifted from harness/config/defaults.go.
    Run `go run ./cmd/amirotest config example` and commit the result.

    first difference at line 62:
      committed:   # default: 4
      generated:   # default: 6
FAIL
```

It fails, names the drifted line, and says what to run. Reverted afterwards.

The same reasoning applies to the two leak guards, which is why
`TestRedactor_ReplacesAPasswordSentThroughTheRealAPI` asserts the
fingerprint is **present** rather than only that the password is absent — a
body that was never logged at all would satisfy the negative assertion alone
and prove nothing.

---

## 15. The whole test suite

```console
$ go test ./harness/... ./suites/...
ok  	amiro/tests/harness/apiclient	0.009s
ok  	amiro/tests/harness/assert	0.036s
ok  	amiro/tests/harness/backend	0.054s
ok  	amiro/tests/harness/config	0.012s
ok  	amiro/tests/harness/logging	0.025s
ok  	amiro/tests/harness/process	1.113s
ok  	amiro/tests/harness/run	0.567s
ok  	amiro/tests/harness/selector	0.015s
ok  	amiro/tests/suites/backend/smoke	1.313s
ok  	amiro/tests/suites/meta	1.451s

$ go vet ./...
(clean)

$ GOOS=windows go build ./... && GOOS=darwin go build ./...
(both succeed)
```

112 test functions. The Windows and darwin builds matter because
`harness/process` and `harness/logging` are the two build-tagged packages,
and the plan's Risks section was explicit that getting them right now is much
cheaper than retrofitting after four suites exist.
