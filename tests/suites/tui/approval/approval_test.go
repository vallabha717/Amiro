package approval_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/pty"
)

func TestApproval_ApproveDialogInteractions(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
		s.OnPrompt(fakeprovider.Contains("create file y")).ToolCall("write_file", map[string]any{
			"path":    "created_y.txt",
			"content": "content for y",
		}).ThenStreamText("File y written.")

		s.OnPrompt(fakeprovider.Contains("create file n")).ToolCall("write_file", map[string]any{
			"path":    "denied_n.txt",
			"content": "content for n",
		}).ThenStreamText("File n written.")

		s.OnPrompt(fakeprovider.Contains("create always 1")).ToolCall("write_file", map[string]any{
			"path":    "always_1.txt",
			"content": "content for always 1",
		}).ThenStreamText("Always 1 written.")

		s.OnPrompt(fakeprovider.Contains("create always 2")).ToolCall("write_file", map[string]any{
			"path":    "always_2.txt",
			"content": "content for always 2",
		}).ThenStreamText("Always 2 written.")
	}))
	be := h.Backend()

	// 1. Approve once with 'y' -> asserts tool execution and file created in workspace
	t.Run("approve once with y", func(t *testing.T) {
		sess := h.PTY(
			harness.PTYAppDataDir(be.AppDataDir),
			harness.PTYDir(be.WorkspaceRoot),
		)
		defer sess.Close()

		if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
			t.Fatal(err)
		}

		if err := sess.SendLine("create file y"); err != nil {
			t.Fatal(err)
		}

		// Wait specifically for the approval modal dialog (not just a tool card)
		if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
			return b.Contains("[y] approve once") && b.Contains("[n] deny")
		}, 8*time.Second); err != nil {
			t.Fatalf("approval dialog did not appear: %v\nframe:\n%s", err, sess.Frame())
		}

		// Send 'y' to approve once
		if err := sess.SendKey(pty.KeyApprove, "y"); err != nil {
			t.Fatal(err)
		}

		// Wait for turn completion stream
		if err := sess.WaitForText("File y written.", 8*time.Second); err != nil {
			t.Fatalf("turn did not complete after approval: %v\nframe:\n%s", err, sess.Frame())
		}

		// Assert file side effect actually happened in the workspace
		filePath := filepath.Join(be.WorkspaceRoot, "created_y.txt")
		data, err := os.ReadFile(filePath)
		if err != nil {
			t.Fatalf("expected created_y.txt to exist after approval: %v", err)
		}
		if string(data) != "content for y" {
			t.Errorf("file content = %q, want 'content for y'", string(data))
		}
	})

	// 2. Deny with 'n' -> asserts tool is aborted and file is NOT created in workspace
	t.Run("deny with n", func(t *testing.T) {
		sess := h.PTY(
			harness.PTYAppDataDir(be.AppDataDir),
			harness.PTYDir(be.WorkspaceRoot),
		)
		defer sess.Close()

		if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
			t.Fatal(err)
		}

		if err := sess.SendLine("create file n"); err != nil {
			t.Fatal(err)
		}

		// Wait specifically for the approval modal dialog
		if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
			return b.Contains("[y] approve once") && b.Contains("[n] deny")
		}, 8*time.Second); err != nil {
			t.Fatalf("approval dialog did not appear: %v\nframe:\n%s", err, sess.Frame())
		}

		// Send 'n' to deny
		if err := sess.SendKey(pty.KeyDeny, "n"); err != nil {
			t.Fatal(err)
		}

		// Wait for screen to stabilize after denial
		if err := sess.WaitForStable(3 * time.Second); err != nil {
			t.Fatal(err)
		}

		// Assert file was NOT created
		filePath := filepath.Join(be.WorkspaceRoot, "denied_n.txt")
		if _, err := os.Stat(filePath); !os.IsNotExist(err) {
			t.Fatalf("denied_n.txt should NOT exist after denial, stat error: %v", err)
		}
	})

	// 3. Always allow with 'a' -> asserts subsequent call auto-approves without prompt
	t.Run("always allow with a", func(t *testing.T) {
		sess := h.PTY(
			harness.PTYAppDataDir(be.AppDataDir),
			harness.PTYDir(be.WorkspaceRoot),
		)
		defer sess.Close()

		if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
			t.Fatal(err)
		}

		// Turn 1: First call prompts for approval
		if err := sess.SendLine("create always 1"); err != nil {
			t.Fatal(err)
		}

		if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
			return b.Contains("[y] approve once") && b.Contains("[a] always allow")
		}, 8*time.Second); err != nil {
			t.Fatalf("approval dialog did not appear for turn 1: %v\nframe:\n%s", err, sess.Frame())
		}

		// Send 'a' to grant permanent permission for this tool in the session
		if err := sess.SendKey(pty.KeyAlways, "a"); err != nil {
			t.Fatal(err)
		}

		if err := sess.WaitForStable(3 * time.Second); err != nil {
			t.Fatal(err)
		}

		filePath1 := filepath.Join(be.WorkspaceRoot, "always_1.txt")
		assert.FileExists(t, filePath1)

		// Turn 2: Second call in same session should NOT show approval dialog
		if err := sess.SendLine("create always 2"); err != nil {
			t.Fatal(err)
		}

		if err := sess.WaitForStable(3 * time.Second); err != nil {
			t.Fatal(err)
		}

		// Verify no approval dialog appeared for turn 2
		if sess.Contains("[y] approve once") {
			t.Fatalf("approval dialog should NOT appear for second call after 'a':\nframe:\n%s", sess.Frame())
		}

		filePath2 := filepath.Join(be.WorkspaceRoot, "always_2.txt")
		assert.FileExists(t, filePath2)
	})
}


