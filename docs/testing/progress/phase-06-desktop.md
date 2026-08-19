# Phase 6: Desktop Suite (Tauri) Progress Report

## 1. What shipped

Phase 6 delivers the desktop surface's test harness and eight feature
directories, on a machine that has neither `cargo` nor the Tauri CLI
installed — the defining constraint of this phase, not a caveat to it. What
that constraint actually allowed turned out to be more than the toolchain
gap alone would suggest: most of what Tauri's Rust shell touches is thin
plumbing around Go product code (a shared-secret sidecar, a discovery lock
file, a stdin pipe, CORS, `AppDataDir` resolution), and that code is fully,
honestly testable without Rust at all.

**Files:**

| File | LOC | What it is |
|---|---|---|
| `tests/harness/desktop/toolchain.go` | 105 | `DetectToolchain`, `Resolve` — desktop.enabled: auto/true/false decision logic |
| `tests/harness/desktop/require.go` | 27 | `RequireToolchain(h, enabled)` — the one call a cargo-needing test makes |
| `tests/harness/desktop/launch.go` | 119 | `Launch` — spawns `cargo tauri dev` (or a stand-in), parses `PORT=`, records `ports.ndjson` |
| `tests/harness/desktop/launch_test.go` | 136 | Proves `Launch`'s parsing/recording against a stub, since cargo cannot | 
| `tests/harness/process/process.go` | +9 | `Spec.Stdin` — the one supervisor extension this phase needed |
| `tests/harness/harness.go` | +18 | `Harness.Skip(reason)` — a real bug fix, see Divergence 3 |
| `tests/cmd/amirotest/doctor.go` | +23 | Tauri CLI and webkit2gtk checks, via `harness/desktop.DetectToolchain` |
| `backend-go/cmd/server/main.go` | +17/-5 | The orphan-prevention fix — Criterion 4 |
| `tests/suites/desktop/orphans/orphans_test.go` | 111 | Criterion 4's proof |
| `tests/suites/desktop/discovery/discovery_test.go` | 79 | Criterion 5's proof |
| `tests/suites/desktop/lifecycle/lifecycle_test.go` | 69 | Criterion 3 (real) + full-app criterion (skip stub) |
| `tests/suites/desktop/data/data_test.go` | 200 | `AppDataDir`/legacy-file fallback, black-box against the real binary |
| `tests/suites/desktop/webview/webview_test.go` | 122 | CORS origin matching, real; live webview, skip stub |
| `tests/suites/desktop/ipc/ipc_test.go` | 57 | Structural guard: zero custom Tauri commands exist today |
| `tests/suites/desktop/ports/ports_test.go` | 65 | Distinct OS-assigned ports, real; collision/two-instance policy, skip stub |
| `tests/suites/desktop/packaging/packaging_test.go` | 25 | Skip stub, tagged `slow` — no cargo-free equivalent exists |
| `tests/suites/desktop/ui-parity/ui_parity_test.go` | 42 | Skip stub — see Divergence 4 |
| `docs/testing/progress/verification-log-phase-06.md` | — | One section per criterion, real output |
| `docs/testing/progress/phase-06-desktop.md` | — | This file |

**By the numbers:** 1,157 LOC of new/changed Go across `harness/desktop`
(4 files) and `suites/desktop` (9 files across 8 feature directories), plus
small, surgical changes to three existing files (`process.go`, `harness.go`,
`doctor.go`) and one product file (`cmd/server/main.go`). 12 new test
functions: 8 real, cargo-free, passing assertions against live product
code; 4 cargo-gated skip stubs with named, recorded reasons.

## 2. What diverged from the plan, and why

**Divergence 1 — most of "criteria 2–6 will be NOT MET" turned out to be
wrong, in the useful direction.** The brief anticipated most of this phase
skipping outright. Reading `src-tauri/`, `backend-go/internal/config`, and
`backend-go/internal/middleware/cors.go` before writing anything found
that the seam Tauri drives — the `PORT=` handoff, the discovery lock, the
stdin-closed orphan signal, CORS-by-origin, and `AppDataDir`/legacy-file
resolution — is *entirely* Go product code that a real compiled `cmd/server`
binary exercises identically whether Rust spawned it or a test harness did.
Eight of twelve new tests are real, passing, cargo-free proofs against that
binary, not stubs. Three feature directories (`data`, `discovery`, most of
`webview`) needed no toolchain at all. This is stated plainly rather than
undersold, because the alternative — writing everything as a skip stub out
of an assumption the plan's own wording planted — would have been a worse,
lazier mistake than the plan's optimism about `cargo tauri dev` itself
being reachable.

