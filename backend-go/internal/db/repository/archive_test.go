package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/models"
)

func newArchiveTestEnv(t *testing.T) (*ArchiveRepository, *ChatRepository, *gorm.DB, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	u := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return NewArchiveRepository(gdb), NewChatRepository(gdb), gdb, u
}

func TestArchiveRepository_CreateThenGetByID(t *testing.T) {
	repo, _, _, u := newArchiveTestEnv(t)
	ctx := context.Background()

	archive := &models.Archive{Name: "Reading list", UserID: u.ID}
	if err := repo.Create(ctx, archive); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if archive.ID == "" {
		t.Fatal("Create did not assign an id")
	}

	got, err := repo.GetByID(ctx, archive.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got == nil || got.Name != "Reading list" {
		t.Fatalf("got %+v", got)
	}
}

func TestArchiveRepository_GetByIDReturnsNilForMissingID(t *testing.T) {
	repo, _, _, _ := newArchiveTestEnv(t)

	got, err := repo.GetByID(context.Background(), "no-such-id")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestArchiveRepository_GetByUserIDCountsItems(t *testing.T) {
	repo, chats, _, u := newArchiveTestEnv(t)
	ctx := context.Background()

	full := &models.Archive{Name: "Full", UserID: u.ID}
	empty := &models.Archive{Name: "Empty", UserID: u.ID}
	for _, a := range []*models.Archive{full, empty} {
		if err := repo.Create(ctx, a); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}
	for _, id := range []string{"t1", "t2"} {
		if err := chats.InsertThread(ctx, &models.ChatThread{ID: id, Title: id, UserID: u.ID}); err != nil {
			t.Fatalf("InsertThread: %v", err)
		}
		if _, err := repo.AddItem(ctx, full.ID, id, u.ID); err != nil {
			t.Fatalf("AddItem: %v", err)
		}
	}

	rows, err := repo.GetByUserID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetByUserID: %v", err)
	}

	counts := map[string]int64{}
	for _, row := range rows {
		counts[row.Name] = row.ItemCount
	}
	if counts["Full"] != 2 {
		t.Fatalf("Full item count = %d, want 2", counts["Full"])
	}
	// The LEFT JOIN is what keeps an empty archive in the result at all --
	// an INNER JOIN would silently drop it.
	if _, ok := counts["Empty"]; !ok {
		t.Fatalf("an archive with no items vanished from the list: %v", counts)
	}
	if counts["Empty"] != 0 {
		t.Fatalf("Empty item count = %d, want 0", counts["Empty"])
	}
}

func TestArchiveRepository_GetByUserIDExcludesOtherUsersArchives(t *testing.T) {
	repo, _, gdb, u := newArchiveTestEnv(t)
	ctx := context.Background()
	other := &models.User{Name: "Grace", Email: "grace@example.com"}
	if err := gdb.Create(other).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	if err := repo.Create(ctx, &models.Archive{Name: "Theirs", UserID: other.ID}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	rows, err := repo.GetByUserID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetByUserID: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("got %d rows, want 0", len(rows))
	}
}

func TestArchiveRepository_AddItemIsIdempotent(t *testing.T) {
	repo, chats, _, u := newArchiveTestEnv(t)
	ctx := context.Background()
	archive := &models.Archive{Name: "A", UserID: u.ID}
	_ = repo.Create(ctx, archive)
	_ = chats.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "t1", UserID: u.ID})

	first, err := repo.AddItem(ctx, archive.ID, "t1", u.ID)
	if err != nil {
		t.Fatalf("first AddItem: %v", err)
	}
	second, err := repo.AddItem(ctx, archive.ID, "t1", u.ID)
	if err != nil {
		t.Fatalf("second AddItem: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("re-adding produced a new row: %q vs %q", first.ID, second.ID)
	}

	items, _ := repo.GetItems(ctx, archive.ID)
	if len(items) != 1 {
		t.Fatalf("got %d items, want 1", len(items))
	}
}

