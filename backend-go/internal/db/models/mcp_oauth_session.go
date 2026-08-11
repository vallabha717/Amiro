package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// McpOAuthSession ports McpOAuthSessionTable (schema.pg.ts:300). The
// partial index on (mcp_server_id) WHERE tokens IS NOT NULL from the source
// schema is Postgres-specific syntax (SQLite supports partial indexes too,
// same WHERE clause, so it is kept in both dialect migrations rather than
// dropped).
type McpOAuthSession struct {
	ID           string         `gorm:"column:id;primaryKey"`
	McpServerID  string         `gorm:"column:mcp_server_id;not null;index"`
	ServerURL    string         `gorm:"column:server_url;not null"`
	ClientInfo   datatypes.JSON `gorm:"column:client_info"`
	Tokens       datatypes.JSON `gorm:"column:tokens"`
	CodeVerifier *string        `gorm:"column:code_verifier"`
	State        *string        `gorm:"column:state;uniqueIndex"`
	CreatedAt    time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt    time.Time      `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (McpOAuthSession) TableName() string { return "mcp_oauth_session" }

func (m *McpOAuthSession) BeforeCreate(tx *gorm.DB) error {
	if m.ID == "" {
		m.ID = NewID()
	}
	return nil
}
