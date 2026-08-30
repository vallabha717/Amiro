package models

import (
	"time"

	"gorm.io/gorm"
)

// WorkspaceTrust is one user's consent for the agent to write to or run
// commands in resolved_root. See migrations/sqlite/0025_workspace_trust.up.sql
// for why the grant is keyed on the symlink-resolved root rather than the
// raw path a client supplied.
type WorkspaceTrust struct {
	ID           string    `gorm:"column:id;primaryKey"`
	UserID       string    `gorm:"column:user_id;not null"`
	ResolvedRoot string    `gorm:"column:resolved_root;not null"`
	GrantedAt    time.Time `gorm:"column:granted_at;not null;autoCreateTime"`
	GrantedVia   string    `gorm:"column:granted_via;not null"`
}

func (WorkspaceTrust) TableName() string { return "workspace_trust" }

func (w *WorkspaceTrust) BeforeCreate(tx *gorm.DB) error {
	if w.ID == "" {
		w.ID = NewID()
	}
	return nil
}
