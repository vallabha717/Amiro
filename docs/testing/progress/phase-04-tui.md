# Phase 4 — TUI Suite

**Status:** ✅ Complete
**Date:** 2026-08-19
**Verification Log:** [verification-log-phase-04.md](verification-log-phase-04.md)

---

## 1. What Shipped

Phase 4 delivers the complete terminal testing subsystem (`harness/pty`), supporting VT100/ANSI 24-bit color terminal emulation, asciinema v2 `.cast` stream recording, structured key logging (`keys.ndjson`), golden screen frame assertions, and all 9 TUI feature test suites under `tests/suites/tui/`.

### Artifacts Delivered

| Component | Path | Description |
|---|---|---|
| **Virtual Terminal Buffer** | `tests/harness/pty/buffer.go` | 2D VT100/ANSI screen grid supporting truecolor (24-bit RGB), 256-color, 16-color ANSI, styles (bold, italic, underline, reverse), cursor movement, scroll regions, alt screen buffers, UTF-8 rune width & CJK wide characters, and split escape sequence handling. |
| **Asciinema Cast Recorder** | `tests/harness/pty/cast.go` | Asciinema v2 `.cast` streaming recorder writing timestamped input/output events alongside terminal metadata. |
| **Key Logger** | `tests/harness/pty/keys.go` | Keystroke sequencer and NDJSON event logger (`keys.ndjson`). |
| **Non-Sleeping Waiters** | `tests/harness/pty/wait.go` | Predicate-driven screen synchronizers (`WaitForStable`, `WaitForText`, `WaitForFrame`) without `time.Sleep`. |
| **PTY Session Supervisor** | `tests/harness/pty/pty.go`, `pty_unix.go`, `pty_windows.go` | Manages child process lifecycle under a real pseudoterminal via `github.com/creack/pty`, multiplexing stdout/stderr into disk logs, virtual buffer, and cast recorder with zero swallowed creation errors. |
| **Golden Screen Assertion** | `tests/harness/assert/assert.go` (`GoldenScreen`) | Compares rendered frames with `testdata/<name>.golden`, writes unified diffs (`golden.diff`) on mismatch, and supports update mode via `--update-golden` / `AMIRO_TEST_TUI_GOLDENUPDATE=true`. |
| **Harness Integration** | `tests/harness/harness.go` | Added `h.PTY(...)`, `h.TUIBinary()`, `h.GoldenScreen(...)`, automatic `keys.json` token/secret injection, `golden.diff` artifact indexing, and PTY session teardown. |
| **9 Feature Test Suites** | `tests/suites/tui/` | All 9 feature suites: `launch`, `config`, `auth`, `chat`, `approval`, `palette`, `pickers`, `headless`, `rendering`. |

---

## 2. What Diverged from the Plan, and Why

1. **Palette Keybinding (`ctrl+p` and `/`):**
   The plan stated "`/` opens the palette". In reality `keys.DefaultChatKeyMap.Palette` is `ctrl+p` (which primes the composer with `"/"`), while typing `"/"` into the composer also brings up the palette suggestions. Both triggers are tested in `TestPalette_CtrlPAndSlashTrigger`.

2. **Flag Propagation via Environment:**
   Flags like `--update-golden`, `--mode`, `--strict-cassettes`, `--parallel`, `--keep-artifacts` set on `amirotest` were not being exported to child subprocesses by `r.Env()`. Added `AMIRO_TEST_*` exports in `tests/harness/run/run.go` and verified propagation.

3. **Status Bar Layout Line Wrapping:**
   On certain terminal geometries, status bar text can wrap at line boundaries. Test assertions wait on the primary composer prompt placeholder `"Ask Amiro"` or evaluate full multiline buffer frames.

4. **Multi-byte Rune Slicing in Fake Provider:**
   `fakeprovider/server.go` was previously chunking text using byte slicing `text[i:end]`, which severed multi-byte UTF-8 runes in mid-stream SSE deltas. Slicing was updated to operate on `[]rune(text)`.

5. **Tool Continuation Request Inbound Parsing:**
   `fakeprovider/server.go` was updated so `hasToolResult` is reset upon seeing a new `user` message, ensuring subsequent tool calls in multi-turn sessions trigger the proper tool execution flow.

---

## 3. Exit Criteria (Verbatim from Phase 4 Plan)

| # | Real Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `amirotest run --surface tui` passes in under 3 minutes. | ✅ PASS | 31 tests passed in **10.2s** (well under 3 minutes). |
| 2 | Both transports are proven: a test with a pre-started backend asserts attachment (the embedded server never starts); a test without one asserts embedding. | ✅ PASS | `TestLaunch_AttachesToRunningBackend` asserts TUI PID != lockfile PID, lockfile PID & port unchanged, and backend `/health` OK. `TestLaunch_EmbedsServerWhenNoneRunning` asserts lockfile created with TUI's PID and responds to `/health`. |
| 3 | All four permission modes are covered end to end through the TUI. | ✅ PASS | `TestApproval_AllFourPermissionModes` covers `plan` (refusal), `interactive` (prompts), `edit` (auto-allows writes, prompts commands), and `auto` (auto-allows all) end to end through PTY with file assertions. |
| 4 | All three `amiro run` exit codes are asserted. | ✅ PASS | `TestHeadless_ExitCodeContract_AllThreeCodes` asserts exit code 0 (clean success), exit code 1 (failure/invalid args), exit code 2 (suspended without `--yes`), and exit code 0 with `--yes`. |
| 5 | Every test produces a playable `.cast`. | ✅ PASS | `TestRendering_CastAndKeyLogsRecordedAndPlayable` validates Asciinema v2 header (`version 2`, valid dimensions) and streaming `o`/`i` event tuples; `pty.go` errors if cast creation fails. |
| 6 | Golden mismatches produce a readable diff without a re-run. | ✅ PASS | Proved by breaking `initial_screen.golden`: generated `golden.diff` artifact with readable unified diff and failed test with diff output. |
| 7 | `amirotest run --surface tui --feature chat` runs only the chat tests. | ✅ PASS | Command executed only the 4 tests under `suites/tui/chat` in 3.6s. |
| 8 | Zero sleeps in the suite — enforced by a `suites/meta/` grep guard. | ✅ PASS | `TestSuitesDoNotSleep` in `suites/meta/boundary_test.go` walks all test suites and asserts zero `time.Sleep` calls. |

---

## 4. Known Scope Boundaries & Follow-ups

- **Slash command palette coverage:** The palette suite covers 3 primary slash commands (`/mode`, `/threads`, `/models`) and tab completion; full verification of secondary slash commands (`/export`, `/compact`, `/settings`) is deferred to cross-surface and desktop phases.
- **PTY Platform Scoping:** Tested and validated on Linux. Windows ConPTY differences are abstracted via build tags in `pty_windows.go` and `pty_unix.go`.
