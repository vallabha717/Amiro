# 03 — Sandboxed shell execution

Settles Phase 2: what "sandboxed" means per platform, how the tool degrades
where it can't, and how a caller (human or the status bar) can tell which
happened for a given command.

## Why this is separate from the permission engine

The command allowlist and metacharacter guard
(`internal/agent/permission/command.go`) answer "should this command run at
all" — policy, and already built. Sandboxing answers a different question:
**given that a command is allowed to run, what can it actually reach while
it runs.** Today the answer is "everything the host process can reach,
scoped only by the shell session's `cwd`" — no filesystem isolation beyond
convention, no network isolation at all. This phase adds the second gate
without touching the first.

## Design: a pluggable backend, chosen at startup, never per-call

```
internal/agent/sandbox/
├── sandbox.go       # Backend interface, Run(ctx, cmd, opts) (Result, error)
├── bubblewrap.go    # Linux, when bwrap is on PATH
├── seatbelt.go      # macOS, sandbox-exec
├── none.go          # the honest fallback — see below
└── detect.go        # opportunistic discovery, run once at process start
```

| Platform | Primitive | Isolation achieved |
|---|---|---|
| Linux | `bubblewrap` (`bwrap`) if on `PATH` | New mount namespace: workspace root is the only writable bind; `/`, `/usr` etc. read-only; network namespace unshared (no route) unless the command is on a small network-allow list |
| macOS | `sandbox-exec` with a generated profile | Filesystem writes confined to the workspace root; network denied by default via the profile's `deny network*` |
| Windows | — | **Not sandboxed this phase.** Job objects are real, separate work (process/job isolation, not a config flag) — named as a non-goal in `00-overview.md`, not silently shipped as equivalent to the other two |
| Any platform, primitive missing | — | Falls through to `none.go`: runs exactly as `terminal.go` does today, and the result carries `Sandboxed: false` |

This is the same shape `internal/agent/lsp`'s server discovery already
uses: opportunistic, checked once, and the *absence* of the capability is a
first-class, tested outcome rather than a silent downgrade. `detect.go`'s
result is cached for the process lifetime — re-probing per command call
would be both slow and pointless, since the binary doesn't appear or
disappear mid-session.

## What gets isolated, specifically

- **Filesystem:** the workspace root is the only writable path. Everything
  else the sandboxed process can see is read-only (it may still need to
  read `/usr/lib`, the Go toolchain, `node_modules` outside the bind if a
  monorepo tool reaches for something global — read-only satisfies that
  without granting write).
- **Network:** denied by default. A small, user-configurable allow-list
  (`internal/config` gains `SandboxNetworkAllow []string`, matched against
  the command's own prefix — the same matching `command.go` already does
  for the shell allowlist) exists for the legitimate case: `go build`
  fetching a module, `npm install` reaching a registry. This is an
  allow-list added deliberately per project, not a blanket hole punched to
  make the feature stop complaining.

## The honesty contract

Every `run_shell` result carries a `Sandboxed bool` (and, when true, which
backend). This is not cosmetic:

- The tool-presenter registry's `run_shell` card (`TerminalWindow`) gains a
  small badge reflecting it — the same "diagnostics: clean vs
  not-yet-analysed" distinction the `lsp` tool's presenter already draws,
  because the two failure modes it's protecting against are structurally
  identical: a caller (human or model) treating "we don't know" as "it's
  fine."
- The TUI status bar's existing model/mode/workspace/tokens/cost/elapsed
  row gains a sandbox indicator, following the same width-based
  field-dropping the bar already implements for narrow terminals.
- **Phase 4 (background agents) reads this flag directly**: an unattended
  run is only permitted to execute shell commands when `Sandboxed` is true
  for the detected backend — see Phase 4's own design doc. This is the
  concrete reason Phase 2 blocks Phase 4 rather than merely preceding it.

## Failure modes

- **`bwrap`/`sandbox-exec` present but misconfigured** (no permission to
  create namespaces in a restrictive container, say): `detect.go` treats a
  failed *smoke* invocation the same as "not found" — falls through to
  `none.go` rather than failing every subsequent shell call opaquely.
- **A command that legitimately needs write access outside the
  workspace** (a global package manager cache, for instance): out of scope
  for this phase. The tool refuses with a reason naming the path, the same
  way `workspace.Resolve`'s `EscapeError` already explains itself to the
  model — no new silent-widening mechanism.
