package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

// newCheckpointTestEnv mirrors newBookmarkTestEnv's shape: a fresh sqlite
// db (foreign_keys enforced -- driver.go), one user, one thread so
// checkpoint_files' FK on chat_thread has something real to reference.
func newCheckpointTestEnv(t *testing.T) (*CheckpointFileRepository, *gorm.DB, *models.ChatThread) {
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
	return NewCheckpointFileRepository(gdb), gdb, thread
}

func TestCheckpointFileRepository_CaptureIsIdempotentPerTurnAndPath(t *testing.T) {
	repo, gdb, thread := newCheckpointTestEnv(t)
	ctx := context.Background()

	f := models.CheckpointFile{
		ThreadID: thread.ID, TurnID: "turn-1", Path: "README.md",
		ResolvedRoot: "/work", BlobKey: "checkpoints/abc", ExistedBefore: true,
	}
	for i := 0; i < 3; i++ {
		if err := repo.Capture(ctx, f); err != nil {
			t.Fatalf("Capture #%d: %v", i, err)
		}
	}

	var count int64
	if err := gdb.Model(&models.CheckpointFile{}).
		Where("thread_id = ? AND turn_id = ? AND path = ?", thread.ID, "turn-1", "README.md").
		Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("rows for (thread, turn, path) = %d, want 1 -- a repeat capture must not create a second row", count)
	}
}

func TestCheckpointFileRepository_HasCheckpointReflectsCapture(t *testing.T) {
	repo, _, thread := newCheckpointTestEnv(t)
	ctx := context.Background()

	has, err := repo.HasCheckpoint(ctx, thread.ID, "turn-1", "README.md")
	if err != nil {
		t.Fatalf("HasCheckpoint (before): %v", err)
	}
	if has {
		t.Fatalf("HasCheckpoint = true before any capture")
	}

	if err := repo.Capture(ctx, models.CheckpointFile{
		ThreadID: thread.ID, TurnID: "turn-1", Path: "README.md", ResolvedRoot: "/work", ExistedBefore: false,
	}); err != nil {
		t.Fatalf("Capture: %v", err)
	}

	has, err = repo.HasCheckpoint(ctx, thread.ID, "turn-1", "README.md")
	if err != nil {
		t.Fatalf("HasCheckpoint (after): %v", err)
	}
	if !has {
		t.Fatalf("HasCheckpoint = false after Capture")
	}
}

func TestCheckpointFileRepository_ListForTurnScopesToThatTurn(t *testing.T) {
	repo, _, thread := newCheckpointTestEnv(t)
	ctx := context.Background()

	must := func(turnID, path string) {
		t.Helper()
		if err := repo.Capture(ctx, models.CheckpointFile{
			ThreadID: thread.ID, TurnID: turnID, Path: path, ResolvedRoot: "/work", ExistedBefore: true, BlobKey: "b",
		}); err != nil {
			t.Fatalf("Capture(%s, %s): %v", turnID, path, err)
		}
	}
	must("turn-1", "a.go")
	must("turn-1", "b.go")
	must("turn-2", "c.go")

	rows, err := repo.ListForTurn(ctx, thread.ID, "turn-1")
	if err != nil {
		t.Fatalf("ListForTurn: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("ListForTurn(turn-1) = %d rows, want 2", len(rows))
	}
	for _, r := range rows {
		if r.TurnID != "turn-1" {
			t.Errorf("row turn_id = %q, want turn-1", r.TurnID)
		}
	}
}

func TestCheckpointFileRepository_MostRecentTurnWithCheckpoints(t *testing.T) {
	repo, _, thread := newCheckpointTestEnv(t)
	ctx := context.Background()

	_, found, err := repo.MostRecentTurnWithCheckpoints(ctx, thread.ID)
	if err != nil {
		t.Fatalf("MostRecentTurnWithCheckpoints (empty): %v", err)
	}
	if found {
		t.Fatalf("found = true for a thread with no checkpoints")
	}

	if err := repo.Capture(ctx, models.CheckpointFile{
		ThreadID: thread.ID, TurnID: "turn-1", Path: "a.go", ResolvedRoot: "/work", ExistedBefore: true, BlobKey: "b",
	}); err != nil {
		t.Fatalf("Capture turn-1: %v", err)
	}
	if err := repo.Capture(ctx, models.CheckpointFile{
		ThreadID: thread.ID, TurnID: "turn-2", Path: "b.go", ResolvedRoot: "/work", ExistedBefore: true, BlobKey: "b",
	}); err != nil {
		t.Fatalf("Capture turn-2: %v", err)
	}

	turnID, found, err := repo.MostRecentTurnWithCheckpoints(ctx, thread.ID)
	if err != nil {
		t.Fatalf("MostRecentTurnWithCheckpoints: %v", err)
	}
	if !found || turnID != "turn-2" {
		t.Errorf("MostRecentTurnWithCheckpoints = (%q, %v), want (turn-2, true)", turnID, found)
	}
}

func TestCheckpointFileRepository_RetentionEvictsOldestFirst(t *testing.T) {
	repo, gdb, thread := newCheckpointTestEnv(t)
	ctx := context.Background()

	// One capture over the cap: maxCheckpointFilesPerThread rows already
	// at the cap, plus one more should evict exactly one -- the oldest.
	for i := 0; i < maxCheckpointFilesPerThread; i++ {
		path := "file-" + models.NewID() + ".go"
		if err := repo.Capture(ctx, models.CheckpointFile{
			ThreadID: thread.ID, TurnID: "turn-1", Path: path, ResolvedRoot: "/work", ExistedBefore: true, BlobKey: "b",
		}); err != nil {
			t.Fatalf("seed capture %d: %v", i, err)
		}
	}
	var before int64
	gdb.Model(&models.CheckpointFile{}).Where("thread_id = ?", thread.ID).Count(&before)
	if before != maxCheckpointFilesPerThread {
		t.Fatalf("seeded %d rows, want %d", before, maxCheckpointFilesPerThread)
	}

	oldest, _, err := repo.MostRecentTurnWithCheckpoints(ctx, thread.ID)
	_ = oldest
	if err != nil {
		t.Fatalf("MostRecentTurnWithCheckpoints: %v", err)
	}
	var oldestRow models.CheckpointFile
	if err := gdb.Where("thread_id = ?", thread.ID).Order("created_at ASC").First(&oldestRow).Error; err != nil {
		t.Fatalf("find oldest: %v", err)
	}

	if err := repo.Capture(ctx, models.CheckpointFile{
		ThreadID: thread.ID, TurnID: "turn-1", Path: "one-more.go", ResolvedRoot: "/work", ExistedBefore: true, BlobKey: "b",
	}); err != nil {
		t.Fatalf("Capture over cap: %v", err)
	}

	var after int64
	gdb.Model(&models.CheckpointFile{}).Where("thread_id = ?", thread.ID).Count(&after)
	if after != maxCheckpointFilesPerThread {
		t.Errorf("row count after eviction = %d, want %d (cap enforced)", after, maxCheckpointFilesPerThread)
	}

	var stillThere int64
	gdb.Model(&models.CheckpointFile{}).Where("id = ?", oldestRow.ID).Count(&stillThere)
	if stillThere != 0 {
		t.Errorf("the oldest row (%s, path=%s) survived eviction -- retention must evict oldest-first", oldestRow.ID, oldestRow.Path)
	}
}
