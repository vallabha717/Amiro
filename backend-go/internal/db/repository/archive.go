package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"amiro/backend/internal/db/models"
)

// ArchiveRepository ports archive-repository.pg.ts in full.
type ArchiveRepository struct {
	db *gorm.DB
}

func NewArchiveRepository(db *gorm.DB) *ArchiveRepository {
	return &ArchiveRepository{db: db}
}

// ArchiveWithItemCount ports ArchiveWithItemCount (types/archive.ts:30).
type ArchiveWithItemCount struct {
	models.Archive
	ItemCount int64
}

// Create ports createArchive (archive-repository.pg.ts:13).
func (r *ArchiveRepository) Create(ctx context.Context, archive *models.Archive) error {
	return r.db.WithContext(ctx).Create(archive).Error
}

// GetByUserID ports getArchivesByUserId (archive-repository.pg.ts:28):
// every archive the user owns, each with its item count, ordered by
// updated_at ascending (the TS `.orderBy(ArchiveTable.updatedAt)` default).
func (r *ArchiveRepository) GetByUserID(ctx context.Context, userID string) ([]ArchiveWithItemCount, error) {
	var rows []struct {
		models.Archive
		ItemCount int64
	}
	err := r.db.WithContext(ctx).
		Table("archive AS a").
		Select(`a.id, a.name, a.description, a.user_id, a.created_at, a.updated_at,
			COUNT(i.id) AS item_count`).
		Joins("LEFT JOIN archive_item AS i ON i.archive_id = a.id").
		Where("a.user_id = ?", userID).
		Group("a.id, a.name, a.description, a.user_id, a.created_at, a.updated_at").
		Order("a.updated_at").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	out := make([]ArchiveWithItemCount, 0, len(rows))
	for _, row := range rows {
		out = append(out, ArchiveWithItemCount{Archive: row.Archive, ItemCount: row.ItemCount})
	}
	return out, nil
}

// GetByID ports getArchiveById (archive-repository.pg.ts:54). Returns
// (nil, nil) when there's no such row, matching the TS `Archive | null`.
func (r *ArchiveRepository) GetByID(ctx context.Context, id string) (*models.Archive, error) {
	var archive models.Archive
	err := r.db.WithContext(ctx).Where("id = ?", id).Take(&archive).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &archive, nil
}

// Update ports updateArchive (archive-repository.pg.ts:62). Both columns
// are always written, matching the TS `.set({ name, description })` -- the
// route above it has already normalized an absent description to null.
func (r *ArchiveRepository) Update(ctx context.Context, id string, name string, description *string) (*models.Archive, error) {
	err := r.db.WithContext(ctx).Model(&models.Archive{}).Where("id = ?", id).
		Updates(map[string]interface{}{
			"name":        name,
			"description": description,
			"updated_at":  time.Now(),
		}).Error
	if err != nil {
		return nil, err
	}
	return r.GetByID(ctx, id)
}

// Delete ports deleteArchive (archive-repository.pg.ts:75): items first,
// then the archive itself. Wrapped in a transaction here (the TS version
// issues two independent statements) so a failure can't leave orphaned
// archive_item rows behind.
func (r *ArchiveRepository) Delete(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("archive_id = ?", id).Delete(&models.ArchiveItem{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", id).Delete(&models.Archive{}).Error
	})
}

// AddItem ports addItemToArchive (archive-repository.pg.ts:80), with one
// deliberate correction.
//
// The TS insert is `.onConflictDoNothing().returning()` -- but there is no
// constraint for it to conflict *on*: ArchiveItemTable (schema.pg.ts:284)
// declares only a primary key on the app-generated id and two plain
// indexes, no UNIQUE over (archive_id, item_id). So the clause never fires
// and re-adding the same thread to the same archive really does insert a
// second row, leaving the archive holding it twice and `.returning()`
// yielding a row the caller then treats as new. Verified against a live
// SQLite DB, not inferred: a straight port of the clause failed
// TestArchiveRepository_AddItemIsIdempotent with two rows.
//
// Rather than change the shared schema (the Drizzle definition is still
// the source of truth for the TS app), this checks for the existing row
// first and returns it unchanged -- the behavior onConflictDoNothing was
// evidently meant to produce. Two truly concurrent AddItem calls for the
// same pair could still race past the check; that needs the missing
// constraint to fix properly, and this is a single-user desktop sidecar
// where the same user would have to double-add in the same instant.
func (r *ArchiveRepository) AddItem(ctx context.Context, archiveID, itemID, userID string) (*models.ArchiveItem, error) {
	var existing models.ArchiveItem
	err := r.db.WithContext(ctx).
		Where("archive_id = ? AND item_id = ?", archiveID, itemID).
		Take(&existing).Error
	if err == nil {
		return &existing, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	item := &models.ArchiveItem{ArchiveID: archiveID, ItemID: itemID, UserID: userID}
	if err := r.db.WithContext(ctx).Create(item).Error; err != nil {
		return nil, err
	}
	return item, nil
}

// RemoveItem ports removeItemFromArchive (archive-repository.pg.ts:95).
func (r *ArchiveRepository) RemoveItem(ctx context.Context, archiveID, itemID string) error {
	return r.db.WithContext(ctx).
		Where("archive_id = ? AND item_id = ?", archiveID, itemID).
		Delete(&models.ArchiveItem{}).Error
}

// GetItems ports getArchiveItems (archive-repository.pg.ts:106).
func (r *ArchiveRepository) GetItems(ctx context.Context, archiveID string) ([]models.ArchiveItem, error) {
	var items []models.ArchiveItem
	err := r.db.WithContext(ctx).
		Where("archive_id = ?", archiveID).Order("added_at").Find(&items).Error
	if err != nil {
		return nil, err
	}
	return items, nil
}

// GetItemArchives ports getItemArchives (archive-repository.pg.ts:115):
// every archive of the caller's that contains the named item.
func (r *ArchiveRepository) GetItemArchives(ctx context.Context, itemID, userID string) ([]models.Archive, error) {
	var archives []models.Archive
	err := r.db.WithContext(ctx).
		Table("archive AS a").
		Select("a.id, a.name, a.description, a.user_id, a.created_at, a.updated_at").
		Joins("INNER JOIN archive_item AS i ON i.archive_id = a.id").
		Where("i.item_id = ? AND a.user_id = ?", itemID, userID).
		Order("a.name").
		Scan(&archives).Error
	if err != nil {
		return nil, err
	}
	return archives, nil
}
