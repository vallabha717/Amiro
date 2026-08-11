package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// ChatExport ports ChatExportTable (schema.pg.ts:342). Messages mirrors
// ChatMessage.Parts's portability treatment: the source column is a JSON
// array of message snapshots, stored here as one JSON blob.
type ChatExport struct {
	ID               string         `gorm:"column:id;primaryKey"`
	Title            string         `gorm:"column:title;not null"`
	ExporterID       string         `gorm:"column:exporter_id;not null;index"`
	OriginalThreadID *string        `gorm:"column:original_thread_id"`
	Messages         datatypes.JSON `gorm:"column:messages"`
	ExportedAt       time.Time      `gorm:"column:exported_at;not null;autoCreateTime"`
	ExpiresAt        *time.Time     `gorm:"column:expires_at"`
}

func (ChatExport) TableName() string { return "chat_export" }

func (c *ChatExport) BeforeCreate(tx *gorm.DB) error {
	if c.ID == "" {
		c.ID = NewID()
	}
	return nil
}

// ChatExportComment ports ChatExportCommentTable (schema.pg.ts:363).
// ParentID is a self-reference for threaded comments.
type ChatExportComment struct {
	ID        string         `gorm:"column:id;primaryKey"`
	ExportID  string         `gorm:"column:export_id;not null;index"`
	AuthorID  string         `gorm:"column:author_id;not null;index"`
	ParentID  *string        `gorm:"column:parent_id;index"`
	Content   datatypes.JSON `gorm:"column:content;not null"`
	CreatedAt time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt time.Time      `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (ChatExportComment) TableName() string { return "chat_export_comment" }

func (c *ChatExportComment) BeforeCreate(tx *gorm.DB) error {
	if c.ID == "" {
		c.ID = NewID()
	}
	return nil
}
