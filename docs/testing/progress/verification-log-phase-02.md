# Verification Log — Phase 2: Backend API Suite

Run on: Linux 6.6.137+ #1 SMP PREEMPT_DYNAMIC Sun May 10 08:47:40 UTC 2026 x86_64  
Go: go1.24.0 linux/amd64  
Repository: `/home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro`

---

## 1. Clean module race detection run (`go test -race ./...`)

```
$ cd tests && go test -race ./...
?   	amiro/tests/cmd/amirotest       	[no test files]
?   	amiro/tests/harness             	[no test files]
ok  	amiro/tests/harness/apiclient   	1.055s
ok  	amiro/tests/harness/assert      	1.059s
ok  	amiro/tests/harness/backend     	1.114s
ok  	amiro/tests/harness/config      	1.044s
ok  	amiro/tests/harness/logging     	1.107s
ok  	amiro/tests/harness/process     	2.143s
ok  	amiro/tests/harness/run         	1.828s
?   	amiro/tests/harness/seed        	[no test files]
ok  	amiro/tests/harness/selector    	1.057s
ok  	amiro/tests/suites/backend/admin	3.857s
ok  	amiro/tests/suites/backend/agent	4.038s
ok  	amiro/tests/suites/backend/archive	3.861s
ok  	amiro/tests/suites/backend/auth 	4.699s
ok  	amiro/tests/suites/backend/bookmark	3.781s
ok  	amiro/tests/suites/backend/config	2.357s
ok  	amiro/tests/suites/backend/export	3.989s
ok  	amiro/tests/suites/backend/lifecycle	3.034s
ok  	amiro/tests/suites/backend/matrix	4.546s
ok  	amiro/tests/suites/backend/mcp  	4.394s
ok  	amiro/tests/suites/backend/migration	2.930s
ok  	amiro/tests/suites/backend/models	2.587s
ok  	amiro/tests/suites/backend/providers	3.085s
ok  	amiro/tests/suites/backend/search	3.925s
ok  	amiro/tests/suites/backend/smoke 	3.200s
ok  	amiro/tests/suites/backend/storage	3.844s
ok  	amiro/tests/suites/backend/thread	5.725s
ok  	amiro/tests/suites/backend/user 	5.059s
ok  	amiro/tests/suites/backend/workflow	3.828s
ok  	amiro/tests/suites/meta         	3.680s
```

---

## 2. Full backend surface execution via `amirotest`

```
$ go run ./cmd/amirotest run --surface backend
run 2026-08-19T08-50-27Z-b0c1f9
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-19T08-50-27Z-b0c1f9
  providers: replay · parallel: 4

── backend ──
ok      amiro/tests/suites/backend/admin        2.205s
ok      amiro/tests/suites/backend/agent        1.445s
ok      amiro/tests/suites/backend/archive      1.385s
ok      amiro/tests/suites/backend/auth         2.503s
ok      amiro/tests/suites/backend/bookmark     1.997s
ok      amiro/tests/suites/backend/config       0.266s
ok      amiro/tests/suites/backend/export       2.063s
ok      amiro/tests/suites/backend/lifecycle    0.819s
ok      amiro/tests/suites/backend/matrix       2.078s
ok      amiro/tests/suites/backend/mcp          2.423s
ok      amiro/tests/suites/backend/migration    0.901s
ok      amiro/tests/suites/backend/models       0.799s
ok      amiro/tests/suites/backend/providers    0.883s
ok      amiro/tests/suites/backend/search       1.952s
ok      amiro/tests/suites/backend/smoke        1.125s
ok      amiro/tests/suites/backend/storage      2.265s
ok      amiro/tests/suites/backend/thread       3.183s
ok      amiro/tests/suites/backend/user         2.309s
ok      amiro/tests/suites/backend/workflow     1.313s

# Amiro test run 2026-08-19T08-50-27Z-b0c1f9

**PASSED** · 70 passed · 0 failed · 1 skipped · 13.9s
Started 2026-08-19T08:50:27Z · selection: --surface backend · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |     70 |      0 |       1 |    31.4s |

## Skipped
- `backend/migration/TestMigration_PostgresSchemaHandlingAndSkip` — tagged "live", which run.tags.exclude excludes
```

---

## 3. Fast targeted execution (`--feature auth`)

```
$ go run ./cmd/amirotest run --surface backend --feature auth
run 2026-08-19T08-50-46Z-d02237
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-19T08-50-46Z-d02237
  providers: replay · parallel: 4

── backend ──
ok      amiro/tests/suites/backend/auth 1.356s

# Amiro test run 2026-08-19T08-50-46Z-d02237

**PASSED** · 6 passed · 0 failed · 0 skipped · 2.6s
Started 2026-08-19T08:50:46Z · selection: --surface backend --feature auth · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |      6 |      0 |       0 |     1.3s |
```

---

## 4. Concurrency equivalence (`--parallel 1` vs `--parallel 8`)

`--parallel 1`:
```
**PASSED** · 70 passed · 0 failed · 1 skipped · 13.5s
```

`--parallel 8`:
```
**PASSED** · 70 passed · 0 failed · 1 skipped · 13.6s
```

---

## 5. Meta guards & Route Coverage

```
$ go test -v ./suites/meta/...
=== RUN   TestNoTestImportsTheApplicationModule
--- PASS: TestNoTestImportsTheApplicationModule (0.60s)
=== RUN   TestSuitesDoNotImportEachOther
--- PASS: TestSuitesDoNotImportEachOther (0.00s)
=== RUN   TestSuitesDoNotSleep
--- PASS: TestSuitesDoNotSleep (0.02s)
=== RUN   TestEveryTestAddressIsUnique
    boundary_test.go:165: 85 unique addresses across 20 features
--- PASS: TestEveryTestAddressIsUnique (0.00s)
=== RUN   TestConfigExample_MatchesTheDefaults
--- PASS: TestConfigExample_MatchesTheDefaults (0.00s)
=== RUN   TestConfigExample_ParsesBackToExactlyTheDefaults
--- PASS: TestConfigExample_ParsesBackToExactlyTheDefaults (0.00s)
=== RUN   TestConfig_MissingFileIsAValidConfiguration
--- PASS: TestConfig_MissingFileIsAValidConfiguration (0.00s)
=== RUN   TestTeardown_LeavesNoProcessAndNoBoundPort
--- PASS: TestTeardown_LeavesNoProcessAndNoBoundPort (0.18s)
=== RUN   TestBackends_StartedConcurrentlyDoNotCollide
--- PASS: TestBackends_StartedConcurrentlyDoNotCollide (0.00s)
=== RUN   TestRouteCoverageGuard
    route_coverage_test.go:236: Route coverage: 101 total routes in router.go (92 covered, 9 waived, 0 uncovered)
--- PASS: TestRouteCoverageGuard (0.01s)
=== RUN   TestLogs_ContainNoConfiguredSecretInTheClear
--- PASS: TestLogs_ContainNoConfiguredSecretInTheClear (0.00s)
=== RUN   TestRedactor_ReplacesAPasswordSentThroughTheRealAPI
--- PASS: TestRedactor_ReplacesAPasswordSentThroughTheRealAPI (0.33s)
PASS
ok      amiro/tests/suites/meta 1.367s
```

---

## 6. Formatting & Cross-Compilation

```
$ gofmt -l .
(empty)

$ go vet ./...
(clean, 0 warnings)

$ GOOS=windows go test -c -o /dev/null ./suites/meta/... ./suites/backend/...
(clean, 0 errors)

$ GOOS=darwin go test -c -o /dev/null ./suites/meta/... ./suites/backend/...
(clean, 0 errors)
```