func TestArchiveRepository_DeleteRemovesItemsToo(t *testing.T) {
	repo, chats, gdb, u := newArchiveTestEnv(t)
	ctx := context.Background()
	archive := &models.Archive{Name: "A", UserID: u.ID}
	_ = repo.Create(ctx, archive)
	_ = chats.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "t1", UserID: u.ID})
	_, _ = repo.AddItem(ctx, archive.ID, "t1", u.ID)

	if err := repo.Delete(ctx, archive.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	var orphans int64
	if err := gdb.Model(&models.ArchiveItem{}).Where("archive_id = ?", archive.ID).Count(&orphans).Error; err != nil {
		t.Fatalf("count items: %v", err)
	}
	if orphans != 0 {
		t.Fatalf("%d archive_item rows outlived their archive", orphans)
	}
}

func TestArchiveRepository_UpdateWritesBothColumns(t *testing.T) {
	repo, _, _, u := newArchiveTestEnv(t)
	ctx := context.Background()
	description := "before"
	archive := &models.Archive{Name: "Before", Description: &description, UserID: u.ID}
	_ = repo.Create(ctx, archive)

	updated, err := repo.Update(ctx, archive.ID, "After", nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "After" {
		t.Fatalf("name = %q", updated.Name)
	}
	if updated.Description != nil {
		t.Fatalf("description = %v, want nil -- Update writes both columns unconditionally", *updated.Description)
	}
}

func TestArchiveRepository_GetItemArchivesFindsEveryArchiveHoldingAnItem(t *testing.T) {
	repo, chats, _, u := newArchiveTestEnv(t)
	ctx := context.Background()
	_ = chats.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "t1", UserID: u.ID})

	inBoth := &models.Archive{Name: "Alpha", UserID: u.ID}
	alsoInBoth := &models.Archive{Name: "Beta", UserID: u.ID}
	unrelated := &models.Archive{Name: "Gamma", UserID: u.ID}
	for _, a := range []*models.Archive{inBoth, alsoInBoth, unrelated} {
		_ = repo.Create(ctx, a)
	}
	_, _ = repo.AddItem(ctx, inBoth.ID, "t1", u.ID)
	_, _ = repo.AddItem(ctx, alsoInBoth.ID, "t1", u.ID)

	rows, err := repo.GetItemArchives(ctx, "t1", u.ID)
	if err != nil {
		t.Fatalf("GetItemArchives: %v", err)
	}
	if len(rows) != 2 || rows[0].Name != "Alpha" || rows[1].Name != "Beta" {
		names := make([]string, 0, len(rows))
		for _, row := range rows {
			names = append(names, row.Name)
		}
		t.Fatalf("got %v, want [Alpha Beta] ordered by name", names)
	}
}

func TestArchiveRepository_RemoveItemLeavesOtherArchivesAlone(t *testing.T) {
	repo, chats, _, u := newArchiveTestEnv(t)
	ctx := context.Background()
	_ = chats.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "t1", UserID: u.ID})

	a := &models.Archive{Name: "A", UserID: u.ID}
	b := &models.Archive{Name: "B", UserID: u.ID}
	_ = repo.Create(ctx, a)
	_ = repo.Create(ctx, b)
	_, _ = repo.AddItem(ctx, a.ID, "t1", u.ID)
	_, _ = repo.AddItem(ctx, b.ID, "t1", u.ID)

	if err := repo.RemoveItem(ctx, a.ID, "t1"); err != nil {
		t.Fatalf("RemoveItem: %v", err)
	}

	if items, _ := repo.GetItems(ctx, a.ID); len(items) != 0 {
		t.Fatalf("archive A still holds %d items", len(items))
	}
	if items, _ := repo.GetItems(ctx, b.ID); len(items) != 1 {
		t.Fatalf("archive B lost its item -- the delete was not scoped by archive_id")
	}
}
