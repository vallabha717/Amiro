package models

import (
	"time"

	"gorm.io/gorm"
)

// Session ports SessionTable (schema.pg.ts:123). Phase 2's auth package
// issues Token as a plain random string (no JWT), per plan section 3's
// resolved decision.
type Session struct {
	ID             string    `gorm:"column:id;primaryKey"`
	ExpiresAt      time.Time `gorm:"column:expires_at;not null"`
	Token          string    `gorm:"column:token;not null;uniqueIndex"`
	CreatedAt      time.Time `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt      time.Time `gorm:"column:updated_at;not null;autoUpdateTime"`
	IPAddress      *string   `gorm:"column:ip_address"`
	UserAgent      *string   `gorm:"column:user_agent"`
	UserID         string    `gorm:"column:user_id;not null;index"`
	ImpersonatedBy *string   `gorm:"column:impersonated_by"`
}

func (Session) TableName() string { return "session" }

func (s *Session) BeforeCreate(tx *gorm.DB) error {
	if s.ID == "" {
		s.ID = NewID()
	}
	return nil
}
