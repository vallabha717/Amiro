package repository

import (
	"context"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"amiro/backend/internal/db/models"
)

// Bookmark item types, matching the CHECK constraint the bookmark
// migration declares and the z.enum(["agent", "workflow"]) the TS
// bookmark route validates against (bookmark/route.ts:7). Agent was
// dropped in Phase 6 (docs/skills/); the CHECK constraint itself still
// permits it -- see migrations/sqlite/0024_drop_agent.up.sql's comment for
// why that's left alone rather than rebuilding the table.
const (
	BookmarkItemTypeWorkflow = "workflow"
)

// BookmarkRepository ports bookmark-repository.pg.ts. toggleBookmark is not
// ported: it's a pure convenience wrapper over create/remove with no route
// of its own (its TS call sites are Server Actions, Phase 7's job), and the
// HTTP surface here already exposes both halves separately.
type BookmarkRepository struct {
	db *gorm.DB
}

func NewBookmarkRepository(db *gorm.DB) *BookmarkRepository {
	return &BookmarkRepository{db: db}
}

// Create ports createBookmark (bookmark-repository.pg.ts:33): idempotent,
// via the (user_id, item_id, item_type) unique constraint the migration
// declares -- the same .onConflictDoNothing() the TS insert uses.
func (r *BookmarkRepository) Create(ctx context.Context, userID, itemID, itemType string) error {
	bookmark := &models.Bookmark{UserID: userID, ItemID: itemID, ItemType: itemType}
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(bookmark).Error
}

// Remove ports removeBookmark (bookmark-repository.pg.ts:44).
func (r *BookmarkRepository) Remove(ctx context.Context, userID, itemID, itemType string) error {
	return r.db.WithContext(ctx).
		Where("user_id = ? AND item_id = ? AND item_type = ?", userID, itemID, itemType).
		Delete(&models.Bookmark{}).Error
}

// CheckItemAccess ports checkItemAccess (bookmark-repository.pg.ts:66).
// Agent was the only item type this ever granted (public/readonly or the
// caller's own); it was decommissioned in Phase 6. Workflow already always
// returned false here, matching the TS "TODO: Add workflow access check
// when workflows support bookmarking" -- deliberately preserved rather than
// "fixed", since changing it would let the UI bookmark something no list
// query ever reports back. With agent gone, every itemType now denies,
// which makes POST /api/bookmark permanently a 404 -- a real, inert
// endpoint, recorded rather than silently removed (progress/phase-06).
func (r *BookmarkRepository) CheckItemAccess(ctx context.Context, itemID, itemType, userID string) (bool, error) {
	return false, nil
}
