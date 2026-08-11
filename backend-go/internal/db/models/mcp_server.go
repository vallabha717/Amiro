package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// McpServer ports McpServerTable (schema.pg.ts:82).
type McpServer struct {
	ID                   string         `gorm:"column:id;primaryKey"`
	Name                 string         `gorm:"column:name;not null"`
	Config               datatypes.JSON `gorm:"column:config;not null"`
	Enabled              bool           `gorm:"column:enabled;not null;default:true"`
	UserID               string         `gorm:"column:user_id;not null;index"`
	Visibility           string         `gorm:"column:visibility;not null;default:private"`
	ToolInfo             datatypes.JSON `gorm:"column:tool_info"`
	ToolInfoUpdatedAt    *time.Time     `gorm:"column:tool_info_updated_at"`
	LastConnectionStatus *string        `gorm:"column:last_connection_status"`
	CreatedAt            time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt            time.Time      `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (McpServer) TableName() string { return "mcp_server" }

func (m *McpServer) BeforeCreate(tx *gorm.DB) error {
	if m.ID == "" {
		m.ID = NewID()
	}
	return nil
}
