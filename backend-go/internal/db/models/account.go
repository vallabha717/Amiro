package models

import (
	"time"

	"gorm.io/gorm"
)

// Account ports AccountTable (schema.pg.ts:138) -- linked-identity rows for
// non-password sign-in (OAuth, etc). Not exercised by Phase 2 (which only
// wires password + desktop auto-login) but kept for schema parity so a
// later web-deploy OAuth addition has a table to write to without a new
// migration.
type Account struct {
	ID                    string     `gorm:"column:id;primaryKey"`
	AccountID             string     `gorm:"column:account_id;not null"`
	ProviderID            string     `gorm:"column:provider_id;not null"`
	UserID                string     `gorm:"column:user_id;not null;index"`
	AccessToken           *string    `gorm:"column:access_token"`
	RefreshToken          *string    `gorm:"column:refresh_token"`
	IDToken               *string    `gorm:"column:id_token"`
	AccessTokenExpiresAt  *time.Time `gorm:"column:access_token_expires_at"`
	RefreshTokenExpiresAt *time.Time `gorm:"column:refresh_token_expires_at"`
	Scope                 *string    `gorm:"column:scope"`
	Password              *string    `gorm:"column:password"`
	CreatedAt             time.Time  `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt             time.Time  `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (Account) TableName() string { return "account" }

func (a *Account) BeforeCreate(tx *gorm.DB) error {
	if a.ID == "" {
		a.ID = NewID()
	}
	return nil
}
