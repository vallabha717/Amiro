package models

import (
	"time"

	"gorm.io/gorm"
)

// ChatThread ports ChatThreadTable (schema.pg.ts:22).
type ChatThread struct {
	ID        string    `gorm:"column:id;primaryKey"`
	Title     string    `gorm:"column:title;not null"`
	UserID    string    `gorm:"column:user_id;not null;index"`
	CreatedAt time.Time `gorm:"column:created_at;not null;autoCreateTime"`
}

func (ChatThread) TableName() string { return "chat_thread" }

func (t *ChatThread) BeforeCreate(tx *gorm.DB) error {
	if t.ID == "" {
		t.ID = NewID()
	}
	return nil
}
