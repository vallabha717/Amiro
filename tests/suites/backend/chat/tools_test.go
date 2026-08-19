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

// TestTools_BuiltInFileToolsExecuteAndReport verifies read_file and write_file tool executions.
func TestTools_BuiltInFileToolsExecuteAndReport(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	// 1. Script fake provider: first turn calls write_file, second turn completes
	h.Fake().OnPrompt(fakeprovider.Contains("create notes")).
		ToolCall("write_file", map[string]any{
			"path":    "notes.txt",
			"content": "Amiro testing phase 3 active.\n",
		}).
		ThenStreamText("I have created notes.txt successfully.")

	threadID := "thread-tools-write-1"
	req := apiclient.ChatRequest{
		ID:             threadID,
		Message:        apiclient.TextMessage("msg-1", "please create notes.txt"),
		PermissionMode: "auto",
		WorkspaceRoot:  h.Backend().WorkspaceRoot,
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	if !strings.Contains(turn.Text, "created notes.txt") {
		t.Errorf("expected completion text, got %q", turn.Text)
	}

	// Verify file was physically written inside workspace
	writtenFile := filepath.Join(h.Backend().WorkspaceRoot, "notes.txt")
	content, err := os.ReadFile(writtenFile)
	if err != nil {
		t.Fatalf("reading written file: %v", err)
	}
	if !strings.Contains(string(content), "Amiro testing phase 3 active") {
		t.Errorf("unexpected file content: %s", string(content))
	}

	// 2. Script fake provider: read_file
	h.Fake().OnPrompt(fakeprovider.Contains("read notes")).
		ToolCall("read_file", map[string]any{
			"path": "notes.txt",
		}).
		ThenStreamText("The notes file contains: Amiro testing phase 3 active.")

	req2 := apiclient.ChatRequest{
		ID:             threadID,
		Message:        apiclient.TextMessage("msg-2", "read notes.txt please"),
		PermissionMode: "auto",
		WorkspaceRoot:  h.Backend().WorkspaceRoot,
	}

	turn2, err := user.ChatTurn(t.Context(), req2)
	if err != nil {
		t.Fatalf("ChatTurn 2: %v", err)
	}
	if !strings.Contains(turn2.Text, "Amiro testing phase 3 active") {
		t.Errorf("expected read result in text, got %q", turn2.Text)
	}
}

// TestTools_MultiToolTurnSequencing verifies sequential tool calls within one turn.
func TestTools_MultiToolTurnSequencing(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("list directory")).
		ToolCall("list_dir", map[string]any{
			"path": ".",
		}).
		ThenStreamText("Found files in directory.")

	req := apiclient.ChatRequest{
		ID:             "thread-tools-multi-1",
		Message:        apiclient.TextMessage("msg-1", "list directory contents"),
		PermissionMode: "auto",
		WorkspaceRoot:  h.Backend().WorkspaceRoot,
	}

	turn, err := user.ChatTurn(t.Context(), req)
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if !strings.Contains(turn.Text, "Found files in directory") {
		t.Errorf("expected completion text, got %q", turn.Text)
	}
}
