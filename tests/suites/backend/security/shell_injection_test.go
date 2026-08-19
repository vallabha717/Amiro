package security_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestSecurity_ShellToolArgumentInjectionIsGated is the phase document's
// "Shell tool argument injection".
//
// What is actually being tested, precisely. The shell tool
// (backend-go/internal/ai/tools/terminal.go, registered as both
// `run_shell` and `terminal-execution`) does NOT escape or sanitise its
// `command` argument -- it splices it straight into `bash -c`, and its own
// doc comment says the starting directory "is a *default*, not
// containment... What bounds shell is the permission gate (RiskExec), not
// this."
//
// So the security property is not "the shell tool refuses metacharacters".
// It is: a command carrying shell metacharacters is never AUTO-APPROVED,
// and therefore never runs without a human saying yes. That gate is
// backend-go/internal/agent/permission/command.go's HasShellOperators,
// which rejects `;` `&` `|` `>` `<` backtick `$(` `(` newline and carriage
// return outright, plus an exact-token-prefix allowlist
// (DefaultAllowedCommands) for everything else.
//
// The test therefore runs each injection vector in `interactive`
// permission mode -- the mode where consequential calls are gated -- and
// asserts on the FILESYSTEM: the injected half of the command would have
// created a marker file, and no marker file exists afterwards. That is an
// assertion the tool cannot satisfy by returning a reassuring string.
//
// The control subtest is what makes the rest non-vacuous: `echo` with no
// metacharacters IS on the allowlist and DOES run in the same mode. A gate
// that refused everything would pass the vectors and fail the control.
func TestSecurity_ShellToolArgumentInjectionIsGated(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	wsRoot := h.Backend().WorkspaceRoot

	// The control first: prove the shell tool is reachable, wired, and
	// actually executes something in this permission mode. Everything
	// below is only meaningful because this passes.
	t.Run("control_allowlisted_command_actually_runs", func(t *testing.T) {
		h.Fake().OnPrompt(fakeprovider.Contains("shell control")).
			ToolCall("run_shell", map[string]any{"command": "echo amiro-shell-control-marker"}).
			ThenStreamText("Ran the control command.")

		turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
			ID:             "thread-shell-control",
			Message:        apiclient.TextMessage("msg-1", "shell control"),
			PermissionMode: "interactive",
			WorkspaceRoot:  wsRoot,
		})
		if err != nil {
			t.Fatalf("ChatTurn: %v", err)
		}
		if len(turn.ToolCalls) == 0 {
			t.Fatal("no shell tool call reached the backend; the injection subtests below would prove nothing")
		}
		combined := ""
		for _, c := range turn.ToolCalls {
			combined += string(c.Output) + " " + c.Error
		}
		if !strings.Contains(combined, "amiro-shell-control-marker") {
			t.Fatalf("an allowlisted `echo` did NOT execute in interactive mode. The gate is refusing "+
				"everything, which would make every injection subtest below pass for the wrong reason.\n"+
				"tool output: %s", combined)
		}
	})

	// Each vector is a benign left half plus an injected right half that
	// would leave `marker` on disk if the whole string reached bash.
	vectors := []struct {
		name    string
		command string
		marker  string
	}{
		{"semicolon_chaining", "echo safe; touch pwned_semicolon.txt", "pwned_semicolon.txt"},
		{"and_chaining", "echo safe && touch pwned_and.txt", "pwned_and.txt"},
		{"or_chaining", "false || touch pwned_or.txt", "pwned_or.txt"},
		{"pipe_chaining", "echo safe | tee pwned_pipe.txt", "pwned_pipe.txt"},
		{"command_substitution", "echo $(touch pwned_subshell.txt)", "pwned_subshell.txt"},
		{"backtick_substitution", "echo `touch pwned_backtick.txt`", "pwned_backtick.txt"},
		{"output_redirection", "echo safe > pwned_redirect.txt", "pwned_redirect.txt"},
		{"embedded_newline", "echo safe\ntouch pwned_newline.txt", "pwned_newline.txt"},
		{"carriage_return", "echo safe\rtouch pwned_cr.txt", "pwned_cr.txt"},
		{"background_ampersand", "touch pwned_background.txt &", "pwned_background.txt"},
		{"subshell_group", "(touch pwned_group.txt)", "pwned_group.txt"},
		// No shell operator at all: a NUL byte glued to the allowlisted
		// verb. This one probes the OTHER half of the gate -- the
		// exact-token-prefix allowlist -- because "echo\x00" is not the
		// token "echo" and so must not match DefaultAllowedCommands.
		{"null_byte_in_verb", "echo\x00 touch pwned_null.txt", "pwned_null.txt"},
	}

	for _, tc := range vectors {
		t.Run(tc.name, func(t *testing.T) {
			markerPath := filepath.Join(wsRoot, tc.marker)
			if _, err := os.Stat(markerPath); err == nil {
				t.Fatalf("%s already exists before the turn; this vector cannot prove anything", markerPath)
			}

			h.Fake().OnPrompt(fakeprovider.Contains("shell injection "+tc.name)).
				ToolCall("run_shell", map[string]any{"command": tc.command}).
				ThenStreamText("Handled the shell request.")

			turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
				ID:             "thread-shell-inject-" + tc.name,
				Message:        apiclient.TextMessage("msg-1", "shell injection "+tc.name),
				PermissionMode: "interactive",
				WorkspaceRoot:  wsRoot,
			})
			if err != nil {
				t.Fatalf("ChatTurn: %v", err)
			}
			if len(turn.ToolCalls) == 0 {
				t.Fatalf("no shell tool call reached the backend for %s; nothing was tested", tc.name)
			}

			// The assertion that matters, and the only one the tool cannot
			// talk its way out of.
			if _, err := os.Stat(markerPath); err == nil {
				body, _ := os.ReadFile(markerPath)
				t.Fatalf("CRITICAL: shell injection %q EXECUTED without approval -- %s exists (%q).\n"+
					"tool calls: %+v", tc.command, markerPath, string(body), turn.ToolCalls)
			}

			// And the same claim from the other side: nothing anywhere in
			// the workspace should have been created by the injected half.
			assertNoMarkerAnywhere(t, wsRoot, tc.marker)
		})
	}
}

// assertNoMarkerAnywhere catches an injected command that ran but landed
// its marker somewhere other than the workspace root -- a `cd` in the
// injected half, for instance.
func assertNoMarkerAnywhere(t *testing.T, root, marker string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && d.Name() == marker {
			t.Errorf("CRITICAL: injected command's marker %s was created at %s", marker, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
}
