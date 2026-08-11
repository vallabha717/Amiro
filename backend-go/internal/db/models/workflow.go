package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Workflow ports WorkflowTable (schema.pg.ts:213).
type Workflow struct {
	ID          string         `gorm:"column:id;primaryKey"`
	Version     string         `gorm:"column:version;not null;default:0.1.0"`
	Name        string         `gorm:"column:name;not null"`
	Icon        datatypes.JSON `gorm:"column:icon"`
	Description *string        `gorm:"column:description"`
	IsPublished bool           `gorm:"column:is_published;not null;default:false"`
	Visibility  string         `gorm:"column:visibility;not null;default:private"`
	UserID      string         `gorm:"column:user_id;not null;index"`
	CreatedAt   time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt   time.Time      `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (Workflow) TableName() string { return "workflow" }

func (w *Workflow) BeforeCreate(tx *gorm.DB) error {
	if w.ID == "" {
		w.ID = NewID()
	}
	return nil
}
