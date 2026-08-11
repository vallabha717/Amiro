package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// WorkflowEdge ports WorkflowEdgeTable (schema.pg.ts:257).
type WorkflowEdge struct {
	ID         string         `gorm:"column:id;primaryKey"`
	Version    string         `gorm:"column:version;not null;default:0.1.0"`
	WorkflowID string         `gorm:"column:workflow_id;not null;index"`
	Source     string         `gorm:"column:source;not null;index"`
	Target     string         `gorm:"column:target;not null;index"`
	UIConfig   datatypes.JSON `gorm:"column:ui_config"`
	CreatedAt  time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
}

func (WorkflowEdge) TableName() string { return "workflow_edge" }

func (e *WorkflowEdge) BeforeCreate(tx *gorm.DB) error {
	if e.ID == "" {
		e.ID = NewID()
	}
	return nil
}
