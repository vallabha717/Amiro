package models

import (
	"time"

	"gorm.io/gorm"
)

// ProviderConfig stores custom configurations (Base URL, specific models) for a provider.
type ProviderConfig struct {
	ID        string `gorm:"primaryKey"`
	Provider  string // e.g. "openai"
	Name      string // User-defined name
	BaseURL   string
	APIKey    string
	Models    string `gorm:"type:text"` // Stored as a JSON array of strings
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (ProviderConfig) TableName() string {
	return "provider_config"
}

func (p *ProviderConfig) BeforeCreate(tx *gorm.DB) error {
	if p.ID == "" {
		p.ID = NewID()
	}
	return nil
}
