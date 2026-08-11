package models

import (
	"time"

	"gorm.io/gorm"
)

// Verification ports VerificationTable (schema.pg.ts:156) -- email
// verification / password-reset tokens.
type Verification struct {
	ID         string     `gorm:"column:id;primaryKey"`
	Identifier string     `gorm:"column:identifier;not null"`
	Value      string     `gorm:"column:value;not null"`
	ExpiresAt  time.Time  `gorm:"column:expires_at;not null"`
	CreatedAt  *time.Time `gorm:"column:created_at"`
	UpdatedAt  *time.Time `gorm:"column:updated_at"`
}

func (Verification) TableName() string { return "verification" }

func (v *Verification) BeforeCreate(tx *gorm.DB) error {
	if v.ID == "" {
		v.ID = NewID()
	}
	return nil
}