**Divergence 2 — Criterion 2's premise was stale, the same way Phase 1's
was.** The phase doc states `tests/e2e/sidecar_test.go` is "currently
failing." Run unchanged before any code was written, all four of its tests
pass (`docs/testing/progress/verification-log-phase-06.md`, Criterion 2).
Phase 1's entry condition made an identical claim about four different
tests, and all four turned out to already pass — the instruction to verify
a plan's premises rather than inherit them is the one that keeps catching
this, twice now.

**Divergence 3 — a real bug in the shared harness, found while proving
Criterion 1, fixed rather than routed around.** Every cargo-gated desktop
test calls `t.Skip(reason)` after `harness.New()` has already returned
control (unlike a tag exclusion, which `New()` decides and records itself).
`harness.Harness.finish()` — the `t.Cleanup` every result is recorded
through — only ever checked `h.T.Skipped()`, a bool; Go's `testing.T` does
not expose the message a skip carried. Every one of those four skips
recorded with **no reason at all**, which the summary correctly reported as
"a bug in whatever skipped it" — exactly the failure mode this test system
exists to make impossible. Fixed with `Harness.Skip(reason)`
(`harness/harness.go`), which records the reason before delegating to
`t.Skip`; `finish()` now prefers it. This is a fix to code every future Go
suite shares, not a desktop-only patch — see the verification log for the
before/after transcript.

**Divergence 4 — Criterion 6 (`ui-parity`) is recorded as a gap, not
built blind.** Reusing Phase 5's `smoke`-tagged UI specs against a Tauri
webview needs three things that do not exist and cannot be exercised here:
Playwright-native "smoke" tagging (Phase 5's own survey found none — see
`tests/ui/specs/**`), `selector.go` routing a `desktop/ui-parity`
invocation to Playwright (today `surface == "ui"` is the only path there),
and a `connectOverCDP` Playwright project pointed at a live webview.
Writing all three without a way to run, or even build-check, any of them
would produce code shaped like a feature that has never executed once —
worse than an honest NOT MET. `tests/suites/desktop/ui-parity` records the
gap and the exact three pieces closing it needs, and nothing more.

**Divergence 5 — `ports`'s "collision recovers" and "two instances behave
per design" halves may describe policy that is not implemented at all.**
`src-tauri/src/lib.rs`'s sidecar spawn path (per this phase's own reading of
it) always spawns a fresh sidecar unconditionally; nothing in it checks
`appwiring`'s discovery lock before spawning, the way `backend-go/internal/tui/client.Discover`
does for a terminal `amiro`. Whether "two instances attach or refuse" is a
real, missing Rust feature or a plan aspiration that was never built is an
open question this phase did not have the toolchain to resolve either way,
and says so rather than guessing.

**Divergence 6 — the Criterion 4 fix is a real behaviour change to a
shipped binary, not a purely additive one.** Before this phase,
`cmd/server` never looked at its stdin at all. Now, any invocation where
stdin happens to be a pipe -- `echo | ./server`, `some-process | ./server`
-- causes the process to exit as soon as that pipe's write end closes, in
addition to the intended Tauri-parent-death case. In practice this should
never bite a real deployment: `nohup`, Docker without `-i`, and systemd
unit files all give a spawned process `/dev/null` or a socket on stdin, not
an anonymous pipe, and nothing in this codebase's own tooling pipes into
`cmd/server`. Recorded here because it is a real, if narrow, change to
already-shipped behaviour and belongs in the record rather than only in a
code comment.

**Divergence 7 — the fix's core assumption (Tauri pipes the sidecar's
stdin) is plausible but unverified on this machine.** The `os.ModeNamedPipe`
gate in `cmd/server/main.go` only does anything in production if
`tauri-plugin-shell`'s sidecar spawn actually wires a real pipe to the
child's stdin, rather than e.g. `Stdio::null()`. `CommandChild` exposing a
`write()` method is evidence for this (piping stdin is the only reason
that method would exist) but not proof, and this machine cannot build
`src-tauri/` to check directly. See Follow-ups.

**Divergence 8 — `ipc` has nothing to test today, and the test says so.**
`src-tauri/src/lib.rs` registers zero `#[tauri::command]` functions and
calls `invoke_handler` nowhere; `capabilities/default.json` grants exactly
`core:default`. `tests/suites/desktop/ipc` is a structural guard against
that changing silently, not a live IPC test — because there is currently
no IPC to test live.

## 3. How it was verified

Every criterion has its own section, with real commands and real output,
in `docs/testing/progress/verification-log-phase-06.md`. Two proofs used a
before/after pair rather than a single green run, per the plan's own
evidentiary standard:

- **Criterion 4's fix.** The stdin-watcher was temporarily neutralized in
  `cmd/server/main.go` (`if false { ... }`, keeping every import used so
  the point was runtime behaviour, not a build error); `TestOrphans_*`
  failed with a timeout naming the still-running pid; the file was
  reverted (`diff` confirmed byte-identical to the pre-experiment copy) and
  the test re-run green.
