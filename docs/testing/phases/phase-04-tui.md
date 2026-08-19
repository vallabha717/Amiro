# Phase 4 — TUI suite

> **Shipped 2026-08-19.** See [progress/phase-04-tui.md](../progress/phase-04-tui.md) for what was built, what diverged, and the verification log.

**Depends on:** 1, 3 · **Blocks:** 7 · **Size:** M

Drive the real `amiro` binary under a real PTY, send real keystrokes,
assert on what is actually rendered, and record every session.

## What already exists

`backend-go/internal/tui` has golden tests using
`charmbracelet/x/exp/golden` — `internal/tui/page/testdata/` holds golden
screens for `TestChat_Golden_{Finished,MidStream,Interrupted,ToolTurn,ApprovalDialog,…}`,
and `internal/tui/component/toolcard/testdata/` covers each tool card.
Those tests drive `Update` directly with a `fakeClient` and never spawn a
process.

That is good coverage of *rendering* and it stays. This phase covers what
it structurally cannot: the binary starting, choosing a transport,
authenticating, reading config files, handling a real terminal, and
responding to real key sequences.

The two layers are complementary and the split is worth stating in the
suite's README so nobody duplicates the golden tests at PTY level.

## Deliverables

### 1. `harness/pty`

- Allocate a PTY at `tui.terminal` dimensions with the configured `TERM`.
- Spawn the binary attached to it; stream both directions to disk.
- An ANSI screen buffer: apply the output stream to a virtual screen and
  expose the current frame as plain text and as raw ANSI.
- Key injection covering the vocabulary the TUI actually uses: printable
  text, Enter, Tab, arrows, `ctrl+t`, `ctrl+o`, `ctrl+c`, Escape, and the
  `/` and `@` triggers.
- `WaitForStable(settleTimeout)` — wait until the screen stops changing
  before capturing. This replaces sleeps and is the single most important
  anti-flake measure in the suite.
- `WaitForText(s, timeout)` and `WaitForFrame(predicate, timeout)`.
- Asciinema v2 `.cast` writer.
- Frame capture on demand and automatically on failure.
- Terminal resize, so reflow is testable.

### 2. Feature directories

| Feature | Covers |
|---|---|
| `launch` | Attach-or-embed: with a running server, `client.Discover` attaches; without one, it embeds. `--connect` + `--token`; `--token` without `--connect` is an error; `-C dir`; `--mode` validation; `--thread` resume; `--model` |
| `config` | `.amiro/config.yaml` precedence: CLI → project → user → `AMIRO_*` → defaults; a malformed file is ignored, not fatal; an invalid `defaultMode` is a clean error |
| `auth` | `amiro auth login` / `logout` / `whoami`; a session stored per server key; a `--connect` session never used against a different server; first-run provisioning |
| `chat` | Type and submit; streaming renders progressively; tool cards appear; interrupt with `ctrl+c`; multi-turn; scrollback |
| `approval` | The approval dialog appears in `interactive` mode; approve continues; deny aborts; the resubmission carries the answered part |
| `palette` | `/` opens the palette; `/mode`, `/threads`, `/models`, `/settings`, `/compact`, `/export` each do what they claim; `@` completes agents, MCP tools, workflows and built-in tools |
| `pickers` | `ctrl+t` thread switcher, `ctrl+o` model picker; selection applies; cancel returns to chat |
| `headless` | `amiro run "<prompt>"` streams text; `--json` emits one valid object with text, usage and session log; `--yes` auto-approves; without `--yes` a gated call exits **2**; failure exits **1**; success exits **0** |
| `rendering` | Narrow and wide terminals; resize mid-stream; unicode and CJK width; very long lines; ANSI in model output not breaking the frame |

The exit-code contract in `headless` is documented in `cmd/amiro/main.go`'s
usage text and is exactly the kind of thing that silently regresses.

### 3. Golden screens

`suites/tui/**/testdata/<Test>/<case>.golden`, captured at
`tui.terminal` dimensions, updated with `amirotest run --update-golden
--surface tui`. On mismatch, a unified diff is written to `golden.diff` in
the run directory and referenced from `summary.md`.

### 4. Recordings

Every TUI test writes `session.cast`, replayable with `asciinema play`.
Keystrokes go to `keys.ndjson` with timestamps, so a recording can be
correlated against what the test actually sent.

## Exit criteria

1. `amirotest run --surface tui` passes in under 3 minutes.
2. Both transports are proven: a test with a pre-started backend asserts attachment (the embedded server never starts); a test without one asserts embedding.
3. All four permission modes are covered end to end through the TUI.
4. All three `amiro run` exit codes are asserted.
5. Every test produces a playable `.cast`.
6. Golden mismatches produce a readable diff without a re-run.
7. `amirotest run --surface tui --feature chat` runs only the chat tests.
8. Zero sleeps in the suite — enforced by a `suites/meta/` grep guard.

## Risks

- **PTY flakiness.** The classic source. `WaitForStable` plus predicate-based waiting, never sleeps, plus `-race` and repeated-run verification in CI.
- **Windows PTYs.** ConPTY differs substantially from Unix. Either use a library that abstracts it or scope the TUI suite to Unix in CI and record that decision explicitly — silently skipping on Windows is the bad outcome.
- **Golden churn.** Any styling change invalidates many goldens. Keep frames narrow in scope (assert on regions where possible), and make `--update-golden` diffs reviewable.
- **Overlap with `internal/tui`'s golden tests.** Duplicated rendering assertions at PTY level would be slow and redundant. This suite asserts on *behaviour and lifecycle*; rendering detail stays in the unit-level goldens.
