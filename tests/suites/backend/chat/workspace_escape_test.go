package chat_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestWorkspaceEscape_RefusesAllEscapeVectors verifies that file tools cannot escape WorkspaceRoot:
// ../ traversal, absolute paths outside root, external symlinks, encoded traversals, and null bytes.
func TestWorkspaceEscape_RefusesAllEscapeVectors(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	wsRoot := h.Backend().WorkspaceRoot

	// Create a secret file outside the workspace root to prove it cannot be read
	outsideDir := t.TempDir()
	outsideSecret := filepath.Join(outsideDir, "secret_outside.txt")
	if err := os.WriteFile(outsideSecret, []byte("SUPER_CONFIDENTIAL_OUTSIDE_DATA\n"), 0644); err != nil {
		t.Fatalf("writing external file: %v", err)
	}

	// Create a symlink inside workspace pointing to outsideDir
	symlinkPath := filepath.Join(wsRoot, "leak_symlink")
	_ = os.Symlink(outsideDir, symlinkPath)

	vectors := []struct {
		name        string
		tool        string
		args        map[string]any
		escapeProof string
	}{
		{
			name: "relative_parent_traversal",
			tool: "read_file",
			args: map[string]any{"path": "../../appdata/sidecar.lock.json"},
		},
		{
			name: "absolute_path_outside_root",
			tool: "read_file",
			args: map[string]any{"path": outsideSecret},
		},
		{
			name: "symlink_pointing_outside",
			tool: "read_file",
			args: map[string]any{"path": "leak_symlink/secret_outside.txt"},
		},
		{
			name: "encoded_dot_dot_traversal",
			tool: "read_file",
			args: map[string]any{"path": "%2e%2e%2f%2e%2e%2fsecret.txt"},
		},
		{
			name: "null_byte_traversal",
			tool: "read_file",
			args: map[string]any{"path": "valid.txt\x00/../../etc/passwd"},
		},
		{
			name: "write_escape_relative",
			tool: "write_file",
			args: map[string]any{"path": "../escaped_write.txt", "content": "MALICIOUS"},
		},
		{
			name: "write_escape_absolute",
			tool: "write_file",
			args: map[string]any{"path": filepath.Join(outsideDir, "escaped_write.txt"), "content": "MALICIOUS"},
		},
	}

	for _, tc := range vectors {
		t.Run(tc.name, func(t *testing.T) {
			h.Fake().OnPrompt(fakeprovider.Contains(tc.name)).
				ToolCall(tc.tool, tc.args).
				ThenStreamText("Processed tool outcome.")

			req := apiclient.ChatRequest{
				ID:             "thread-escape-" + tc.name,
				Message:        apiclient.TextMessage("msg-escape", "test escape: "+tc.name),
				PermissionMode: "auto",
				WorkspaceRoot:  wsRoot,
			}

			turn, err := user.ChatTurn(t.Context(), req)
			if err != nil {
				t.Fatalf("ChatTurn: %v", err)
			}

			// Verify tool call had error or reported escape refusal in tool output
			hasRejection := false
			for _, tcCall := range turn.ToolCalls {
				if tcCall.Error != "" {
					hasRejection = true
					break
				}
				outStr := string(tcCall.Output)
				if strings.Contains(outStr, "outside the workspace") ||
					strings.Contains(outStr, "resolves to") ||
					strings.Contains(outStr, "workspace:") ||
					strings.Contains(outStr, "is outside") {
					hasRejection = true
					break
				}
			}

			if !hasRejection && len(turn.ToolCalls) > 0 {
				t.Fatalf("vector %s was not rejected by workspace containment! Tool output: %+v", tc.name, turn.ToolCalls)
			}

			// For write attempts, confirm the file was never created outside workspace
			escapedFile := filepath.Join(outsideDir, "escaped_write.txt")
			if _, err := os.Stat(escapedFile); err == nil {
				t.Fatalf("CRITICAL SECURITY ESCAPE: file %s was created outside workspace root!", escapedFile)
			}
		})
	}
}
