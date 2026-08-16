package repository

import (
	"context"
	"testing"

	"amiro/backend/internal/db/models"
)

func TestBookmarkRepository_CreateIsIdempotent(t *testing.T) {
	agents, bookmarks, gdb, owner, _ := newAgentTestEnv(t)
	ctx := context.Background()
	agent := seedAgent(t, agents, owner.ID, "Public", "public")

	for i := 0; i < 2; i++ {
		if err := bookmarks.Create(ctx, owner.ID, agent.ID, BookmarkItemTypeAgent); err != nil {
			t.Fatalf("Create #%d: %v", i, err)
		}
	}

	// Unlike archive_item, bookmark *does* declare UNIQUE(user_id,
	// item_id, item_type) in its migration, so onConflictDoNothing has a
	// constraint to fire on.
	var count int64
	if err := gdb.Model(&models.Bookmark{}).Where("item_id = ?", agent.ID).Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("got %d bookmark rows, want 1", count)
	}
}

func TestBookmarkRepository_RemoveIsScopedToOneUserAndType(t *testing.T) {
	agents, bookmarks, gdb, owner, other := newAgentTestEnv(t)
	ctx := context.Background()
	agent := seedAgent(t, agents, owner.ID, "Public", "public")

	_ = bookmarks.Create(ctx, owner.ID, agent.ID, BookmarkItemTypeAgent)
	_ = bookmarks.Create(ctx, other.ID, agent.ID, BookmarkItemTypeAgent)

	if err := bookmarks.Remove(ctx, owner.ID, agent.ID, BookmarkItemTypeAgent); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	var remaining []models.Bookmark
	if err := gdb.Where("item_id = ?", agent.ID).Find(&remaining).Error; err != nil {
		t.Fatalf("find: %v", err)
	}
	if len(remaining) != 1 || remaining[0].UserID != other.ID {
		t.Fatalf("got %+v -- Remove must only affect the calling user's row", remaining)
	}
}

func TestBookmarkRepository_RemoveIsSilentWhenNothingIsBookmarked(t *testing.T) {
	_, bookmarks, _, owner, _ := newAgentTestEnv(t)

	if err := bookmarks.Remove(context.Background(), owner.ID, "no-such-agent", BookmarkItemTypeAgent); err != nil {
		t.Fatalf("Remove: %v", err)
	}
}

func TestBookmarkRepository_CheckItemAccessMatrix(t *testing.T) {
	agents, bookmarks, _, owner, other := newAgentTestEnv(t)
	ctx := context.Background()
	private := seedAgent(t, agents, owner.ID, "Private", "private")
	public := seedAgent(t, agents, owner.ID, "Public", "public")
	readonly := seedAgent(t, agents, owner.ID, "Readonly", "readonly")

	cases := []struct {
		name     string
		itemID   string
		itemType string
		userID   string
		want     bool
	}{
		{"own private agent", private.ID, BookmarkItemTypeAgent, owner.ID, true},
		{"another user's private agent", private.ID, BookmarkItemTypeAgent, other.ID, false},
		{"another user's public agent", public.ID, BookmarkItemTypeAgent, other.ID, true},
		{"another user's readonly agent", readonly.ID, BookmarkItemTypeAgent, other.ID, true},
		{"missing agent", "no-such-id", BookmarkItemTypeAgent, owner.ID, false},
		// Deliberately still false: the TS repository's own "TODO: Add
		// workflow access check when workflows support bookmarking".
		{"workflow", public.ID, BookmarkItemTypeWorkflow, owner.ID, false},
	}
	for _, tc := range cases {
		got, err := bookmarks.CheckItemAccess(ctx, tc.itemID, tc.itemType, tc.userID)
		if err != nil {
			t.Fatalf("%s: CheckItemAccess: %v", tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
