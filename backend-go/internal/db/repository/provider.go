package repository

import (
	"context"
	"encoding/json"
	"time"

	"amiro/backend/internal/db/models"
	"gorm.io/gorm"
)

type ProviderConfigData struct {
	ID       string
	Provider string
	Name     string
	BaseURL  string
	APIKey   string
	Models   []string
}

type ProviderRepository struct {
	db *gorm.DB
}

func NewProviderRepository(db *gorm.DB) *ProviderRepository {
	return &ProviderRepository{db: db}
}

func (r *ProviderRepository) List(ctx context.Context) ([]ProviderConfigData, error) {
	var modelsList []models.ProviderConfig
	if err := r.db.WithContext(ctx).Find(&modelsList).Error; err != nil {
		return nil, err
	}

	var result []ProviderConfigData
	for _, m := range modelsList {
		var parsedModels []string
		if m.Models != "" && m.Models != "[]" {
			_ = json.Unmarshal([]byte(m.Models), &parsedModels)
		}
		result = append(result, ProviderConfigData{
			ID:       m.ID,
			Provider: m.Provider,
			Name:     m.Name,
			BaseURL:  m.BaseURL,
			APIKey:   m.APIKey,
			Models:   parsedModels,
		})
	}
	return result, nil
}

func (r *ProviderRepository) IterateConfigs(ctx context.Context, cb func(id, provider, name, apiKey string, models []string)) error {
	configs, err := r.List(ctx)
	if err != nil {
		return err
	}
	for _, c := range configs {
		cb(c.ID, c.Provider, c.Name, c.APIKey, c.Models)
	}
	return nil
}

func (r *ProviderRepository) Get(ctx context.Context, id string) (*ProviderConfigData, error) {
	var model models.ProviderConfig
	err := r.db.WithContext(ctx).Where("id = ? OR provider = ?", id, id).First(&model).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil // Not found
		}
		return nil, err
	}

	var parsedModels []string
	if model.Models != "" && model.Models != "[]" {
		_ = json.Unmarshal([]byte(model.Models), &parsedModels)
	}

	return &ProviderConfigData{
		ID:       model.ID,
		Provider: model.Provider,
		Name:     model.Name,
		BaseURL:  model.BaseURL,
		APIKey:   model.APIKey,
		Models:   parsedModels,
	}, nil
}

// GetModels returns models for a specific config ID
func (r *ProviderRepository) GetModels(ctx context.Context, id string) ([]string, error) {
	data, err := r.Get(ctx, id)
	if err != nil || data == nil {
		return nil, err
	}
	return data.Models, nil
}

// GetBaseURL returns base url for a specific config ID
func (r *ProviderRepository) GetBaseURL(ctx context.Context, id string) (string, error) {
	data, err := r.Get(ctx, id)
	if err != nil || data == nil {
		return "", err
	}
	return data.BaseURL, nil
}

// GetProviderBaseURLAndKey returns provider type, base URL and API Key for Bifrost
func (r *ProviderRepository) GetProviderBaseURLAndKey(ctx context.Context, id string) (string, string, string, error) {
	data, err := r.Get(ctx, id)
	if err != nil || data == nil {
		return "", "", "", err
	}
	return data.Provider, data.BaseURL, data.APIKey, nil
}

// Set creates or updates a configuration. If id is empty, it creates. Returns the created/updated ID.
//
// An empty apiKey on an *update* leaves the stored key untouched rather than
// clearing it: the editor only sends a key back when the user actually typed
// one, so treating "" as "erase" would silently disconnect a working provider
// whenever someone renamed it or edited its model list.
func (r *ProviderRepository) Set(ctx context.Context, id, provider, name, baseURL, apiKey string, modelsList []string) (string, error) {
	if modelsList == nil {
		modelsList = []string{}
	}
	modelsJSON, _ := json.Marshal(modelsList)

	if id == "" {
		// Create new
		newConfig := models.ProviderConfig{
			Provider: provider,
			Name:     name,
			BaseURL:  baseURL,
			APIKey:   apiKey,
			Models:   string(modelsJSON),
		}
		err := r.db.WithContext(ctx).Create(&newConfig).Error
		return newConfig.ID, err
	}

	// Update existing
	var existing models.ProviderConfig
	err := r.db.WithContext(ctx).Where("id = ?", id).First(&existing).Error
	if err != nil {
		return "", err
	}

	existing.Provider = provider
	existing.Name = name
	existing.BaseURL = baseURL
	if apiKey != "" {
		existing.APIKey = apiKey
	}
	existing.Models = string(modelsJSON)

	err = r.db.WithContext(ctx).Save(&existing).Error
	return existing.ID, err
}

// SetModels replaces just the model list for a config, leaving credentials
// alone -- what the card's "sync models" action needs.
func (r *ProviderRepository) SetModels(ctx context.Context, id string, modelsList []string) error {
	if modelsList == nil {
		modelsList = []string{}
	}
	modelsJSON, _ := json.Marshal(modelsList)
	return r.db.WithContext(ctx).
		Model(&models.ProviderConfig{}).
		Where("id = ?", id).
		Updates(map[string]any{"models": string(modelsJSON), "updated_at": time.Now()}).
		Error
}

func (r *ProviderRepository) Delete(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Where("id = ?", id).Delete(&models.ProviderConfig{}).Error
}
