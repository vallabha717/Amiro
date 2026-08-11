package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// WorkflowNode ports WorkflowNodeDataTable (schema.pg.ts:232), table name
// "workflow_node" in the source schema.
type WorkflowNode struct {
	ID          string         `gorm:"column:id;primaryKey"`
	Version     string         `gorm:"column:version;not null;default:0.1.0"`
	WorkflowID  string         `gorm:"column:workflow_id;not null;index"`
	Kind        string         `gorm:"column:kind;not null;index"`
	Name        string         `gorm:"column:name;not null"`
	Description *string        `gorm:"column:description"`
	UIConfig    datatypes.JSON `gorm:"column:ui_config"`
	NodeConfig  datatypes.JSON `gorm:"column:node_config"`
	CreatedAt   time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt   time.Time      `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (WorkflowNode) TableName() string { return "workflow_node" }

func (n *WorkflowNode) BeforeCreate(tx *gorm.DB) error {
	if n.ID == "" {
		n.ID = NewID()
	}
	return nil
}
