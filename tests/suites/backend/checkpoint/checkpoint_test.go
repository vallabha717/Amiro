package checkpoint_test

import (
	"os"
	"path/filepath"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestCheckpoint_CapturesOnFirstWriteOfATurnNotEveryWrite is exit criterion
// 1's core claim, exercised over the real API: a turn that writes the same
// file twice (two write_file calls in one turn) records exactly one
// checkpoint, holding the file's true pre-turn bytes -- not the state after
// the first of the two writes.
func TestCheckpoint_CapturesOnFirstWriteOfATurnNotEveryWrite(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot

	if err := os.WriteFile(filepath.Join(root, "notes.txt"), []byte("original content"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	h.Fake().OnPrompt(fakeprovider.Contains("edit notes twice")).
		ToolCall("write_file", map[string]any{"path": "notes.txt", "content": "first edit"}).
		ToolCall("write_file", map[string]any{"path": "notes.txt", "content": "second edit"}).
		ThenStreamText("Done.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-checkpoint-dedup",
		Message:        apiclient.TextMessage("msg-1", "please edit notes twice"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if len(turn.ToolCalls) != 2 {
		t.Fatalf("ToolCalls = %+v, want exactly two write_file calls", turn.ToolCalls)
	}

	files, err := user.CheckpointFilesFor(t.Context(), "thread-checkpoint-dedup", turn.MessageID)
	if err != nil {
		t.Fatalf("CheckpointFilesFor: %v", err)
	}
	if len(files.Files) != 1 {
		t.Fatalf("checkpointed files = %+v, want exactly one -- a second write to the same path in one turn must not add a second checkpoint", files.Files)
	}
	if files.Files[0].Path != "notes.txt" || !files.Files[0].ExistedBefore {
		t.Errorf("file = %+v, want notes.txt existedBefore=true", files.Files[0])
	}
}

// TestCheckpoint_RestoreRevertsExactBytesOverTheRealAPI is exit criterion 1
// exercised end to end: a live turn writes a file, then a restore reverts
// it to the exact pre-turn bytes.
func TestCheckpoint_RestoreRevertsExactBytesOverTheRealAPI(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	const original = "line one\nline two\n"

	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte(original), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	h.Fake().OnPrompt(fakeprovider.Contains("rewrite main")).
		ToolCall("write_file", map[string]any{"path": "main.go", "content": "completely different\n"}).
		ThenStreamText("Done.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-checkpoint-restore",
		Message:        apiclient.TextMessage("msg-1", "please rewrite main.go"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	written, err := os.ReadFile(filepath.Join(root, "main.go"))
	if err != nil {
		t.Fatalf("read after turn: %v", err)
	}
	if string(written) == original {
		t.Fatal("setup: the turn's write never actually landed")
	}

	result, err := user.RestoreCheckpoint(t.Context(), "thread-checkpoint-restore", turn.MessageID)
	if err != nil {
		t.Fatalf("RestoreCheckpoint: %v", err)
	}
	if len(result.Files) != 1 || !result.Files[0].Restored {
		t.Fatalf("restore result = %+v, want one restored file", result.Files)
	}

	got, err := os.ReadFile(filepath.Join(root, "main.go"))
	if err != nil {
		t.Fatalf("read after restore: %v", err)
	}
	if string(got) != original {
		t.Errorf("restored content = %q, want exact pre-image %q", got, original)
	}
}

// TestCheckpoint_RestoreOfNewFileDeletesItRatherThanEmptyingIt is the
// asymmetric case docs/coding-agent-parity/02-checkpoints-and-rewind.md
// calls out explicitly, exercised over the real API.
func TestCheckpoint_RestoreOfNewFileDeletesItRatherThanEmptyingIt(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot

	h.Fake().OnPrompt(fakeprovider.Contains("create a new file")).
		ToolCall("write_file", map[string]any{"path": "brand-new.go", "content": "package main\n"}).
		ThenStreamText("Done.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-checkpoint-newfile",
		Message:        apiclient.TextMessage("msg-1", "please create a new file"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	if _, err := os.Stat(filepath.Join(root, "brand-new.go")); err != nil {
		t.Fatalf("setup: file should exist after the turn: %v", err)
	}

	result, err := user.RestoreCheckpoint(t.Context(), "thread-checkpoint-newfile", turn.MessageID)
	if err != nil {
		t.Fatalf("RestoreCheckpoint: %v", err)
	}
	if len(result.Files) != 1 || !result.Files[0].Restored || result.Files[0].ExistedBefore {
		t.Fatalf("restore result = %+v, want one restored file with existedBefore=false", result.Files)
	}

	if _, err := os.Stat(filepath.Join(root, "brand-new.go")); !os.IsNotExist(err) {
		t.Errorf("brand-new.go still exists after restore (err=%v), want deleted", err)
	}
}

// TestCheckpoint_RestoreOfAMovedWorkspaceIsRefusedForThatFileOnly proves the
// per-file refusal contract: a workspace root removed after capture fails
// that one file's restore with a reason, without erroring the whole call.
func TestCheckpoint_RestoreOfAMovedWorkspaceIsRefusedForThatFileOnly(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	movedRoot := t.TempDir()

	if err := os.WriteFile(filepath.Join(movedRoot, "a.go"), []byte("a"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	// movedRoot is an interactively-opened root, not the server's own
	// default -- workspace trust (phase 0) refuses write_file against it
	// without an explicit grant, which would otherwise make this turn
	// capture nothing and turn this into a false pass.
	if _, err := user.GrantWorkspaceTrust(t.Context(), movedRoot); err != nil {
		t.Fatalf("GrantWorkspaceTrust: %v", err)
	}

	h.Fake().OnPrompt(fakeprovider.Contains("edit a dot go")).
		ToolCall("write_file", map[string]any{"path": "a.go", "content": "b"}).
		ThenStreamText("Done.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-checkpoint-moved",
		Message:        apiclient.TextMessage("msg-1", "please edit a dot go"),
		PermissionMode: "auto",
		WorkspaceRoot:  movedRoot,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	if err := os.RemoveAll(movedRoot); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}

	result, err := user.RestoreCheckpoint(t.Context(), "thread-checkpoint-moved", turn.MessageID)
	if err != nil {
		t.Fatalf("RestoreCheckpoint: %v (want a 200 with a per-file failure, not a transport error)", err)
	}
	if len(result.Files) != 1 {
		t.Fatalf("result.Files = %+v, want exactly one", result.Files)
	}
	if result.Files[0].Restored {
		t.Error("Restored = true for a workspace root that no longer exists")
	}
	if result.Files[0].Error == "" {
		t.Error("Error is empty for a failed restore -- the caller needs a reason")
	}
}

// TestCheckpoint_RequireSession is the auth guard, all three routes.
func TestCheckpoint_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()

	if _, err := anon.CheckpointFilesFor(t.Context(), "thread-x", "turn-y"); apiclient.StatusOf(err) != 401 {
		t.Errorf("files: got status %d, want 401", apiclient.StatusOf(err))
	}
	if _, err := anon.LatestCheckpoint(t.Context(), "thread-x"); apiclient.StatusOf(err) != 401 {
		t.Errorf("latest: got status %d, want 401", apiclient.StatusOf(err))
	}
	if _, err := anon.RestoreCheckpoint(t.Context(), "thread-x", "turn-y"); apiclient.StatusOf(err) != 401 {
		t.Errorf("restore: got status %d, want 401", apiclient.StatusOf(err))
	}
}

// TestCheckpoint_OtherUsersThreadIsForbidden proves the checkpoint routes
// scope by thread ownership, the same way every other thread-scoped route
// in this tree does.
func TestCheckpoint_OtherUsersThreadIsForbidden(t *testing.T) {
	h := harness.New(t)
	owner := h.As("user")
	other := h.As("other")
	root := h.Backend().WorkspaceRoot

	h.Fake().OnPrompt(fakeprovider.Contains("owner only")).
		ToolCall("write_file", map[string]any{"path": "owner-file.go", "content": "x"}).
		ThenStreamText("Done.")

	turn, err := owner.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-checkpoint-owner",
		Message:        apiclient.TextMessage("msg-1", "owner only please"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	if _, err := other.CheckpointFilesFor(t.Context(), "thread-checkpoint-owner", turn.MessageID); apiclient.StatusOf(err) != 403 {
		t.Errorf("files: got status %d, want 403", apiclient.StatusOf(err))
	}
	if _, err := other.RestoreCheckpoint(t.Context(), "thread-checkpoint-owner", turn.MessageID); apiclient.StatusOf(err) != 403 {
		t.Errorf("restore: got status %d, want 403", apiclient.StatusOf(err))
	}
}

// TestCheckpoint_LatestReportsNothingToRewindForAFreshThread is exit
// criterion 3's backend half: a real thread that has never written a file
// has nothing to rewind, reported as an explicit empty state rather than a
// 404 or an empty-looking confirmation.
func TestCheckpoint_LatestReportsNothingToRewindForAFreshThread(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	h.Fake().OnPrompt(fakeprovider.Contains("just say hi")).StreamText("hi!")
	if _, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-checkpoint-fresh",
		Message:        apiclient.TextMessage("msg-1", "just say hi"),
		PermissionMode: "auto",
		WorkspaceRoot:  h.Backend().WorkspaceRoot,
	}); err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	latest, err := user.LatestCheckpoint(t.Context(), "thread-checkpoint-fresh")
	if err != nil {
		t.Fatalf("LatestCheckpoint: %v", err)
	}
	if latest.TurnID != "" || len(latest.Files) != 0 {
		t.Errorf("LatestCheckpoint = %+v, want empty", latest)
	}
}
