package models

import (
	"time"

	"gorm.io/gorm"
)

// McpToolCustomization ports McpToolCustomizationTable (schema.pg.ts:170),
// table name "mcp_server_tool_custom_instructions" in the source schema --
// kept as-is rather than renamed, since the migration must match the real
// table so any future data import lines up.
type McpToolCustomization struct {
	ID          string    `gorm:"column:id;primaryKey"`
	UserID      string    `gorm:"column:user_id;not null"`
	ToolName    string    `gorm:"column:tool_name;not null"`
	McpServerID string    `gorm:"column:mcp_server_id;not null"`
	Prompt      *string   `gorm:"column:prompt"`
	CreatedAt   time.Time `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt   time.Time `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (McpToolCustomization) TableName() string { return "mcp_server_tool_custom_instructions" }

func (m *McpToolCustomization) BeforeCreate(tx *gorm.DB) error {
	if m.ID == "" {
		m.ID = NewID()
	}
	return nil
}

// McpServerCustomization ports McpServerCustomizationTable
// (schema.pg.ts:192), table name "mcp_server_custom_instructions".
type McpServerCustomization struct {
	ID          string    `gorm:"column:id;primaryKey"`
	UserID      string    `gorm:"column:user_id;not null"`
	McpServerID string    `gorm:"column:mcp_server_id;not null"`
	Prompt      *string   `gorm:"column:prompt"`
	CreatedAt   time.Time `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt   time.Time `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (McpServerCustomization) TableName() string { return "mcp_server_custom_instructions" }

func (m *McpServerCustomization) BeforeCreate(tx *gorm.DB) error {
	if m.ID == "" {
		m.ID = NewID()
	}
	return nil
}
