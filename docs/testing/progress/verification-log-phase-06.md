# Verification log — Phase 6 (desktop, Tauri)

Real commands, run against this machine, with their real output. This
machine has no `cargo`, no Tauri CLI, and no webkit2gtk — that is the
defining fact of this phase, not an inconvenience worked around. Where a
criterion needs the toolchain, that is stated plainly as **NOT MET**, with
the exact command that would close it once the toolchain exists.

One section per criterion, quoted **verbatim** from
[phase-06-desktop.md](../phases/phase-06-desktop.md).

## Criterion 1 — "`amirotest run --surface desktop` passes where the toolchain exists, and skips with a clear recorded reason where it does not — never a red build on a machine without cargo."

**MET**, both halves proven.

The skip half, on this machine:

```
$ go run ./cmd/amirotest run --surface desktop
── desktop ──
ok  	amiro/tests/suites/desktop/data	0.578s
ok  	amiro/tests/suites/desktop/discovery	0.819s
ok  	amiro/tests/suites/desktop/ipc	0.017s
ok  	amiro/tests/suites/desktop/lifecycle	0.186s
ok  	amiro/tests/suites/desktop/orphans	0.225s
ok  	amiro/tests/suites/desktop/packaging	0.009s
ok  	amiro/tests/suites/desktop/ports	0.264s
ok  	amiro/tests/suites/desktop/ui-parity	0.014s
ok  	amiro/tests/suites/desktop/webview	0.343s

# Amiro test run 2026-08-19T15-26-22Z-048fe5

**PASSED** · 11 passed · 0 failed · 5 skipped · 3.4s

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| desktop |     11 |      0 |       5 |     2.3s |

## Skipped

- `desktop/lifecycle/TestLifecycle_FullAppStartsSidecarAndLoadsWebview` — cargo not found on PATH; desktop.enabled=auto skips cleanly (set desktop.enabled: true to make a missing toolchain a hard failure instead)
- `desktop/packaging/TestPackaging_TauriBuildProducesAWorkingInstalledApp` — tagged "slow", which run.tags.exclude excludes
- `desktop/ports/TestPorts_CollisionRecoveryAndTwoInstancePolicy` — cargo not found on PATH; desktop.enabled=auto skips cleanly ...
- `desktop/ui-parity/TestUIParity_SmokeSpecsPassAgainstTheDesktopWebview` — cargo not found on PATH; desktop.enabled=auto skips cleanly ...
- `desktop/webview/TestWebview_RealTauriWebviewLoadsTheDashboard` — cargo not found on PATH; desktop.enabled=auto skips cleanly ...
```

