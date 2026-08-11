package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"betterchatbot/backend/internal/db/models"
)

// McpRepository ports pg-mcp-repository.ts's MCPRepository implementation.
type McpRepository struct {
	db *gorm.DB
}

func NewMcpRepository(db *gorm.DB) *McpRepository {
	return &McpRepository{db: db}
}

var onConflictUpdateMcpServerConfig = clause.OnConflict{
	Columns:   []clause.Column{{Name: "id"}},
	DoUpdates: clause.AssignmentColumns([]string{"config", "updated_at"}),
}

// McpServerWithOwner adds the owning user's display fields to a McpServer
// row, matching selectAllForUser's join (mcp-repository.pg.ts:46) --
// userName/userAvatar are used for ShareableCard display only.
type McpServerWithOwner struct {
	models.McpServer
	OwnerName   *string
	OwnerAvatar *string
}

// Save ports save (mcp-repository.pg.ts:8): insert, or update just
// config/updated_at on conflict. Enabled/Visibility default like the TS
// insert values ("enabled: true", "visibility: server.visibility ??
// 'private'") since GORM's Create would otherwise send Go zero values
// (false, "") that silently defeat the DB's own DEFAULT clauses.
func (r *McpRepository) Save(ctx context.Context, server *models.McpServer) error {
	if server.Visibility == "" {
		server.Visibility = "private"
	}
	if server.ID == "" {
		server.Enabled = true
	}
	server.UpdatedAt = time.Now()
	return r.db.WithContext(ctx).Clauses(onConflictUpdateMcpServerConfig).Create(server).Error
}

func (r *McpRepository) SelectByID(ctx context.Context, id string) (*models.McpServer, error) {
	var s models.McpServer
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&s).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

func (r *McpRepository) SelectByServerName(ctx context.Context, name string) (*models.McpServer, error) {
	var s models.McpServer
	if err := r.db.WithContext(ctx).Where("name = ?", name).First(&s).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &s, nil
}

func (r *McpRepository) SelectAll(ctx context.Context) ([]models.McpServer, error) {
	var servers []models.McpServer
	if err := r.db.WithContext(ctx).Find(&servers).Error; err != nil {
		return nil, err
	}
	return servers, nil
}

// SelectAllForUser ports selectAllForUser (mcp-repository.pg.ts:46): the
// user's own servers plus every public (featured) one, newest first.
func (r *McpRepository) SelectAllForUser(ctx context.Context, userID string) ([]McpServerWithOwner, error) {
	var servers []models.McpServer
	if err := r.db.WithContext(ctx).
		Where("user_id = ? OR visibility = ?", userID, "public").
		Order("created_at DESC").
		Find(&servers).Error; err != nil {
		return nil, err
	}

	ownerIDs := make([]string, 0, len(servers))
	seen := make(map[string]bool, len(servers))
	for _, s := range servers {
		if !seen[s.UserID] {
			seen[s.UserID] = true
			ownerIDs = append(ownerIDs, s.UserID)
		}
	}
	owners := make(map[string]models.User, len(ownerIDs))
	if len(ownerIDs) > 0 {
		var users []models.User
		if err := r.db.WithContext(ctx).Where("id IN ?", ownerIDs).Find(&users).Error; err != nil {
			return nil, err
		}
		for _, u := range users {
			owners[u.ID] = u
		}
	}

	result := make([]McpServerWithOwner, 0, len(servers))
	for _, s := range servers {
		row := McpServerWithOwner{McpServer: s}
		if owner, ok := owners[s.UserID]; ok {
			name := owner.Name
			row.OwnerName = &name
			row.OwnerAvatar = owner.Image
		}
		result = append(result, row)
	}
	return result, nil
}

func (r *McpRepository) UpdateVisibility(ctx context.Context, id, visibility string) error {
	return r.db.WithContext(ctx).Model(&models.McpServer{}).Where("id = ?", id).
		Updates(map[string]any{"visibility": visibility, "updated_at": time.Now()}).Error
}

func (r *McpRepository) DeleteByID(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Where("id = ?", id).Delete(&models.McpServer{}).Error
}

func (r *McpRepository) ExistsByServerName(ctx context.Context, name string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.McpServer{}).Where("name = ?", name).Count(&count).Error
	return count > 0, err
}

func (r *McpRepository) UpdateToolInfo(ctx context.Context, id string, toolInfo datatypes.JSON) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&models.McpServer{}).Where("id = ?", id).
		Updates(map[string]any{"tool_info": toolInfo, "tool_info_updated_at": now, "updated_at": now}).Error
}

// UpdateConnectionStatus ports updateConnectionStatus (mcp-repository.pg.ts:103).
// status must be "connected", "error", or "authorizing" (added by
// migration 0020 for internal/mcp/oauth's flow -- not in the TS
// MCPConnectionStatus type at all, a Go-side-only persisted status) -- the
// DB CHECK constraint enforces this; "disconnected" is excluded on
// purpose, a live-only status never persisted.
func (r *McpRepository) UpdateConnectionStatus(ctx context.Context, id, status string) error {
	return r.db.WithContext(ctx).Model(&models.McpServer{}).Where("id = ?", id).
		Updates(map[string]any{"last_connection_status": status, "updated_at": time.Now()}).Error
}
