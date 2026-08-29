// Package sandbox answers a different question from
// internal/agent/permission: given that a command is allowed to run, what
// can it actually reach while it runs. Today, absent this package, the
// answer was "everything the host process can reach" -- no filesystem or
// network isolation beyond the shell session's cwd. See
// docs/coding-agent-parity/03-sandboxed-execution.md for the full design.
//
// A pluggable Backend is chosen once, at process start (Detect, cached for
// the process lifetime -- the same shape internal/agent/lsp's server
// discovery uses), never per call. Every command's result honestly states
// whether isolation actually happened: Result.Sandboxed and Result.Backend
// are not cosmetic. Phase 4 (background agent runs) reads Sandboxed
// directly to decide whether an unattended run may execute shell at all.
package sandbox

import (
	"context"
	"os/exec"
)

// CommandOpts scopes one command's isolation: the workspace root that must
// be the only writable path, and whether this specific command's prefix
// matched the project's SandboxNetworkAllow list.
type CommandOpts struct {
	// Dir is the workspace root -- the only writable bind under a real
	// backend. Empty means no workspace is configured, which a real
	// backend then treats as "nothing is writable" rather than guessing.
	Dir string
	// NetworkAllowed is true when the command's prefix matched the
	// project's configured allow-list (internal/config's
	// SandboxNetworkAllow, matched via MatchesCommandPrefix the same way
	// internal/agent/permission/command.go's shell allowlist matches).
	// A real backend denies network by default and only opens it when
	// this is true.
	NetworkAllowed bool
}

// RunOpts is CommandOpts plus the environment and streams Run needs to
// actually execute and capture a command, for the common one-shot case
// (run_shell's foreground path, and every sandbox test in this repo).
// Background tasks that need pipes rather than buffers use Command
// directly instead -- see terminal.go's runBackground.
type RunOpts struct {
	Dir            string
	Env            []string
	Stdout         interface{ Write([]byte) (int, error) }
	Stderr         interface{ Write([]byte) (int, error) }
	NetworkAllowed bool
}

// Result is what every run_shell call reports about its own isolation.
// Sandboxed and Backend are the honesty contract this package exists for:
// a caller (human or model) must never mistake "we don't know" for "it's
// fine."
type Result struct {
	// ExitCode is the command's own exit code, set even when the command
	// itself failed -- a non-zero exit is not a sandbox error.
	ExitCode int
	// Sandboxed is true only when a real backend (bubblewrap, seatbelt)
	// actually wrapped this command. False is the honest, always-tested
	// outcome when no backend is available on this platform or in this
	// environment, or when the platform is Windows (documented as
	// unsandboxed this phase, not silently shipped as equivalent).
	Sandboxed bool
	// Backend names which backend produced this result: "bubblewrap",
	// "seatbelt", or "none".
	Backend string
}

// Backend is one platform's isolation primitive. Implementations live in
// bubblewrap.go, seatbelt.go and none.go; Detect (detect.go) chooses one
// per process.
type Backend interface {
	// Name identifies the backend for logging and the status surfaces
	// (run_shell's card, the TUI status bar).
	Name() string
	// Sandboxed reports whether this backend provides real isolation.
	// none.go is the only implementation that returns false.
	Sandboxed() bool
	// wrap returns the argv to actually execute for the given intended
	// argv and options -- e.g. bubblewrap prepends `bwrap <flags> -- ` in
	// front of it. none.go returns argv unchanged. Unexported: the only
	// supported entry points from outside this package are Command and
	// Run, which call it through the process's Detect()-ed backend.
	wrap(argv []string, opts CommandOpts) []string
}

// Command builds an *exec.Cmd for argv, wrapped by the process's detected
// sandbox backend, and reports which backend (if any) actually applied.
// The caller still owns Env/Stdout/Stderr/Start/Run/Wait -- this is the
// primitive both Run (below) and terminal.go's background-task path (which
// needs StdoutPipe/StderrPipe, not a captured Run) build on.
func Command(ctx context.Context, argv []string, opts CommandOpts) (*exec.Cmd, Result) {
	b := Detect()
	wrapped := b.wrap(argv, opts)
	cmd := exec.CommandContext(ctx, wrapped[0], wrapped[1:]...)
	if opts.Dir != "" {
		cmd.Dir = opts.Dir
	}
	return cmd, Result{Sandboxed: b.Sandboxed(), Backend: b.Name()}
}

// Run executes argv (already fully formed -- e.g. [shellPath, "-c",
// script]) under the process's detected sandbox backend, capturing its
// exit code. It never fails merely because the command it ran exited
// non-zero; err is only set when the command could not be started or the
// context expired.
func Run(ctx context.Context, argv []string, opts RunOpts) (Result, error) {
	cmd, result := Command(ctx, argv, CommandOpts{Dir: opts.Dir, NetworkAllowed: opts.NetworkAllowed})
	cmd.Env = opts.Env
	if opts.Stdout != nil {
		cmd.Stdout = opts.Stdout
	}
	if opts.Stderr != nil {
		cmd.Stderr = opts.Stderr
	}
	err := cmd.Run()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			return result, nil
		}
		return result, err
	}
	return result, nil
}