The command exits 0 (`PASSED`) — no red build, exactly as the criterion
requires. `desktop`'s 11 passes are real assertions against a running
sidecar (data, discovery, ipc, lifecycle's SIGTERM half, orphans, ports'
distinct-port half, webview's CORS half) — see criteria 3–5 below.

The failure half, `desktop.enabled: true` on a machine that still has no
cargo, closing the Definition of Done's "a missing toolchain must then be a
clean failure with a useful message, not a panic":

```
$ AMIRO_TEST_DESKTOP_ENABLED=true go test ./suites/desktop/lifecycle/... -run TestLifecycle_FullApp -v
=== RUN   TestLifecycle_FullAppStartsSidecarAndLoadsWebview
    lifecycle_test.go:58: desktop.enabled is true but cargo was not found on PATH -- install the
        Rust toolchain, or set desktop.enabled: auto to skip instead of failing
--- FAIL: TestLifecycle_FullAppStartsSidecarAndLoadsWebview (0.73s)
FAIL
```

A clean `t.Fatalf` with a message naming the exact gap and the exact
override that would silence it, not a panic or a stack trace from a nil
Tauri process.

**A bug found and fixed while proving this criterion.** The first version
of every cargo-gated test called `t.Skip(reason)` directly, after
`harness.New()` had already returned. `harness.Harness.finish()` (the
`t.Cleanup` that records every result) only checks `h.T.Skipped()` — Go's
`testing.T` does not expose the message a skip was given — so every one of
those skips recorded with **no reason at all**:

```
## Skipped

- `desktop/lifecycle/TestLifecycle_FullAppStartsSidecarAndLoadsWebview` — no reason recorded -- this is a bug in whatever skipped it
- `desktop/ports/TestPorts_CollisionRecoveryAndTwoInstancePolicy` — no reason recorded -- this is a bug in whatever skipped it
- `desktop/ui-parity/TestUIParity_SmokeSpecsPassAgainstTheDesktopWebview` — no reason recorded -- this is a bug in whatever skipped it
- `desktop/webview/TestWebview_RealTauriWebviewLoadsTheDashboard` — no reason recorded -- this is a bug in whatever skipped it
```

That is exactly the failure mode `docs/testing/progress/README.md` names as
the one a test system must never have — a skip that reads as a bug because
nothing says why. `harness.Harness` gained a `Skip(reason)` method
(`harness/harness.go`) that records the reason before calling `t.Skip`, and
`finish()` now prefers it over a blank one; `harness/desktop.RequireToolchain`
was changed to take a `*harness.Harness` and call it. Re-running produced
the reasoned output quoted above. This is a fix to the shared harness, not
to anything desktop-specific — any future test that skips itself
mid-body, in Go, benefits from it.

## Criterion 2 — "The `PORT=` handoff is asserted end to end, closing the loop on the currently-failing `tests/e2e/sidecar_test.go`."

**MET — and the plan's premise was stale.** The phase doc, written before
this pass, describes `backend-go/tests/e2e/sidecar_test.go` as "currently
failing." It is not. Checked directly, unchanged, before writing anything:

```
$ cd backend-go && go test ./tests/e2e/... -run TestSidecar -v
=== RUN   TestSidecar_PrintsPortAndBindsLoopbackOnly
--- PASS: TestSidecar_PrintsPortAndBindsLoopbackOnly (2.70s)
=== RUN   TestSidecar_HealthRejectsRequestWithoutToken
--- PASS: TestSidecar_HealthRejectsRequestWithoutToken (2.64s)
=== RUN   TestSidecar_HealthReturnsOkWithValidToken
--- PASS: TestSidecar_HealthReturnsOkWithValidToken (2.72s)
=== RUN   TestSidecar_ShutsDownGracefullyOnSIGTERM
--- PASS: TestSidecar_ShutsDownGracefullyOnSIGTERM (2.69s)
PASS
ok  	amiro/backend/tests/e2e	10.757s
```

`TestSidecar_PrintsPortAndBindsLoopbackOnly` scans stdout line by line for
`PORT=`, the same rule `process.WaitForLine` documents (Bifrost's own
startup logging can precede it) and every backend test in this suite relies
on. The loop was already closed; this phase changed nothing about it. (Phase
1's entry condition made the identical kind of claim about four tests, and
all four turned out to already pass — the instruction to verify rather than
inherit such claims is exactly what caught this one too.)

What genuinely is new here: `harness/desktop.Launch` implements the same
line-by-line `PORT=` scan for a `cargo tauri dev` launch and records it to
`ports.ndjson`, proven against a stub standing in for cargo (see the
package doc comment in `harness/desktop/launch_test.go` for why a stub,
not the real thing):

```
$ go test ./harness/desktop/... -v
=== RUN   TestLaunch_ParsesPortHandoffAndRecordsPortsNDJSON
--- PASS: TestLaunch_ParsesPortHandoffAndRecordsPortsNDJSON (0.00s)
=== RUN   TestLaunch_TimesOutCleanlyWhenNoPortLineAppears
--- PASS: TestLaunch_TimesOutCleanlyWhenNoPortLineAppears (0.00s)
PASS
ok  	amiro/tests/harness/desktop	0.010s
```

The real `cargo tauri dev` end of this — Rust's own `CommandEvent::Stdout`
reader in `src-tauri/src/lib.rs` handing off to this harness code — is
**NOT MET** here. Closing command once cargo exists:
`cd tests && go test ./suites/desktop/lifecycle/... -run TestLifecycle_FullApp -v`.

## Criterion 3 — "SIGTERM shuts the sidecar down within 5 seconds; the lock is removed."

**MET**, cargo-free — this is exactly what `harness/process.Process.Stop`
already does for every backend every suite starts (SIGTERM, then a 5s
grace before SIGKILL — `process.StopGrace`), and what `cmd/server`'s own
`defer appwiring.RemoveLock(cfg.AppDataDir)` already does on any graceful
exit. `tests/suites/desktop/lifecycle` makes the lock-removal half explicit
rather than leaving it implicit in every other suite's teardown:

```
$ go test ./suites/desktop/lifecycle/... -run TestLifecycle_SIGTERM -v
=== RUN   TestLifecycle_SIGTERMRemovesTheDiscoveryLockWithinFiveSeconds
--- PASS: TestLifecycle_SIGTERMRemovesTheDiscoveryLockWithinFiveSeconds (0.65s)
PASS
ok  	amiro/tests/suites/desktop/lifecycle	0.657s
```

## Criterion 4 — "SIGKILL of the parent leaves no orphaned sidecar — with a fix if the test fails, since this is a known gap."

**MET, with a real fix**, and the one criterion this phase most needed to
get right. `cmd/server/main.go` named the gap in a comment: the Go-side
complement of Tauri's kill-on-quit was "added once the sidecar is wired
into Tauri (Phase 8)" — unwritten. It did not need cargo to close: the
mechanism is a kernel fact, not a Tauri one — a parent's fds, including the
write end of a piped child stdin, close the instant it dies, by any means,
including SIGKILL, which nothing can catch. `tests/suites/desktop/orphans`
reproduces that with `os.Pipe`, no Rust involved.

First, with the fix, green:

```
$ go test ./suites/desktop/orphans/... -run TestOrphans -v
=== RUN   TestOrphans_SidecarExitsWhenParentPipeCloses
--- PASS: TestOrphans_SidecarExitsWhenParentPipeCloses (3.22s)
PASS
ok  	amiro/tests/suites/desktop/orphans	3.220s
```

Then, proving the test is not vacuous: the fix in `cmd/server/main.go` was
temporarily neutralized (`if false { ... }` around the stdin-watcher block,
keeping imports valid so the point was the runtime behaviour, not a build
error) and the identical test re-run:

```
$ go clean -testcache && go test ./suites/desktop/orphans/... -run TestOrphans -v
=== RUN   TestOrphans_SidecarExitsWhenParentPipeCloses
    orphans_test.go:104: timed out after 5s waiting for the sidecar to notice its parent pipe
        closed and exit; last attempt: still running (pid 370694) -- the sidecar survived its
        parent's pipe closing; it would be an orphan holding port 43457 forever
--- FAIL: TestOrphans_SidecarExitsWhenParentPipeCloses (8.38s)
FAIL
```

Then reverted and re-verified clean and green:

```
$ diff /tmp/.../main.go.fixed backend-go/cmd/server/main.go && echo "reverted cleanly"
reverted cleanly
$ cd backend-go && go build ./... && echo BUILD_OK
BUILD_OK
$ cd ../tests && go clean -testcache && go test ./suites/desktop/orphans/... -run TestOrphans -v
=== RUN   TestOrphans_SidecarExitsWhenParentPipeCloses
--- PASS: TestOrphans_SidecarExitsWhenParentPipeCloses (0.65s)
PASS
```

The fix itself (`backend-go/cmd/server/main.go`): a goroutine watches
`os.Stdin` for EOF and calls the same `stop()` a caught SIGTERM would, but
only when `os.Stdin.Stat()` reports `os.ModeNamedPipe` — i.e. only when
stdin is actually a pipe, which is true when Tauri spawned this process and
never true for `exec.Cmd`'s default nulled stdin or an interactive
terminal. That gating was checked directly, not assumed: the existing
`backend-go/tests/e2e/sidecar_test.go` suite (which never wires a pipe) and
the full harness `backend` suite (`process.Start`, which also never wires
one) were re-run after the fix and are unaffected — see Criterion 2's
output above and the full-suite run in the Definition of Done section
below.

Assertion discipline: a bounded poll (`process.WaitFor`, 5s) on
`proc.Exited()`, then `process.AssertPortFree`, matching the plan's own
instruction — "assert on 'no process holding the port and no process with
the sidecar's parent pid', bounded-poll, never a fixed sleep."

**Caveat this criterion's MET status rests on, flagged in peer review and
not yet closed:** the fix's whole premise is that `tauri-plugin-shell`'s
sidecar spawn gives the child a real pipe on stdin, which is what makes
`os.ModeNamedPipe` fire in production at all. This machine cannot build
`src-tauri/` to confirm that directly. `CommandChild` exposing a `write()`
method is real evidence for it (piping stdin is the only reason that
method would exist) but is not the same as checking
`/proc/<sidecar-pid>/fd/0` on a running app. Recorded as a Follow-up in
the progress doc; do not treat this criterion as fully closed until that
check has been run once on a machine with cargo.

## Criterion 5 — "Discovery works: desktop running + `amiro` in a terminal share one database, proven by a thread visible in both."

**MET, with one honest substitution.** "Desktop running" is a directly
started `backend.Backend` rather than a live Tauri window — faithful, not
mocked: the desktop app's sidecar *is* `cmd/server`, and the discovery
protocol being proven (`appwiring.WriteLock` /
`backend-go/internal/tui/client.Discover`) is exactly what a real Tauri
launch drives. What needs cargo — the Rust process, and a webview to look
a thread up in — is not here; "visible in ... the desktop window" is
checked with a second, independent API client instead.

`tests/suites/tui/launch/attach_embed_test.go` (pre-existing, unmodified)
already proved the attach-not-embed half — same PID, same port, same lock
file, before and after the TUI launches. This phase adds the one thing
that test does not: a real thread, created through the TUI, read back over
a second client hitting the same backend.

```
$ go test ./suites/desktop/discovery/... -v
=== RUN   TestDiscovery_ThreadCreatedInTUIIsVisibleViaSharedBackend
--- PASS: TestDiscovery_ThreadCreatedInTUIIsVisibleViaSharedBackend (3.89s)
PASS
ok  	amiro/tests/suites/desktop/discovery	3.897s
```

The test drives a real chat turn through a PTY-attached `amiro`, then lists
threads with `h.As("admin")` — a second `apiclient.Client` against the
identical `be.URL` — and asserts the resulting thread and its user message
are visible there. That is the criterion's actual content (one database,
two front-ends); a live webview screenshot is not needed to prove it.

