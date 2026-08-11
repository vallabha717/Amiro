package models

import (
	"time"

	"gorm.io/gorm"
)

// Archive ports ArchiveTable (schema.pg.ts:273).
type Archive struct {
	ID          string    `gorm:"column:id;primaryKey"`
	Name        string    `gorm:"column:name;not null"`
	Description *string   `gorm:"column:description"`
	UserID      string    `gorm:"column:user_id;not null;index"`
	CreatedAt   time.Time `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt   time.Time `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (Archive) TableName() string { return "archive" }

func (a *Archive) BeforeCreate(tx *gorm.DB) error {
	if a.ID == "" {
		a.ID = NewID()
	}
	return nil
}

// ArchiveItem ports ArchiveItemTable (schema.pg.ts:284).
type ArchiveItem struct {
	ID        string    `gorm:"column:id;primaryKey"`
	ArchiveID string    `gorm:"column:archive_id;not null;index"`
	ItemID    string    `gorm:"column:item_id;not null;index"`
	UserID    string    `gorm:"column:user_id;not null"`
	AddedAt   time.Time `gorm:"column:added_at;not null;autoCreateTime"`
}

func (ArchiveItem) TableName() string { return "archive_item" }

func (a *ArchiveItem) BeforeCreate(tx *gorm.DB) error {
	if a.ID == "" {
		a.ID = NewID()
	}
	return nil
}
