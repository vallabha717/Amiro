package models

import (
	"time"

	"gorm.io/gorm"
)

// SearchProviderConfig is one stored web-search provider.
//
// The table still has a base_url column (migration 0022) that this struct
// deliberately omits: it existed for SearxNG, which is gone, and every
// surviving provider authenticates with a key alone. The column keeps its
// NOT NULL DEFAULT '' so inserts that never mention it still succeed -- see
// migration 0023 for why it was not dropped outright.
type SearchProviderConfig struct {
	ID        string    `gorm:"column:id;primaryKey"`
	Provider  string    `gorm:"column:provider;not null"`
	Name      string    `gorm:"column:name;not null"`
	APIKey    string    `gorm:"column:api_key;not null;default:''"`
	IsActive  bool      `gorm:"column:is_active;not null;default:false"`
	CreatedAt time.Time `gorm:"column:created_at;not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"column:updated_at;not null;autoUpdateTime"`
}

func (SearchProviderConfig) TableName() string { return "search_provider_config" }

func (s *SearchProviderConfig) BeforeCreate(tx *gorm.DB) error {
	if s.ID == "" {
		s.ID = NewID()
	}
	return nil
}
