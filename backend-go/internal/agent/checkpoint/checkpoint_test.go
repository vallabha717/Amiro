package checkpoint

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/storage"
)

// testEnv wires a real sqlite-backed repository, a real LocalStorage blob
// store rooted in a temp dir, and a real Workspace over a second temp dir --
// the same trio a live turn actually uses, so these tests exercise the
// genuine Resolve/Rel/blob round trip rather than a mock of it. threadID is
// a real chat_thread row's id: checkpoint_files' FK requires one to exist,
// with foreign_keys enforced (internal/db/driver.go).
type testEnv struct {
	repo     *repository.CheckpointFileRepository
	blobs    storage.Storage
	ws       *workspace.Workspace
	root     string
	threadID string
}

func newTestEnv(t *testing.T) testEnv {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	owner := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(owner).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	thread := &models.ChatThread{ID: models.NewID(), UserID: owner.ID, Title: "t"}
	if err := gdb.Create(thread).Error; err != nil {
		t.Fatalf("create thread: %v", err)
	}
	blobs, err := storage.NewLocalStorage(t.TempDir(), []byte("test-secret"), "http://127.0.0.1:0")
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	root := t.TempDir()
	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	return testEnv{
		repo:     repository.NewCheckpointFileRepository(gdb),
		blobs:    blobs,
		ws:       ws,
		root:     ws.Root(),
		threadID: thread.ID,
	}
}

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	abs := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

func readFile(t *testing.T, root, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(data)
}

func TestCapturer_FirstCaptureRecordsPreImageBytes(t *testing.T) {
	env := newTestEnv(t)
	writeFile(t, env.root, "README.md", "original content")

	cap := NewCapturer(env.repo, env.blobs, env.ws, env.threadID, "turn-1")
	cap.Capture(context.Background(), "README.md")

	rows, err := env.repo.ListForTurn(context.Background(), env.threadID, "turn-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if !rows[0].ExistedBefore {
		t.Errorf("ExistedBefore = false for a file that existed")
	}
	if rows[0].BlobKey == "" {
		t.Errorf("BlobKey is empty for a file with real pre-image bytes")
	}
	if rows[0].ResolvedRoot != env.root {
		t.Errorf("ResolvedRoot = %q, want %q", rows[0].ResolvedRoot, env.root)
	}
}

func TestCapturer_NewFileRecordsExistedBeforeFalse(t *testing.T) {
	env := newTestEnv(t)
	// note: never written -- capturing a file that does not exist yet,
	// exactly what a write_file creating a new file precedes.

	cap := NewCapturer(env.repo, env.blobs, env.ws, env.threadID, "turn-1")
	cap.Capture(context.Background(), "new-file.go")

	rows, err := env.repo.ListForTurn(context.Background(), env.threadID, "turn-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0].ExistedBefore {
		t.Errorf("ExistedBefore = true for a file that did not exist")
	}
	if rows[0].BlobKey != "" {
		t.Errorf("BlobKey = %q, want empty -- no pre-image bytes for a new file", rows[0].BlobKey)
	}
}

func TestCapturer_SecondWriteInSameTurnDoesNotRecapture(t *testing.T) {
	env := newTestEnv(t)
	writeFile(t, env.root, "a.go", "version 1")

	cap := NewCapturer(env.repo, env.blobs, env.ws, env.threadID, "turn-1")
	cap.Capture(context.Background(), "a.go")

	// Simulate the tool's own write landing between the two captures --
	// the second Capture call must see the *original* pre-image already
	// recorded and leave it alone, not overwrite it with the now-current
	// (post-first-edit) bytes.
	writeFile(t, env.root, "a.go", "version 2, written by the turn's first edit")
	cap.Capture(context.Background(), "a.go")

	rows, err := env.repo.ListForTurn(context.Background(), env.threadID, "turn-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1 -- a repeat write to the same file in one turn must not add a second checkpoint", len(rows))
	}

	data, err := env.blobs.Get(context.Background(), rows[0].BlobKey)
	if err != nil {
		t.Fatalf("Get blob: %v", err)
	}
	defer data.Close()
	buf := make([]byte, 64)
	n, _ := data.Read(buf)
	if got := string(buf[:n]); got != "version 1" {
		t.Errorf("stored pre-image = %q, want %q -- must be the true pre-turn content, not the mid-turn edit", got, "version 1")
	}
}

