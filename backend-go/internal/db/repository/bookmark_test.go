package repository

import (
	"context"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
)

// newBookmarkTestEnv seeds two distinct users the same way agent_test.go's
// (now-removed, Phase 6) newAgentTestEnv did, minus the agent repository
// nothing here needs anymore.
func newBookmarkTestEnv(t *testing.T) (*BookmarkRepository, *gorm.DB, *models.User, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	owner := &models.User{Name: "Ada", Email: "ada@example.com"}
	other := &models.User{Name: "Grace", Email: "grace@example.com"}
	for _, u := range []*models.User{owner, other} {
		if err := gdb.Create(u).Error; err != nil {
			t.Fatalf("create user: %v", err)
		}
	}
	return NewBookmarkRepository(gdb), gdb, owner, other
}

func TestBookmarkRepository_CreateIsIdempotent(t *testing.T) {
	bookmarks, gdb, owner, _ := newBookmarkTestEnv(t)
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		if err := bookmarks.Create(ctx, owner.ID, "item-1", BookmarkItemTypeWorkflow); err != nil {
			t.Fatalf("Create #%d: %v", i, err)
		}
	}

	// Unlike archive_item, bookmark *does* declare UNIQUE(user_id,
	// item_id, item_type) in its migration, so onConflictDoNothing has a
	// constraint to fire on.
	var count int64
	if err := gdb.Model(&models.Bookmark{}).Where("item_id = ?", "item-1").Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("got %d bookmark rows, want 1", count)
	}
}

func TestBookmarkRepository_RemoveIsScopedToOneUserAndType(t *testing.T) {
	bookmarks, gdb, owner, other := newBookmarkTestEnv(t)
	ctx := context.Background()

	_ = bookmarks.Create(ctx, owner.ID, "item-1", BookmarkItemTypeWorkflow)
	_ = bookmarks.Create(ctx, other.ID, "item-1", BookmarkItemTypeWorkflow)

	if err := bookmarks.Remove(ctx, owner.ID, "item-1", BookmarkItemTypeWorkflow); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	var remaining []models.Bookmark
	if err := gdb.Where("item_id = ?", "item-1").Find(&remaining).Error; err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(remaining) != 1 || remaining[0].UserID != other.ID {
		t.Fatalf("got %+v -- Remove must only affect the calling user's row", remaining)
	}
}

func TestBookmarkRepository_RemoveIsSilentWhenNothingIsBookmarked(t *testing.T) {
	bookmarks, _, owner, _ := newBookmarkTestEnv(t)

	if err := bookmarks.Remove(context.Background(), owner.ID, "no-such-item", BookmarkItemTypeWorkflow); err != nil {
		t.Fatalf("Remove: %v", err)
	}
}

// TestBookmarkRepository_CheckItemAccessAlwaysDenies proves Phase 6's
// change: agent was the only item type CheckItemAccess ever granted, and
// it's gone. Workflow was already unimplemented (the TS repository's own
// "TODO: Add workflow access check when workflows support bookmarking"),
// so removing agent leaves every itemType denied -- not a regression for
// workflow, but it does make POST /api/bookmark permanently a 404.
func TestBookmarkRepository_CheckItemAccessAlwaysDenies(t *testing.T) {
	bookmarks, _, owner, other := newBookmarkTestEnv(t)
	ctx := context.Background()

	cases := []struct {
		name     string
		itemID   string
		itemType string
		userID   string
	}{
		{"own item, workflow type", "item-1", BookmarkItemTypeWorkflow, owner.ID},
		{"another user's item", "item-1", BookmarkItemTypeWorkflow, other.ID},
		{"missing item", "no-such-id", BookmarkItemTypeWorkflow, owner.ID},
	}
	for _, tc := range cases {
		got, err := bookmarks.CheckItemAccess(ctx, tc.itemID, tc.itemType, tc.userID)
		if err != nil {
			t.Fatalf("%s: CheckItemAccess: %v", tc.name, err)
		}
		if got {
			t.Fatalf("%s: CheckItemAccess should always deny now that agent is gone", tc.name)
		}
	}
}