## Criterion 6 — "`smoke` UI specs pass against the desktop webview."

**NOT MET.** No cargo-free equivalent exists or was attempted — see
`tests/suites/desktop/ui-parity/ui_parity_test.go`'s package doc comment
for the three separate pieces of unverifiable-here machinery this would
need (Playwright-native "smoke" tagging, which does not exist anywhere in
the UI suite today per Phase 5's own survey; `selector.go` routing a
`desktop/ui-parity` invocation to Playwright, which today only ever
happens for `surface == "ui"`; and a Playwright project using
`connectOverCDP` against a live Tauri webview). Writing all three without
any way to run or debug them would produce code that looks like a feature
and has never executed — recorded as a gap instead. Closing command, once
cargo, the Tauri CLI and a display are present:
`cd tests && go test ./suites/desktop/ui-parity/... -v` after implementing
the three pieces above.

```
$ go test ./suites/desktop/ui-parity/... -v
=== RUN   TestUIParity_SmokeSpecsPassAgainstTheDesktopWebview
    ui_parity_test.go:37: cargo not found on PATH; desktop.enabled=auto skips cleanly ...
--- SKIP: TestUIParity_SmokeSpecsPassAgainstTheDesktopWebview (0.58s)
PASS
```

## Criterion 7 — "The desktop suite runs serially and never overlaps with another surface."

