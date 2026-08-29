# Phase 02 — Sandboxed shell execution

> **Shipped 2026-08-29, 4/5 criteria MET literally (1 PARTIAL — a
> pre-existing, unrelated TUI failure and the known `pnpm`-less `ui`
> surface gap, neither introduced by this phase). Verified against a real
> bubblewrap backend on Linux; macOS/`sandbox-exec` unverified (no macOS
> host available). See
> [progress/phase-02-sandboxed-execution.md](../progress/phase-02-sandboxed-execution.md)
> and its verification log for the full record.**

**Depends on:** — · **Blocks:** 4 · **Size:** L

**Surfaces touched:** backend (transparent to desktop/web/terminal — same
tool, same wire contract; only the status indicators below are new UI)

This phase makes it true that a `run_shell` call is isolated from the rest
of the host filesystem and network wherever the host platform supports it,
and that every result honestly states whether isolation actually happened.

## What already exists

- `internal/ai/tools/terminal.go` executes via `os/exec` directly on the
  host today, gated only by `permission.Engine`'s command-prefix allowlist
  and metacharacter guard (`internal/agent/permission/command.go`) — no
  process, filesystem or network isolation beyond the shell session's
  `cwd`. Named as a gap in both
  `docs/openworker-vs-amiro-feature-comparison.md` §3 and
  `docs/future-implementation/amiro-vs-coding-agents-comparison.md` §4.
- `internal/agent/lsp`'s opportunistic-discovery pattern (probe once at
  process start, cache the result, offer the tool only when found, never
  fail the smoke case loudly) is this phase's direct precedent for how a
  missing capability degrades — see Phase 5 of
  `docs/agentic-loop-implementation-plan.md`.
- The shell session is already per-workspace-root, not per-process (a
  Phase 3 fix from the agentic-loop plan) — this phase's sandbox wraps that
  existing per-root session, it does not restructure it.

See [03-sandboxed-execution.md](../03-sandboxed-execution.md) for the full
design, including exactly what filesystem/network isolation each backend
achieves.

## Deliverables

### 1. `internal/agent/sandbox/` package

| File | Covers |
|---|---|
| `sandbox.go` | `Backend` interface, `Run(ctx, cmd, opts) (Result, error)`, `Result.Sandboxed bool` + backend name |
| `bubblewrap.go` | Linux, `bwrap` — workspace root is the only writable bind, network namespace unshared by default |
| `seatbelt.go` | macOS, `sandbox-exec` with a generated profile — writes confined to workspace root, network denied by default |
| `none.go` | The honest fallback — runs exactly as today, `Sandboxed: false` |
| `detect.go` | Opportunistic discovery, run once at process start, cached for the process lifetime |

### 2. `terminal.go` calls through `sandbox.Run`

- Replaces the direct `os/exec` call with `sandbox.Run`; no other change to
  the tool's input/output shape.
- `internal/config` gains `SandboxNetworkAllow []string`, matched against a
  command's prefix the same way `command.go`'s shell allowlist already
  matches — a per-project, deliberate opt-in for commands that legitimately
  need network (`go build` fetching modules).

### 3. Status surfaces

- The `run_shell` tool-presenter's `Compact`/`Expanded` views (reusing
  `TerminalWindow`) gain a sandboxed/unsandboxed badge.
- The TUI status bar (`component/status/bar.go`) gains a sandbox indicator,
  following its existing width-based field-dropping.

### 4. Windows — documented, not built

- `internal/agent/sandbox/detect.go` reports `none` on Windows explicitly,
  with a comment naming job-object isolation as a deliberately deferred,
  separate piece of work — not silently absent.

### 5. Test coverage (required — see the `test` skill)

| Surface | Directory | Covers |
|---|---|---|
| backend | `tests/suites/backend/sandbox/` | A command that tries to write outside the workspace root is blocked when a sandbox backend is available (both bubblewrap and seatbelt paths, each skipped with a reasoned tag on a machine without the primitive — see `harness.Tags`); a command reaching the network is blocked by default and permitted when its prefix is on `SandboxNetworkAllow`; a platform/environment with neither primitive runs unsandboxed and reports `Sandboxed: false` |
| desktop | `tests/suites/desktop/sandbox/` | The sidecar's sandboxed execution behaves identically to the dashboard build — same backend, same guarantee |
| meta | `tests/suites/meta/` | A guard asserting `terminal.go`'s only call path to a subprocess is through `sandbox.Run` — no direct `os/exec.Command` left in the tool |

**Deliberately not covered:** Windows process isolation (named above, and
in `00-overview.md`'s non-goals); a network allow-list UI beyond raw config
(a Settings page for `SandboxNetworkAllow` is a smaller follow-up, not
blocking this phase, and is named as deferred rather than silently absent).

## Exit criteria

1. `amirotest run --surface backend --feature sandbox` passes, with any
   platform-specific skip reasoned and visible in the run summary (per the
   `test` skill's "a green run over a silently skipped surface" anti-pattern).
2. `TestSandbox_BlocksWriteOutsideWorkspaceRoot` and
   `TestSandbox_BlocksNetworkUnlessAllowlisted` both pass on at least one
   real sandbox backend in CI.
3. `TestSandbox_FallsThroughToUnsandboxedAndSaysSo` passes — a command run
   with no available backend still executes (no capability regression) and
   `Result.Sandboxed` is `false`.
4. The TUI status bar shows the sandbox indicator, asserted by a golden
   test in `internal/tui/component/status`.
5. `amirotest run` is green overall, `suites/meta` included, with every
   skip reasoned.

## Risks

- **`bubblewrap`/`sandbox-exec` availability varies across dev machines and
  CI images**, which could make this phase's own tests flaky or
  environment-dependent. Mitigated by treating "unsandboxed, said plainly"
  as a first-class, always-tested outcome (exit criterion 3) rather than
  something only exercised by accident when a CI image happens to lack the
  binary.
- **A misconfigured sandbox binary (present but erroring) being
  mis-detected as "available."** Mitigated by `detect.go` running a real
  smoke invocation, not just a `PATH` lookup, and treating a failed smoke
  test the same as "not found."
- **Legitimate build tooling breaking under default network denial**
  (module/package fetches). Mitigated by `SandboxNetworkAllow`, but this is
  the risk most likely to generate a confusing first-run failure — the
  refusal message must name the blocked host/command clearly enough that a
  user knows to add it to the allow-list, which is itself part of exit
  criterion 1's coverage.