func TestApproval_AllFourPermissionModes(t *testing.T) {
	// 1. Plan Mode: read-only, refused outright without showing approval modal
	t.Run("plan mode refuses write tools", func(t *testing.T) {
		h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
			s.OnPrompt(fakeprovider.Contains("plan mode action")).ToolCall("write_file", map[string]any{
				"path":    "plan_refused.txt",
				"content": "plan content",
			}).ThenStreamText("Plan done.")
		}))
		be := h.Backend()
		sess := h.PTY(
			harness.PTYAppDataDir(be.AppDataDir),
			harness.PTYDir(be.WorkspaceRoot),
			harness.PTYArgs("--mode", "plan"),
		)
		defer sess.Close()

		if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
			t.Fatal(err)
		}

		if err := sess.SendLine("plan mode action"); err != nil {
			t.Fatal(err)
		}

		// Should receive refusal message in tool result and model stream
		if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
			return b.Contains("plan mode is read-only") || b.Contains("Plan done.")
		}, 8*time.Second); err != nil {
			t.Fatalf("plan mode refusal did not appear:\nframe:\n%s", sess.Frame())
		}

		// Assert file was NOT created
		filePath := filepath.Join(be.WorkspaceRoot, "plan_refused.txt")
		if _, err := os.Stat(filePath); !os.IsNotExist(err) {
			t.Fatalf("plan_refused.txt should not exist in plan mode: %v", err)
		}
	})

	// 2. Interactive Mode: gates write tools with approval modal
	t.Run("interactive mode gates writes", func(t *testing.T) {
		h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
			s.OnPrompt(fakeprovider.Contains("interactive mode action")).ToolCall("write_file", map[string]any{
				"path":    "interactive_out.txt",
				"content": "interactive content",
			}).ThenStreamText("Interactive done.")
		}))
		be := h.Backend()
		sess := h.PTY(
			harness.PTYAppDataDir(be.AppDataDir),
			harness.PTYDir(be.WorkspaceRoot),
			harness.PTYArgs("--mode", "interactive"),
		)
		defer sess.Close()

		if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
			t.Fatal(err)
		}

		if err := sess.SendLine("interactive mode action"); err != nil {
			t.Fatal(err)
		}

		if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
			return b.Contains("[y] approve once") && b.Contains("[n] deny")
		}, 8*time.Second); err != nil {
			t.Fatalf("approval dialog did not appear in interactive mode:\nframe:\n%s", sess.Frame())
		}

		if err := sess.SendKey(pty.KeyApprove, "y"); err != nil {
			t.Fatal(err)
		}

		if err := sess.WaitForText("Interactive done.", 8*time.Second); err != nil {
			t.Fatalf("turn did not finish:\nframe:\n%s", sess.Frame())
		}

		assert.FileExists(t, filepath.Join(be.WorkspaceRoot, "interactive_out.txt"))
	})

	// 3. Edit Mode: auto-allows file writes, but gates shell commands
	t.Run("edit mode auto-allows writes and gates commands", func(t *testing.T) {
		h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
			s.OnPrompt(fakeprovider.Contains("edit mode write")).ToolCall("write_file", map[string]any{
				"path":    "edit_out.txt",
				"content": "edit content",
			}).ThenStreamText("Edit write done.")

			s.OnPrompt(fakeprovider.Contains("edit mode shell")).ToolCall("run_shell", map[string]any{
				"command": "rm -rf /tmp/edit_test",
			}).ThenStreamText("Edit shell done.")
		}))
		be := h.Backend()
		sess := h.PTY(
			harness.PTYAppDataDir(be.AppDataDir),
			harness.PTYDir(be.WorkspaceRoot),
			harness.PTYArgs("--mode", "edit"),
		)
		defer sess.Close()

		if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
			t.Fatal(err)
		}

		// Turn 1: write_file auto-executes with no dialog
		if err := sess.SendLine("edit mode write"); err != nil {
			t.Fatal(err)
		}
		if err := sess.WaitForText("Edit write done.", 8*time.Second); err != nil {
			t.Fatalf("edit write did not auto-complete without prompt:\nframe:\n%s", sess.Frame())
		}
		assert.FileExists(t, filepath.Join(be.WorkspaceRoot, "edit_out.txt"))

		// Turn 2: run_shell command prompts for approval
		if err := sess.SendLine("edit mode shell"); err != nil {
			t.Fatal(err)
		}
		if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
			return b.Contains("[y] approve once") && b.Contains("run_shell")
		}, 8*time.Second); err != nil {
			t.Fatalf("approval dialog did not appear for command in edit mode:\nframe:\n%s", sess.Frame())
		}
		if err := sess.SendKey(pty.KeyApprove, "y"); err != nil {
			t.Fatal(err)
		}
		if err := sess.WaitForText("Edit shell done.", 8*time.Second); err != nil {
			t.Fatalf("command turn did not finish after approval:\n%s", sess.Frame())
		}
	})

	// 4. Auto Mode: runs writes and commands automatically without asking
	t.Run("auto mode auto-allows all consequential actions", func(t *testing.T) {
		h := harness.New(t, harness.Tags("smoke"), harness.WithFake(func(s *fakeprovider.Server) {
			s.OnPrompt(fakeprovider.Contains("auto mode action")).ToolCall("write_file", map[string]any{
				"path":    "auto_out.txt",
				"content": "auto content",
			}).ThenStreamText("Auto done.")
		}))
		be := h.Backend()
		sess := h.PTY(
			harness.PTYAppDataDir(be.AppDataDir),
			harness.PTYDir(be.WorkspaceRoot),
			harness.PTYArgs("--mode", "auto"),
		)
		defer sess.Close()

		if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
			t.Fatal(err)
		}

		if err := sess.SendLine("auto mode action"); err != nil {
			t.Fatal(err)
		}

		// Executes immediately without approval dialog
		if err := sess.WaitForText("Auto done.", 8*time.Second); err != nil {
			t.Fatalf("auto mode did not complete turn without prompt:\nframe:\n%s", sess.Frame())
		}
		assert.FileExists(t, filepath.Join(be.WorkspaceRoot, "auto_out.txt"))
	})
}