func TestCapturer_DirectoryTargetIsNotCaptured(t *testing.T) {
	env := newTestEnv(t)
	if err := os.MkdirAll(filepath.Join(env.root, "a-directory"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	cap := NewCapturer(env.repo, env.blobs, env.ws, env.threadID, "turn-1")
	cap.Capture(context.Background(), "a-directory")

	rows, err := env.repo.ListForTurn(context.Background(), env.threadID, "turn-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("rows = %d, want 0 -- a directory target has no file pre-image to capture", len(rows))
	}
}

func TestCapturer_PathOutsideWorkspaceIsSilentlyIgnored(t *testing.T) {
	env := newTestEnv(t)
	cap := NewCapturer(env.repo, env.blobs, env.ws, env.threadID, "turn-1")

	// Must not panic and must not record anything -- the write this
	// precedes will be refused by workspace.Resolve on its own; capture
	// degrading silently here is the documented contract.
	cap.Capture(context.Background(), "../../etc/passwd")

	rows, err := env.repo.ListForTurn(context.Background(), env.threadID, "turn-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("rows = %d, want 0 for a path outside the workspace", len(rows))
	}
}

func TestCapturer_NilCapturerCaptureIsANoOp(t *testing.T) {
	var cap *Capturer
	cap.Capture(context.Background(), "anything.go") // must not panic
}

func TestNewCapturer_MissingDependencyReturnsNil(t *testing.T) {
	env := newTestEnv(t)
	if c := NewCapturer(nil, env.blobs, env.ws, "t", "u"); c != nil {
		t.Error("NewCapturer with nil repo should return nil")
	}
	if c := NewCapturer(env.repo, nil, env.ws, "t", "u"); c != nil {
		t.Error("NewCapturer with nil blobs should return nil")
	}
	if c := NewCapturer(env.repo, env.blobs, nil, "t", "u"); c != nil {
		t.Error("NewCapturer with nil workspace should return nil")
	}
	if c := NewCapturer(env.repo, env.blobs, env.ws, "", "u"); c != nil {
		t.Error("NewCapturer with empty threadID should return nil")
	}
	if c := NewCapturer(env.repo, env.blobs, env.ws, "t", ""); c != nil {
		t.Error("NewCapturer with empty turnID should return nil")
	}
}

// TestCheckpoint_RestoreRevertsExactPreImageBytes is named in
// docs/coding-agent-parity/phases/phase-01-checkpoints-and-rewind.md's exit
// criterion 2.
func TestCheckpoint_RestoreRevertsExactPreImageBytes(t *testing.T) {
	env := newTestEnv(t)
	const original = "line one\nline two\nline three\n"
	writeFile(t, env.root, "src/main.go", original)

	cap := NewCapturer(env.repo, env.blobs, env.ws, env.threadID, "turn-1")
	cap.Capture(context.Background(), "src/main.go")

	// The turn's own edit lands after the checkpoint, as it would for real.
	writeFile(t, env.root, "src/main.go", "completely different content\n")

	result, err := Restore(context.Background(), env.repo, env.blobs, env.threadID, "turn-1")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if len(result.Files) != 1 || !result.Files[0].Restored {
		t.Fatalf("result = %+v, want exactly one restored file", result)
	}

	got := readFile(t, env.root, "src/main.go")
	if got != original {
		t.Errorf("restored content = %q, want exact pre-image %q", got, original)
	}
}

// TestCheckpoint_RestoreOfNonexistentFileDeletesIt is named in
// docs/coding-agent-parity/phases/phase-01-checkpoints-and-rewind.md's exit
// criterion 2 -- the asymmetric case
// docs/coding-agent-parity/02-checkpoints-and-rewind.md calls out
// explicitly: a file the turn *created* has no pre-image, and restore must
// delete it rather than write empty bytes.
func TestCheckpoint_RestoreOfNonexistentFileDeletesIt(t *testing.T) {
	env := newTestEnv(t)
	// Never written before the capture -- write_file is about to create it.
	cap := NewCapturer(env.repo, env.blobs, env.ws, env.threadID, "turn-1")
	cap.Capture(context.Background(), "new-file.go")

	// The turn's write lands.
	writeFile(t, env.root, "new-file.go", "package main\n")
	if _, err := os.Stat(filepath.Join(env.root, "new-file.go")); err != nil {
		t.Fatalf("setup: file should exist after the turn's write: %v", err)
	}

	result, err := Restore(context.Background(), env.repo, env.blobs, env.threadID, "turn-1")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if len(result.Files) != 1 || !result.Files[0].Restored {
		t.Fatalf("result = %+v, want exactly one restored file", result)
	}
	if result.Files[0].ExistedBefore {
		t.Errorf("ExistedBefore = true, want false for a file the turn created")
	}

	if _, err := os.Stat(filepath.Join(env.root, "new-file.go")); !os.IsNotExist(err) {
		t.Errorf("file still exists after restore (err=%v), want deleted", err)
	}
}

func TestCheckpoint_RestoreOfUnresolvablePathIsRefusedWithoutAbortingTheRest(t *testing.T) {
	env := newTestEnv(t)
	writeFile(t, env.root, "keep.go", "kept")

	cap := NewCapturer(env.repo, env.blobs, env.ws, env.threadID, "turn-1")
	cap.Capture(context.Background(), "keep.go")

	// A second turn captured against a workspace root that has since been
	// removed entirely (the design doc's "a moved workspace" case) --
	// resolved independently of turn-1, whose root is untouched.
	brokenWS, err := workspace.New(t.TempDir())
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	writeFile(t, brokenWS.Root(), "b.go", "b")
	brokenCap := NewCapturer(env.repo, env.blobs, brokenWS, env.threadID, "turn-2")
	brokenCap.Capture(context.Background(), "b.go")
	if err := os.RemoveAll(brokenWS.Root()); err != nil {
		t.Fatalf("RemoveAll: %v", err)
	}

	result, err := Restore(context.Background(), env.repo, env.blobs, env.threadID, "turn-2")
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if len(result.Files) != 1 {
		t.Fatalf("result.Files = %d, want 1", len(result.Files))
	}
	if result.Files[0].Restored {
		t.Errorf("Restored = true for a root that no longer exists")
	}
	if result.Files[0].Error == "" {
		t.Errorf("Error is empty for a failed restore -- the caller needs a reason")
	}

	// And the unrelated turn-1 restore is unaffected by turn-2's broken root.
	result1, err := Restore(context.Background(), env.repo, env.blobs, env.threadID, "turn-1")
	if err != nil {
		t.Fatalf("Restore turn-1: %v", err)
	}
	for _, f := range result1.Files {
		if !f.Restored {
			t.Errorf("turn-1 file %q not restored: %s", f.Path, f.Error)
		}
	}
}
