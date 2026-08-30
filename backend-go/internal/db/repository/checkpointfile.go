package repository

import (
	"context"
	"errors"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"amiro/backend/internal/db/models"
)

// maxCheckpointFilesPerThread bounds one thread's index, mirroring
// internal/agent/memory's 200-entry cap with oldest-first eviction
// (docs/coding-agent-parity/02-checkpoints-and-rewind.md: "a deliberate,
// named bound, not an unbounded append that becomes a storage problem
// nobody planned for"). Eviction drops index rows only -- the underlying
// blobs are content-addressed and may still be referenced by another
// turn's row, so they are never deleted here.
const maxCheckpointFilesPerThread = 200

// CheckpointFileRepository is the index over one turn's captured file
// pre-images. The bytes themselves live in the blob store passed to
// internal/agent/checkpoint's Capturer and Restore -- this type only ever
// reads and writes the row.
type CheckpointFileRepository struct {
	db *gorm.DB
}

func NewCheckpointFileRepository(db *gorm.DB) *CheckpointFileRepository {
	return &CheckpointFileRepository{db: db}
}

// HasCheckpoint reports whether path already has a captured pre-image for
// this turn -- checked before reading the file's current bytes, so a second
// write to the same path within one turn does not re-capture (and silently
// overwrite the true pre-image with the state the turn's own first edit
// already produced).
func (r *CheckpointFileRepository) HasCheckpoint(ctx context.Context, threadID, turnID, path string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.CheckpointFile{}).
		Where("thread_id = ? AND turn_id = ? AND path = ?", threadID, turnID, path).
		Count(&count).Error
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// Capture records f's pre-image row, idempotently -- a second capture for
// the same (thread_id, turn_id, path) is a no-op via the migration's unique
// index, never a second row. Applies the retention cap afterward.
func (r *CheckpointFileRepository) Capture(ctx context.Context, f models.CheckpointFile) error {
	if err := r.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&f).Error; err != nil {
		return err
	}
	return r.evictOverCap(ctx, f.ThreadID)
}

// evictOverCap drops the oldest rows for threadID once it holds more than
// maxCheckpointFilesPerThread. The subquery form (rather than a bare
// DELETE ... ORDER BY ... LIMIT) is what makes this portable across sqlite
// and postgres -- neither dialect's DELETE reliably supports ORDER BY/LIMIT
// the same way, but both support LIMIT inside a subquery.
func (r *CheckpointFileRepository) evictOverCap(ctx context.Context, threadID string) error {
	return r.db.WithContext(ctx).Exec(
		`DELETE FROM checkpoint_files WHERE thread_id = ? AND id NOT IN (
			SELECT id FROM checkpoint_files WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?
		)`, threadID, threadID, maxCheckpointFilesPerThread).Error
}

// ListForTurn returns every checkpointed file for (threadID, turnID), in
// capture order -- what the restore confirmation (both surfaces) and
// Restore itself both read.
func (r *CheckpointFileRepository) ListForTurn(ctx context.Context, threadID, turnID string) ([]models.CheckpointFile, error) {
	var rows []models.CheckpointFile
	err := r.db.WithContext(ctx).
		Where("thread_id = ? AND turn_id = ?", threadID, turnID).
		Order("created_at ASC").
		Find(&rows).Error
	return rows, err
}

// MostRecentTurnWithCheckpoints returns the newest checkpointed turn's id
// for threadID -- what the TUI's /rewind and Esc-Esc resolve "the most
// recent turn" against. found is false when the thread has nothing to
// rewind, which callers render as a clear "nothing to rewind" state rather
// than an empty confirmation dialog.
func (r *CheckpointFileRepository) MostRecentTurnWithCheckpoints(ctx context.Context, threadID string) (turnID string, found bool, err error) {
	var row models.CheckpointFile
	err = r.db.WithContext(ctx).
		Where("thread_id = ?", threadID).
		Order("created_at DESC").
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return row.TurnID, true, nil
}
