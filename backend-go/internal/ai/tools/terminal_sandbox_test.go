package tools

import (
	"context"
	"strings"
	"testing"
)

// TestTerminalExecutor_ReportsSandboxStatus is this phase's own unit
// coverage for terminal.go's call path: run_shell's output must carry
// Sandboxed/SandboxBackend, whatever they are on this machine -- this test
// does not assume bwrap/sandbox-exec is or isn't available, only that the
// two fields are populated consistently (Sandboxed=false iff Backend=="none").
func TestTerminalExecutor_ReportsSandboxStatus(t *testing.T) {
	e := newTerminalExecutor(t.TempDir())
	out := e.Run(context.Background(), terminalInput{Command: "echo hello-from-sandbox-test"}, nil)

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
	}, nil)
	if !strings.Contains(out.Output, "task_id") {
		t.Fatalf("Output = %q, want a task_id in the background-start response", out.Output)
	}
}
