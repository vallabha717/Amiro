# Verification Log — Phase 4 (TUI Suite)

**Date:** 2026-08-19
**Run ID:** 2026-08-19T12-52-45Z-8df386

---

## Criterion 1: `amirotest run --surface tui` passes in under 3 minutes

```
$ go run ./cmd/amirotest run --surface tui
run 2026-08-19T12-52-45Z-8df386
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-19T12-52-45Z-8df386
  providers: replay · parallel: 4

── tui ──
ok      amiro/tests/suites/tui/approval 3.677s
ok      amiro/tests/suites/tui/auth     1.825s
ok      amiro/tests/suites/tui/chat     3.957s
ok      amiro/tests/suites/tui/config   2.662s
ok      amiro/tests/suites/tui/headless 3.077s
ok      amiro/tests/suites/tui/launch   2.245s
ok      amiro/tests/suites/tui/palette  0.948s
ok      amiro/tests/suites/tui/pickers  0.528s
ok      amiro/tests/suites/tui/rendering        2.384s

# Amiro test run 2026-08-19T12-52-45Z-8df386

**PASSED** · 31 passed · 0 failed · 0 skipped · 10.2s
Started 2026-08-19T12:52:45Z · selection: --surface tui · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| tui     |     31 |      0 |       0 |    21.1s |

Artifacts: /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-19T12-52-45Z-8df386
```

---

## Criterion 2: Both Transports Proven (Attach vs Embed)

```
$ go test -v ./suites/tui/launch -run "TestLaunch_AttachesToRunningBackend|TestLaunch_EmbedsServerWhenNoneRunning"
=== RUN   TestLaunch_AttachesToRunningBackend
--- PASS: TestLaunch_AttachesToRunningBackend (0.94s)
=== RUN   TestLaunch_EmbedsServerWhenNoneRunning
--- PASS: TestLaunch_EmbedsServerWhenNoneRunning (0.17s)
PASS
ok      amiro/tests/suites/tui/launch   1.109s
```

- **Attachment assertion:** TUI PID != Lockfile PID, lockfile PID and port remain unchanged (embedded server never started), and backend responds to `/health`.
- **Embedding assertion:** Lockfile created in fresh directory with TUI's PID, and embedded server responds to `/health` on its bound port.

---

## Criterion 3: All Four Permission Modes Covered End to End

```
$ go test -v ./suites/tui/approval -run TestApproval_AllFourPermissionModes
=== RUN   TestApproval_AllFourPermissionModes
=== RUN   TestApproval_AllFourPermissionModes/plan_mode_refuses_write_tools
=== RUN   TestApproval_AllFourPermissionModes/interactive_mode_gates_writes
=== RUN   TestApproval_AllFourPermissionModes/edit_mode_auto-allows_writes_and_gates_commands
=== RUN   TestApproval_AllFourPermissionModes/auto_mode_auto-allows_all_consequential_actions
--- PASS: TestApproval_AllFourPermissionModes (1.06s)
    --- PASS: TestApproval_AllFourPermissionModes/plan_mode_refuses_write_tools (0.43s)
    --- PASS: TestApproval_AllFourPermissionModes/interactive_mode_gates_writes (0.18s)
    --- PASS: TestApproval_AllFourPermissionModes/edit_mode_auto-allows_writes_and_gates_commands (0.22s)
    --- PASS: TestApproval_AllFourPermissionModes/auto_mode_auto-allows_all_consequential_actions (0.13s)
PASS
ok      amiro/tests/suites/tui/approval 2.818s
```

And interactive approval dialog actions (`y` once, `n` deny, `a` always):

```
$ go test -v ./suites/tui/approval -run TestApproval_ApproveDialogInteractions
=== RUN   TestApproval_ApproveDialogInteractions
=== RUN   TestApproval_ApproveDialogInteractions/approve_once_with_y
=== RUN   TestApproval_ApproveDialogInteractions/deny_with_n
=== RUN   TestApproval_ApproveDialogInteractions/always_allow_with_a
--- PASS: TestApproval_ApproveDialogInteractions (1.76s)
    --- PASS: TestApproval_ApproveDialogInteractions/approve_once_with_y (0.45s)
    --- PASS: TestApproval_ApproveDialogInteractions/deny_with_n (0.26s)
    --- PASS: TestApproval_ApproveDialogInteractions/always_allow_with_a (0.39s)
PASS
```

---

## Criterion 4: All Three `amiro run` Exit Codes Asserted

