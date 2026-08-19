package repository

import (
	"context"
	"errors"

	"amiro/backend/internal/db/models"
	"gorm.io/gorm"
)

// ErrSearchProviderNotFound is returned when an id names no stored config.
// A distinct error so the API can answer 404 rather than 500 -- updating or
// activating something that was deleted in another tab is a client mistake,
// not a server fault.
var ErrSearchProviderNotFound = errors.New("search provider not found")

type SearchProviderConfigData struct {
	ID       string
	Provider string
	Name     string
	APIKey   string
	IsActive bool
}

type SearchProviderRepository struct {
	db *gorm.DB
}

func NewSearchProviderRepository(db *gorm.DB) *SearchProviderRepository {
	return &SearchProviderRepository{db: db}
}

func toData(m models.SearchProviderConfig) SearchProviderConfigData {
	return SearchProviderConfigData{
		ID:       m.ID,
		Provider: m.Provider,
		Name:     m.Name,
		APIKey:   m.APIKey,
		IsActive: m.IsActive,
	}
}

// List returns every stored config, oldest first.
//
// Ordered, because an unordered list re-shuffles the admin table on every
// refresh under some drivers, and a row moving while you are reaching for
// its delete button is how the wrong provider gets deleted.
func (r *SearchProviderRepository) List(ctx context.Context) ([]SearchProviderConfigData, error) {
	var rows []models.SearchProviderConfig
	if err := r.db.WithContext(ctx).Order("created_at ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SearchProviderConfigData, 0, len(rows))
	for _, m := range rows {
		out = append(out, toData(m))
	}
	return out, nil
}

func (r *SearchProviderRepository) Get(ctx context.Context, id string) (*SearchProviderConfigData, error) {
	var m models.SearchProviderConfig
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&m).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	data := toData(m)
	return &data, nil
}

// GetActive returns the active config, or nil when none is.
//
// Ordered by id so that two rows somehow both carrying is_active -- a hand
// edit, a restore from a backup taken mid-transaction -- resolve to the same
// one on every call. An arbitrary winner would mean searches alternating
// between providers with nothing to point at.
func (r *SearchProviderRepository) GetActive(ctx context.Context) (*SearchProviderConfigData, error) {
	var m models.SearchProviderConfig
	err := r.db.WithContext(ctx).Where("is_active = ?", true).Order("id ASC").First(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	data := toData(m)
	return &data, nil
}

// Set creates or updates a config and returns its id.
//
// An empty APIKey on an update preserves the stored one. That is what lets
// the admin form round-trip without ever sending the real key back to the
// browser: the UI shows a masked placeholder, submits it empty unless the
// user typed a new one, and the key never leaves the server.
func (r *SearchProviderRepository) Set(ctx context.Context, id, provider, name, apiKey string) (string, error) {
	if id == "" {
		row := models.SearchProviderConfig{Provider: provider, Name: name, APIKey: apiKey}
		if err := r.db.WithContext(ctx).Create(&row).Error; err != nil {
			return "", err
		}
		return row.ID, nil
	}

	var existing models.SearchProviderConfig
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", ErrSearchProviderNotFound
		}
		return "", err
	}

	existing.Provider = provider
	existing.Name = name
	if apiKey != "" {
		existing.APIKey = apiKey
	}
	if err := r.db.WithContext(ctx).Save(&existing).Error; err != nil {
		return "", err
	}
	return existing.ID, nil
}

// SetActive makes one config the active one and every other inactive.
func (r *SearchProviderRepository) SetActive(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var target models.SearchProviderConfig
		if err := tx.Where("id = ?", id).First(&target).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrSearchProviderNotFound
			}
			return err
		}
		if err := tx.Model(&models.SearchProviderConfig{}).
			Where("is_active = ?", true).Update("is_active", false).Error; err != nil {
			return err
		}
		return tx.Model(&models.SearchProviderConfig{}).
			Where("id = ?", id).Update("is_active", true).Error
	})
}

// Delete removes a config, promoting another to active if this was the one.
//
// Without the promotion, deleting the active provider leaves web search
// switched off with nothing on screen saying so -- the tools report "no
// provider is active" while the admin page still lists working providers,
// and the user has no reason to connect the two. Promoting the oldest
// remaining one keeps the invariant "if any provider exists, one is active",
// which is the state the rest of this feature is written against.
func (r *SearchProviderRepository) Delete(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var target models.SearchProviderConfig
		if err := tx.Where("id = ?", id).First(&target).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrSearchProviderNotFound
			}
			return err
		}
		if err := tx.Where("id = ?", id).Delete(&models.SearchProviderConfig{}).Error; err != nil {
			return err
		}
		if !target.IsActive {
			return nil
		}

		var next models.SearchProviderConfig
		err := tx.Order("created_at ASC, id ASC").First(&next).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil // that was the last one
		}
		if err != nil {
			return err
		}
		return tx.Model(&models.SearchProviderConfig{}).
			Where("id = ?", next.ID).Update("is_active", true).Error
	})
}
