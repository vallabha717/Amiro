package chat

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"amiro/backend/internal/agent/checkpoint"
	"amiro/backend/internal/agent/workspace"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/storage"
)

// newCheckpointWiring builds a real Capturer the same way runner.go does,
// backed by a real sqlite repository and a real LocalStorage blob store --
// proving the scheduler wiring end to end rather than mocking the capturer.
func newCheckpointWiring(t *testing.T, ws *workspace.Workspace, threadID, turnID string) (*checkpoint.Capturer, *repository.CheckpointFileRepository) {
	t.Helper()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	owner := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(owner).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	thread := &models.ChatThread{ID: threadID, UserID: owner.ID, Title: "t"}
	if err := gdb.Create(thread).Error; err != nil {
		t.Fatalf("create thread: %v", err)
	}
	blobs, err := storage.NewLocalStorage(t.TempDir(), []byte("secret"), "http://127.0.0.1:0")
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	repo := repository.NewCheckpointFileRepository(gdb)
	return checkpoint.NewCapturer(repo, blobs, ws, threadID, turnID), repo
}

func TestToolScheduler_CapturesPreImageBeforeWriteFileRuns(t *testing.T) {
	root := t.TempDir()
	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("original"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	cap, repo := newCheckpointWiring(t, ws, "thread-1", "turn-1")

	activeTools := []tools.Definition{{
		Name: tools.NameWriteFile,
		Risk: tools.RiskWrite,
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			// The real write_file tool lands the write here -- capture must
			// have already happened by the time Execute runs.
			return map[string]string{"path": "a.txt"}, os.WriteFile(filepath.Join(root, "a.txt"), []byte("edited"), 0o644)
		},
	}}

	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: tools.NameWriteFile, Arguments: `{"path":"a.txt","content":"edited"}`}}},
		{Text: "done"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	if _, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), cap); err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}

	rows, err := repo.ListForTurn(context.Background(), "thread-1", "turn-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("checkpoint rows = %d, want 1", len(rows))
	}
	if rows[0].Path != "a.txt" || !rows[0].ExistedBefore {
		t.Errorf("row = %+v, want path=a.txt existedBefore=true", rows[0])
	}
	if rows[0].BlobKey == "" {
		t.Errorf("BlobKey is empty -- the pre-image bytes were never stored")
	}
}

func TestToolScheduler_ReadToolsAreNeverCheckpointed(t *testing.T) {
	root := t.TempDir()
	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	cap, repo := newCheckpointWiring(t, ws, "thread-1", "turn-1")

	activeTools := []tools.Definition{{
		Name: tools.NameReadFile,
		Risk: tools.RiskRead,
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			return map[string]string{"content": "hi"}, nil
		},
	}}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: tools.NameReadFile, Arguments: `{"path":"a.txt"}`}}},
		{Text: "done"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	if _, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), cap); err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}

	rows, err := repo.ListForTurn(context.Background(), "thread-1", "turn-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("checkpoint rows = %d, want 0 for a read-only tool", len(rows))
	}
}

// TestResolveApprovals_CapturesPreImageBeforeTheApprovedWriteRuns is the
// regression test for a real bug found in testing (not by inspection): a
// write_file/edit_file/multi_edit call resolved via the interactive-mode
// approval flow runs directly inside resolveApprovals, never through
// toolScheduler.execute -- so a checkpointer wired only into the scheduler
// (this file's other three tests) would never fire for a write a human had
// to approve first, which is the *default* permission mode. Found via a
// real Playwright run through the actual approval UI, where the rewind
// confirmation's file list came back empty for a turn that had genuinely
// written a file. See runner.go's comment on why checkpoints is now built
// ahead of resolveApprovals.
func TestResolveApprovals_CapturesPreImageBeforeTheApprovedWriteRuns(t *testing.T) {
	root := t.TempDir()
	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("original"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	cap, repo := newCheckpointWiring(t, ws, "thread-1", "assistant-1")

	activeTools := []tools.Definition{{
		Name: tools.NameWriteFile,
		Risk: tools.RiskWrite,
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			return map[string]string{"path": "a.txt"}, os.WriteFile(filepath.Join(root, "a.txt"), []byte("edited"), 0o644)
		},
	}}

	msg := &uiMessage{
		ID:   "assistant-1",
		Role: "assistant",
		Parts: []json.RawMessage{
			json.RawMessage(`{"type":"tool-write_file","toolCallId":"call-1","state":"output-available",` +
				`"input":{"path":"a.txt"},"output":{"__tag":"manual-tool-confirm","confirm":true}}`),
		},
	}

	resolveApprovals(context.Background(), msg, activeTools, testPerms(), cap)

	rows, err := repo.ListForTurn(context.Background(), "thread-1", "assistant-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("checkpoint rows = %d, want 1 -- an approved write must be checkpointed just like an auto-mode one", len(rows))
	}
	if rows[0].Path != "a.txt" || !rows[0].ExistedBefore || rows[0].BlobKey == "" {
		t.Errorf("row = %+v, want path=a.txt existedBefore=true with a real blob key", rows[0])
	}
}

func TestToolScheduler_NilCapturerNeverCheckpoints(t *testing.T) {
	activeTools := []tools.Definition{{
		Name: tools.NameWriteFile,
		Risk: tools.RiskWrite,
		Execute: func(ctx context.Context, raw json.RawMessage) (any, error) {
			return map[string]string{}, nil
		},
	}}
	engine := &fakeStreamEngine{steps: []bifrostai.StepResult{
		{ToolCalls: []bifrostai.ToolCall{{ID: "call-1", Name: tools.NameWriteFile, Arguments: `{"path":"a.txt","content":"x"}`}}},
		{Text: "done"},
	}}
	sw := uimessage.NewWriter(httptest.NewRecorder())

	// nil checkpoints -- the zero value every non-workspace turn has. Must
	// not panic.
	if _, err := runToolLoop(context.Background(), engine, sw, bifrostai.ResolvedModel{}, "", nil, activeTools, testPerms(), nil); err != nil {
		t.Fatalf("runToolLoop: %v", err)
	}
}