**MET, and pre-existing** — `harness/selector/selector.go:304` already
marks `Serial: true` whenever `surface == "desktop"` in `goInvocation`, and
`harness/selector/selector_test.go:158` (`TestResolve_DesktopIsMarkedSerial`)
already asserts it:

```go
func TestResolve_DesktopIsMarkedSerial(t *testing.T) {
	cat, _ := Discover(tree(t, map[string]string{"suites/desktop/lifecycle/x_test.go": goSuite}))
	inv, _, err := Resolve(Selection{}, cat)
	if !inv[0].Serial {
		t.Error("the desktop surface must be serial: it binds a real window, and overlapping instances fight")
	}
}
```

```
$ go test ./harness/selector/... -run TestResolve_DesktopIsMarkedSerial -v
=== RUN   TestResolve_DesktopIsMarkedSerial
--- PASS: TestResolve_DesktopIsMarkedSerial (0.00s)
PASS
```

This did not need writing; it needed citing. Before this phase the test
ran against a *fake* `suites/desktop/` tree built by the test itself
(`suites/desktop/` did not exist on disk). Now that real desktop suites
exist, `TestEveryTestAddressIsUnique` below covers the addressing side, and
`amirotest run --surface desktop`'s own single, non-overlapping `go test`
invocation (see Criterion 1's transcript — one `── desktop ──` block, run
after `meta`/`backend`/`tui`/`ui` in `selector.Order`) covers the
non-overlap side for real.

## Required, not among the seven criteria

**`-race` on every new Go harness package**, per the plan's verification
discipline:

