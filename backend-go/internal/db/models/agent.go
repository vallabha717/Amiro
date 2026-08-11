package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// Agent ports AgentTable (schema.pg.ts:42).
type Agent struct {
	ID           string         `gorm:"column:id;primaryKey"`
	Name         string         `gorm:"column:name;not null"`
	Description  *string        `gorm:"column:description"`
	Icon         datatypes.JSON `gorm:"column:icon"`
	UserID       string         `gorm:"column:user_id;not null;index"`
	Instructions datatypes.JSON `gorm:"column:instructions"`
	Visibility   string         `gorm:"column:visibility;not null;default:private"`
	CreatedAt    time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt    time.Time      `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (Agent) TableName() string { return "agent" }

func (a *Agent) BeforeCreate(tx *gorm.DB) error {
	if a.ID == "" {
		a.ID = NewID()
	}
	return nil
}