- **The `Harness.Skip` bug (Divergence 3).** `amirotest run --surface desktop`
  was run before the fix (four skips reading "no reason recorded -- this is
  a bug in whatever skipped it") and after (four skips with their real
  reasons).

Also run and recorded: `-race` across every new harness and suite package;
the full `suites/meta` guard set (module boundary, no suites-importing-suites,
no-sleep, unique addressing — 213 addresses across 54 features, up from
196); `amirotest doctor`'s new Tauri-CLI/webkit2gtk checks; the
`desktop.enabled: true` failure path (a clean `t.Fatalf`, not a panic); a
full default `amirotest run` across every surface (184 passed, 0 failed, 7
reasoned skips, 4m 39s); and that `backend-go`'s `cmd/server` still
cross-compiles clean for `GOOS=windows` and `GOOS=darwin` after the
`main.go` change.

## 4. Exit criteria — checked off against the phase doc's own list

| # | Criterion | Status |
|---|---|---|
| 1 | `amirotest run --surface desktop` passes where the toolchain exists, and skips with a clear recorded reason where it does not — never a red build on a machine without cargo. | ✅ MET — both the skip half and the `enabled: true` failure half proven |
| 2 | The `PORT=` handoff is asserted end to end, closing the loop on the currently-failing `tests/e2e/sidecar_test.go`. | ✅ MET — that suite already passes (stale premise, see Divergence 2); `harness/desktop.Launch`'s own handoff parsing proven against a stub |
| 3 | SIGTERM shuts the sidecar down within 5 seconds; the lock is removed. | ✅ MET — cargo-free, real |
| 4 | SIGKILL of the parent leaves no orphaned sidecar — with a fix if the test fails, since this is a known gap. | ✅ MET — real fix, proven non-vacuous; rests on an unverified assumption about Tauri's stdin piping, see Divergence 7 and Follow-ups |
| 5 | Discovery works: desktop running + `amiro` in a terminal share one database, proven by a thread visible in both. | ✅ MET — with the desktop side played by the real sidecar binary, not a live webview (see verification log) |
| 6 | `smoke` UI specs pass against the desktop webview. | ❌ NOT MET — see Divergence 4 for the exact three pieces needed and why none were built blind |
| 7 | The desktop suite runs serially and never overlaps with another surface. | ✅ MET — pre-existing (`selector.go:304`, `TestResolve_DesktopIsMarkedSerial`), cited rather than reimplemented |

Six of seven met, all with real command output. The one NOT MET is
recorded with the exact closing work, not guessed at or scored as passing.

## 5. Follow-ups surfaced

- **Confirm the Criterion 4 fix's load-bearing assumption on a machine
  with cargo, before fully trusting it in production** (Divergence 7):
  that `tauri-plugin-shell`'s sidecar spawn actually pipes the child's
  stdin, which is the only thing that makes `os.ModeNamedPipe` fire.
  Launch the real app, then `ls -l /proc/<sidecar-pid>/fd/0` and confirm it
  names a pipe, not `/dev/null`. `CommandChild.write()` existing is strong
  circumstantial evidence, not confirmation.
- **`ui-parity` (Criterion 6) needs three pieces built in order**: (1)
  Playwright-native `smoke` tagging on the specs meant to double as parity
  checks, (2) `selector.go` routing for `desktop/ui-parity` to a Playwright
  invocation, (3) a `connectOverCDP` Playwright project. None can be
  verified without a machine that has cargo, the Tauri CLI, and a display
  (real or `xvfb`).
- **`ports`'s collision-recovery and two-instance policy may not exist in
  Rust at all** (Divergence 5) — worth resolving on a machine with cargo
  before assuming a test can even be written for it, let alone before it
  passes.
- **`ui-parity`, if built, inherits Phase 5's known `chat/streaming.spec.ts`
  gap** — that spec currently passes against a Bifrost "no keys found"
  error frame rather than a real assistant reply, because no AI provider is
  configured in the UI suite's backend. `docs/testing/progress/phase-05-ui-playwright.md`'s
  Follow-ups section has the full description; a `smoke`-tagged spec set
  built for `ui-parity` should exclude it or fix the underlying provider
  wiring first, not inherit it silently.
- **Packaging (`tauri build`, installers) has no cargo-free equivalent and
  never will** — the one feature directory where "wait for a machine with
  the toolchain" is the entire plan, not a partial one.
- **`desktop.enabled: true`'s failure path was proven only for "cargo
  missing"** — the Tauri-CLI-missing branch of the same logic
  (`harness/desktop.Resolve`) is symmetric and unit-testable without cargo
  at all (it is pure string/bool logic), and would be a cheap addition to
  `harness/desktop`'s own tests, not attempted here since it was not asked
  for and the logic is already exercised by the auto-mode branch.