```
$ go test ./harness/desktop/... ./harness/process/... ./suites/desktop/... -race
ok  	amiro/tests/harness/desktop	1.055s
ok  	amiro/tests/harness/process	2.129s
ok  	amiro/tests/suites/desktop/data	2.163s
ok  	amiro/tests/suites/desktop/discovery	2.439s
ok  	amiro/tests/suites/desktop/ipc	1.812s
ok  	amiro/tests/suites/desktop/lifecycle	2.270s
ok  	amiro/tests/suites/desktop/orphans	2.262s
ok  	amiro/tests/suites/desktop/packaging	2.036s
ok  	amiro/tests/suites/desktop/ports	2.106s
ok  	amiro/tests/suites/desktop/ui-parity	1.645s
ok  	amiro/tests/suites/desktop/webview	1.978s
```

**Meta guards, full**, confirming the new suites do not break addressing,
the sleep guard, the module boundary, or route coverage:

```
$ go test ./suites/meta/... -v
--- PASS: TestNoTestImportsTheApplicationModule (0.64s)
--- PASS: TestSuitesDoNotImportEachOther (0.01s)
--- PASS: TestSuitesDoNotSleep (0.03s)
--- PASS: TestEveryTestAddressIsUnique (0.01s)
    boundary_test.go:165: 213 unique addresses across 54 features
--- PASS: TestConfigExample_MatchesTheDefaults (0.00s)
--- PASS: TestConfigExample_ParsesBackToExactlyTheDefaults (0.00s)
--- PASS: TestConfig_MissingFileIsAValidConfiguration (0.00s)
--- PASS: TestTeardown_LeavesNoProcessAndNoBoundPort (0.10s)
--- PASS: TestBackends_StartedConcurrentlyDoNotCollide (0.00s)
--- PASS: TestRouteCoverageGuard (0.02s)
    route_coverage_test.go:279: Route coverage: 101 total routes in router.go (101 covered, 0 waived, 0 uncovered)
--- PASS: TestLogs_ContainNoConfiguredSecretInTheClear (0.00s)
--- PASS: TestRedactor_ReplacesAPasswordSentThroughTheRealAPI (0.31s)
--- PASS: TestUISpecs_DoNotUseHardcodedWaits (0.00s)
--- PASS: TestUISpecs_GuardIsNonVacuous (0.00s)
PASS
ok  	amiro/tests/suites/meta	1.287s
```

(213 addresses, up from 196 before this phase: 12 new desktop tests plus
one lock-removal assertion folded into an existing feature's count.)

**`amirotest doctor`**, extended for cargo, the Tauri CLI, and webview
deps (`checkWebviewDeps`, `pkg-config --modversion webkit2gtk-4.1`/`-4.0`
on Linux):

```
$ go run ./cmd/amirotest doctor
  ✓ go     go version go1.26.5 linux/amd64
  ✓ node   v22.23.2
  ✓ pnpm   11.21.0
  - cargo  not found
           the desktop surface needs it; desktop.enabled: auto means it skips, not fails
  ✓ git    git version 2.54.0
  - tauri  not checked (cargo missing)
           the desktop surface needs it
  - webview webkit2gtk not found via pkg-config
           only checked on Linux; a packaged build will fail without it
  ✓ chromium ...
  ✓ bundle backend-go/internal/web/dist (ready for embedui)
Ready. Anything marked - above causes a surface to skip itself with a recorded reason, not to fail.
```

## Full default run

`meta`, `backend`, `tui`, `ui`, `desktop` together — `cross` (Phase 7) does
not exist yet:

```
$ go run ./cmd/amirotest run
**PASSED** · 184 passed · 0 failed · 7 skipped · 4m 39s

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| backend |    103 |      0 |       1 |   1m 48s |
| desktop |     11 |      0 |       5 |     4.6s |
| meta    |     14 |      0 |       0 |    724ms |
| tui     |     31 |      0 |       0 |    21.5s |
| ui      |     25 |      0 |       1 |  10m 55s |
```

All seven skips are reasoned (Postgres/`live`, `packaging`'s `slow` tag,
five desktop toolchain skips). Zero failures, zero silent zero-test passes.

## Cross-compilation

`backend-go`'s `cmd/server` still cross-compiles clean after the
`os.Stdin`/`io` changes in `main.go`:

```
$ cd backend-go && GOOS=windows GOARCH=amd64 go build -o /dev/null ./cmd/server/...
$ echo $?
0
$ GOOS=darwin GOARCH=arm64 go build -o /dev/null ./cmd/server/...
$ echo $?
0
```