```
$ go test -v ./suites/tui/headless -run TestHeadless_ExitCodeContract_AllThreeCodes
=== RUN   TestHeadless_ExitCodeContract_AllThreeCodes
=== RUN   TestHeadless_ExitCodeContract_AllThreeCodes/exit_0_success
=== RUN   TestHeadless_ExitCodeContract_AllThreeCodes/exit_2_suspended_without_--yes
=== RUN   TestHeadless_ExitCodeContract_AllThreeCodes/exit_0_with_--yes_auto-approval
=== RUN   TestHeadless_ExitCodeContract_AllThreeCodes/exit_1_on_invalid_arguments
--- PASS: TestHeadless_ExitCodeContract_AllThreeCodes (1.23s)
    --- PASS: TestHeadless_ExitCodeContract_AllThreeCodes/exit_0_success (0.50s)
    --- PASS: TestHeadless_ExitCodeContract_AllThreeCodes/exit_2_suspended_without_--yes (0.25s)
    --- PASS: TestHeadless_ExitCodeContract_AllThreeCodes/exit_0_with_--yes_auto-approval (0.31s)
    --- PASS: TestHeadless_ExitCodeContract_AllThreeCodes/exit_1_on_invalid_arguments (0.05s)
PASS
ok      amiro/tests/suites/tui/headless 1.235s
```

---

## Criterion 5: Every Test Produces a Playable `.cast`

```
$ go test -v ./suites/tui/rendering -run TestRendering_CastAndKeyLogsRecordedAndPlayable
=== RUN   TestRendering_CastAndKeyLogsRecordedAndPlayable
--- PASS: TestRendering_CastAndKeyLogsRecordedAndPlayable (0.86s)
PASS
ok      amiro/tests/suites/tui/rendering        0.862s
```

Asserted:
- Valid Asciinema v2 header (`version 2`, width, height).
- Valid event tuples with `o` (output) and `i` (input).
- Valid `keys.ndjson` with timestamped `KeyEvent` records.

---

## Criterion 6: Golden Mismatch Readable Diff Without Re-run

Intentionally breaking `initial_screen.golden`:

```
$ go test -v ./suites/tui/rendering -run TestRendering_InitialScreenGolden
=== RUN   TestRendering_InitialScreenGolden
    rendering_test.go:144: golden mismatch: testdata/initial_screen.golden
        --- want
        +++ got
        -   1 CORRUPTED GOLDEN TEXT
        +   1 
        -   2 LINE 2 MISMATCH
        +   2 
        +  19 > Ask Amiro…
        +  20                                                                               >
        +  22                                                                             >
--- FAIL: TestRendering_InitialScreenGolden (0.80s)
FAIL
```

Artifact `golden.diff` produced at `logs/.../golden.diff`:

```diff
--- want
+++ got
-   1 CORRUPTED GOLDEN TEXT
+   1 
-   2 LINE 2 MISMATCH
+   2 
+  19 > Ask Amiro…
+  20                                                                               >
+  22                                                                             >
```

---

## Criterion 7: Feature Filter Selection (`--feature chat`)

```
$ go run ./cmd/amirotest run --surface tui --feature chat
run 2026-08-19T12-51-43Z-3331b5
  /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-19T12-51-43Z-3331b5
  providers: replay · parallel: 4

── tui ──
ok      amiro/tests/suites/tui/chat     2.335s

# Amiro test run 2026-08-19T12-51-43Z-3331b5

**PASSED** · 4 passed · 0 failed · 0 skipped · 3.6s
Started 2026-08-19T12:51:43Z · selection: --surface tui --feature chat · providers: replay

| Surface | Passed | Failed | Skipped | Duration |
|---------|--------|--------|---------|----------|
| tui     |      4 |      0 |       0 |     2.3s |

Artifacts: /home/shrivallabha_somayaji_tyson_com/Projects/Personal/Amiro/tests/logs/2026-08-19T12-51-43Z-3331b5
```

---

## Criterion 8: Zero Sleeps Enforced by Meta Guard

```
$ go test -v ./suites/meta/... -run TestSuitesDoNotSleep
=== RUN   TestSuitesDoNotSleep
--- PASS: TestSuitesDoNotSleep (0.03s)
PASS
ok      amiro/tests/suites/meta 0.041s
```

---

## Race Detector & Stability (`go test -race -count=5 ./suites/tui/...`)

```
$ go test -race -count=5 ./suites/tui/...
ok      amiro/tests/suites/tui/approval 24.993s
ok      amiro/tests/suites/tui/auth     11.014s
ok      amiro/tests/suites/tui/chat     23.074s
ok      amiro/tests/suites/tui/config   14.380s
ok      amiro/tests/suites/tui/headless 18.671s
ok      amiro/tests/suites/tui/launch   14.199s
ok      amiro/tests/suites/tui/palette  6.342s
ok      amiro/tests/suites/tui/pickers  4.137s
ok      amiro/tests/suites/tui/rendering        15.415s
```

Zero data races and 100% stable across 5 consecutive iterations under `-race`.
