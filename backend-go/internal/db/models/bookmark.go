package models

import (
	"time"

	"gorm.io/gorm"
)

// Bookmark ports BookmarkTable (schema.pg.ts:60). The composite
// uniqueness constraint (userId, itemId, itemType) and the two lookup
// indexes are declared in the migration SQL, not here -- GORM tags aren't
// used for schema creation (plan section 3, AutoMigrate is not the
// migration path).
type Bookmark struct {
	ID        string    `gorm:"column:id;primaryKey"`
	UserID    string    `gorm:"column:user_id;not null"`
	ItemID    string    `gorm:"column:item_id;not null"`
	ItemType  string    `gorm:"column:item_type;not null"`
	CreatedAt time.Time `gorm:"column:created_at;not null;autoCreateTime"`
}

func (Bookmark) TableName() string { return "bookmark" }

func (b *Bookmark) BeforeCreate(tx *gorm.DB) error {
	if b.ID == "" {
		b.ID = NewID()
	}
	return nil
}
