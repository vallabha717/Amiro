package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
)

// User ports UserTable (src/lib/db/pg/schema.pg.ts:104). Role is the plain
// string this codebase already settled on ("Role tables removed - using
// Better Auth's built-in role system" per the source comment) -- Phase 2's
// auth package assigns it, this struct just stores it.
type User struct {
	ID            string         `gorm:"column:id;primaryKey"`
	Name          string         `gorm:"column:name;not null"`
	Email         string         `gorm:"column:email;not null;uniqueIndex"`
	EmailVerified bool           `gorm:"column:email_verified;not null;default:false"`
	Password      *string        `gorm:"column:password"`
	Image         *string        `gorm:"column:image"`
	Preferences   datatypes.JSON `gorm:"column:preferences"`
	CreatedAt     time.Time      `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt     time.Time      `gorm:"column:updated_at;not null;autoUpdateTime"`
	Banned        *bool          `gorm:"column:banned"`
	BanReason     *string        `gorm:"column:ban_reason"`
	BanExpires    *time.Time     `gorm:"column:ban_expires"`
	Role          string         `gorm:"column:role;not null;default:user"`
}

func (User) TableName() string { return "user" }

func (u *User) BeforeCreate(tx *gorm.DB) error {
	if u.ID == "" {
		u.ID = NewID()
	}
	return nil
}
