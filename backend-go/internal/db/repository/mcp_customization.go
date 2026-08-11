package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"betterchatbot/backend/internal/db/models"
)

// McpServerCustomizationRepository ports
// pg-mcp-server-customization-repository.pg.ts.
type McpServerCustomizationRepository struct {
	db *gorm.DB
}

func NewMcpServerCustomizationRepository(db *gorm.DB) *McpServerCustomizationRepository {
	return &McpServerCustomizationRepository{db: db}
}

var onConflictUpdateServerCustomizationPrompt = clause.OnConflict{
	Columns:   []clause.Column{{Name: "user_id"}, {Name: "mcp_server_id"}},
	DoUpdates: clause.AssignmentColumns([]string{"prompt", "updated_at"}),
}

func (r *McpServerCustomizationRepository) SelectByUserIDAndServerID(ctx context.Context, userID, serverID string) (*models.McpServerCustomization, error) {
	var c models.McpServerCustomization
	err := r.db.WithContext(ctx).Where("user_id = ? AND mcp_server_id = ?", userID, serverID).First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *McpServerCustomizationRepository) SelectByUserID(ctx context.Context, userID string) ([]models.McpServerCustomization, error) {
	var rows []models.McpServerCustomization
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *McpServerCustomizationRepository) Upsert(ctx context.Context, userID, serverID string, prompt *string) (*models.McpServerCustomization, error) {
	row := &models.McpServerCustomization{UserID: userID, McpServerID: serverID, Prompt: prompt, UpdatedAt: time.Now()}
	if err := r.db.WithContext(ctx).Clauses(onConflictUpdateServerCustomizationPrompt).Create(row).Error; err != nil {
		return nil, err
	}
	return r.SelectByUserIDAndServerID(ctx, userID, serverID)
}

func (r *McpServerCustomizationRepository) DeleteByUserIDAndServerID(ctx context.Context, userID, serverID string) error {
	return r.db.WithContext(ctx).Where("user_id = ? AND mcp_server_id = ?", userID, serverID).Delete(&models.McpServerCustomization{}).Error
}

// McpToolCustomizationRepository ports
// pg-mcp-tool-customization-repository.pg.ts.
type McpToolCustomizationRepository struct {
	db *gorm.DB
}

func NewMcpToolCustomizationRepository(db *gorm.DB) *McpToolCustomizationRepository {
	return &McpToolCustomizationRepository{db: db}
}

var onConflictUpdateToolCustomizationPrompt = clause.OnConflict{
	Columns:   []clause.Column{{Name: "user_id"}, {Name: "tool_name"}, {Name: "mcp_server_id"}},
	DoUpdates: clause.AssignmentColumns([]string{"prompt", "updated_at"}),
}

func (r *McpToolCustomizationRepository) Select(ctx context.Context, userID, serverID, toolName string) (*models.McpToolCustomization, error) {
	var c models.McpToolCustomization
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND mcp_server_id = ? AND tool_name = ?", userID, serverID, toolName).
		First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *McpToolCustomizationRepository) SelectByUserIDAndServerID(ctx context.Context, userID, serverID string) ([]models.McpToolCustomization, error) {
	var rows []models.McpToolCustomization
	if err := r.db.WithContext(ctx).Where("user_id = ? AND mcp_server_id = ?", userID, serverID).Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *McpToolCustomizationRepository) SelectByUserID(ctx context.Context, userID string) ([]models.McpToolCustomization, error) {
	var rows []models.McpToolCustomization
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *McpToolCustomizationRepository) Upsert(ctx context.Context, userID, serverID, toolName string, prompt *string) (*models.McpToolCustomization, error) {
	row := &models.McpToolCustomization{UserID: userID, McpServerID: serverID, ToolName: toolName, Prompt: prompt, UpdatedAt: time.Now()}
	if err := r.db.WithContext(ctx).Clauses(onConflictUpdateToolCustomizationPrompt).Create(row).Error; err != nil {
		return nil, err
	}
	return r.Select(ctx, userID, serverID, toolName)
}

func (r *McpToolCustomizationRepository) Delete(ctx context.Context, userID, serverID, toolName string) error {
	return r.db.WithContext(ctx).
		Where("user_id = ? AND mcp_server_id = ? AND tool_name = ?", userID, serverID, toolName).
		Delete(&models.McpToolCustomization{}).Error
}
