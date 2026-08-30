package models

import (
	"time"

	"gorm.io/gorm"
)

// CheckpointFile is one file's pre-image index row -- the bytes themselves
// live in the content-addressed blob store (internal/storage), keyed by
// BlobKey. See migrations/sqlite/0026_checkpoint_files.up.sql for why
// ResolvedRoot travels with Path rather than being assumed at restore time.
type CheckpointFile struct {
	ID           string `gorm:"column:id;primaryKey"`
	ThreadID     string `gorm:"column:thread_id;not null"`
	TurnID       string `gorm:"column:turn_id;not null"`
	Path         string `gorm:"column:path;not null"`
	ResolvedRoot string `gorm:"column:resolved_root;not null"`

	// BlobKey is empty when ExistedBefore is false -- a file the turn
	// created, not overwrote, has no pre-image bytes to store.
	BlobKey       string    `gorm:"column:blob_key"`
	ExistedBefore bool      `gorm:"column:existed_before;not null"`
	CreatedAt     time.Time `gorm:"column:created_at;not null;autoCreateTime"`
}

func (CheckpointFile) TableName() string { return "checkpoint_files" }

func (c *CheckpointFile) BeforeCreate(tx *gorm.DB) error {
	if c.ID == "" {
		c.ID = NewID()
	}
	return nil
}
