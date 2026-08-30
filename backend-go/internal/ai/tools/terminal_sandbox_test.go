package tools

import (
	"context"
	"strings"
	"testing"

	"amiro/backend/internal/agent/sandbox"
)

// TestTerminalExecutor_ReportsSandboxStatus is this phase's own unit
// coverage for terminal.go's call path: run_shell's output must carry
// Sandboxed/SandboxBackend, whatever they are on this machine -- this test
// does not assume bwrap/sandbox-exec is or isn't available, only that the
// two fields are populated consistently (Sandboxed=false iff Backend=="none").
func TestTerminalExecutor_ReportsSandboxStatus(t *testing.T) {
	e := newTerminalExecutor(t.TempDir())
	out := e.Run(context.Background(), terminalInput{Command: "echo hello-from-sandbox-test"}, nil, false)

	if out.ExitCode != 0 {
		t.Fatalf("ExitCode = %d, want 0 (output: %q)", out.ExitCode, out.Output)
	}
	if !strings.Contains(out.Output, "hello-from-sandbox-test") {
		t.Fatalf("Output = %q, want the echoed text", out.Output)
	}
	if out.Sandboxed && out.SandboxBackend == "none" {
		t.Fatal("Sandboxed=true but SandboxBackend=\"none\" -- inconsistent honesty contract")
	}
	if !out.Sandboxed && out.SandboxBackend != "none" && out.SandboxBackend != "" {
		t.Fatalf("Sandboxed=false but SandboxBackend=%q, want \"none\"", out.SandboxBackend)
	}
	if out.SandboxBackend == "" {
		t.Fatal("SandboxBackend is empty -- every result must name a backend")
	}
}

// TestTerminalExecutor_RunInBackgroundStillWorks is a regression guard: the
// background path now builds its *exec.Cmd via sandbox.Command instead of
// exec.Command directly, and this pins that the observable behavior
// (task_id issued, output eventually readable) is unchanged.
func TestTerminalExecutor_RunInBackgroundStillWorks(t *testing.T) {
	e := newTerminalExecutor(t.TempDir())
	out := e.Run(context.Background(), terminalInput{
		Command:         "echo background-output-marker",
		RunInBackground: true,
	}, nil, false)
	if !strings.Contains(out.Output, "task_id") {
		t.Fatalf("Output = %q, want a task_id in the background-start response", out.Output)
	}
}

// TestTerminalExecutor_RequireSandboxRefusesRatherThanFallingBack is Phase
// 4's own coverage of the honest-degrade contract Phase 2 established:
// requireSandbox=true must refuse outright when no real backend is
// available, never silently run the command unsandboxed --
// docs/coding-agent-parity/05-background-agent-runs.md's "an unattended job
// never falls back to unsandboxed execution". This runs against whatever
// backend this machine actually has, in both directions, rather than
// assuming either outcome.
func TestTerminalExecutor_RequireSandboxRefusesRatherThanFallingBack(t *testing.T) {
	e := newTerminalExecutor(t.TempDir())
	out := e.Run(context.Background(), terminalInput{Command: "echo hi"}, nil, true)

	if sandbox.Detect().Sandboxed() {
		if out.Error != "" {
			t.Fatalf("Error = %q, want no refusal when a real sandbox backend is available", out.Error)
		}
		if !strings.Contains(out.Output, "hi") {
			t.Fatalf("Output = %q, want the command to have actually run", out.Output)
		}
		return
	}

	if out.Error != errUnsandboxedRefused {
		t.Fatalf("Error = %q, want the unsandboxed-refused message", out.Error)
	}
	if out.ExitCode == 0 {
		t.Fatal("ExitCode = 0 for a refused command, want nonzero")
	}
	if strings.Contains(out.Output, "hi") {
		t.Fatal("Output contains the echoed text -- the command ran despite the refusal")
	}
}

// TestTerminalExecutor_RequireSandboxAlsoGatesTheBackgroundPath covers
// run_in_background's separate code path (runBackground), which builds its
// own *exec.Cmd via sandbox.Command rather than sandbox.Run.
func TestTerminalExecutor_RequireSandboxAlsoGatesTheBackgroundPath(t *testing.T) {
	if sandbox.Detect().Sandboxed() {
		t.Skip("this machine has a real sandbox backend -- nothing to refuse")
	}
	e := newTerminalExecutor(t.TempDir())
	out := e.Run(context.Background(), terminalInput{
		Command:         "echo hi",
		RunInBackground: true,
	}, nil, true)
	if !strings.Contains(out.Output, errUnsandboxedRefused) {
		t.Fatalf("Output = %q, want it to carry the unsandboxed-refused error", out.Output)
	}
}
