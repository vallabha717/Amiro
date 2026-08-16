package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"

	"amiro/backend/internal/db/models"
)

// ChatExportRepository ports chat-export-repository.pg.ts: the exportChat
// snapshot Phase 3's POST /api/chat/export calls, plus (Phase 6) the
// listing, single-export read, expiry check, and threaded-comment CRUD the
// separate `src/app/api/export/**` routes need.
type ChatExportRepository struct {
	db   *gorm.DB
	chat *ChatRepository
}

func NewChatExportRepository(db *gorm.DB, chat *ChatRepository) *ChatExportRepository {
	return &ChatExportRepository{db: db, chat: chat}
}

// exportedMessage mirrors exportChat's per-message snapshot shape
// (chat-export-repository.pg.ts:51-56): only id/role/parts/metadata, not
// threadId/createdAt.
type exportedMessage struct {
	ID       string          `json:"id"`
	Role     string          `json:"role"`
	Parts    json.RawMessage `json:"parts"`
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

// ExportChat ports exportChat (chat-export-repository.pg.ts:38): snapshots
// a thread's current messages into a new chat_export row.
func (r *ChatExportRepository) ExportChat(ctx context.Context, threadID, exporterID string, expiresAt *time.Time) (string, error) {
	thread, err := r.chat.SelectThread(ctx, threadID)
	if err != nil {
		return "", err
	}
	if thread == nil {
		return "", errors.New("chat_export: thread not found")
	}

	messages, err := r.chat.SelectMessagesByThreadID(ctx, threadID)
	if err != nil {
		return "", err
	}

	snapshot := make([]exportedMessage, 0, len(messages))
	for _, m := range messages {
		snapshot = append(snapshot, exportedMessage{
			ID:       m.ID,
			Role:     m.Role,
			Parts:    json.RawMessage(m.Parts),
			Metadata: json.RawMessage(m.Metadata),
		})
	}
	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		return "", err
	}

	if exporterID == "" {
		exporterID = thread.UserID
	}

	export := &models.ChatExport{
		Title:            thread.Title,
		ExporterID:       exporterID,
		OriginalThreadID: &threadID,
		Messages:         snapshotJSON,
		ExpiresAt:        expiresAt,
	}
	if err := r.db.WithContext(ctx).Create(export).Error; err != nil {
		return "", err
	}
	return export.ID, nil
}

// ChatExportSummary ports ChatExportSummary (types/chat-export.ts:74): a
// chat_export row without its messages blob, plus its comment count.
type ChatExportSummary struct {
	models.ChatExport
	CommentCount int64
}

// ChatExportWithUser ports ChatExportWithUser (types/chat-export.ts:62).
type ChatExportWithUser struct {
	models.ChatExport
	ExporterName  *string
	ExporterImage *string
}

// ChatExportCommentWithUser ports ChatExportCommentWithUser
// (types/chat-export.ts:67): one comment plus its author's display fields,
// an is-owner flag, and (for top-level comments) its nested replies.
// Both derived fields are gorm:"-": they have no column behind them, and
// without the tag GORM rejects the whole struct as a scan target ("invalid
// field found ... define a valid foreign key for relations or implement
// the Valuer/Scanner interface") the moment it tries to interpret Replies
// as a relation.
type ChatExportCommentWithUser struct {
	models.ChatExportComment
	AuthorName  *string
	AuthorImage *string
	IsOwner     bool                         `gorm:"-"`
	Replies     []*ChatExportCommentWithUser `gorm:"-"`
}

// SelectByID ports selectById (chat-export-repository.pg.ts:69). Returns
// (nil, nil) when there's no such export -- the TS version would throw on
// the undefined row instead, which is a bug the routes above it already
// guard against by checking access first.
func (r *ChatExportRepository) SelectByID(ctx context.Context, id string) (*models.ChatExport, error) {
	var export models.ChatExport
	err := r.db.WithContext(ctx).Where("id = ?", id).Take(&export).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &export, nil
}

// SelectByIDWithUser ports selectByIdWithUser (chat-export-repository.pg.ts:76).
func (r *ChatExportRepository) SelectByIDWithUser(ctx context.Context, id string) (*ChatExportWithUser, error) {
	var rows []ChatExportWithUser
	err := r.db.WithContext(ctx).
		Table("chat_export AS e").
		Select(`e.id, e.title, e.exporter_id, e.original_thread_id, e.messages,
			e.exported_at, e.expires_at,
			u.name AS exporter_name, u.image AS exporter_image`).
		Joins(`LEFT JOIN "user" AS u ON u.id = e.exporter_id`).
		Where("e.id = ?", id).
		Limit(1).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// SelectSummaryByExporterID ports selectSummaryByExporterId
// (chat-export-repository.pg.ts:101): every export the user made, newest
// first, each with its comment count and without its messages blob.
func (r *ChatExportRepository) SelectSummaryByExporterID(ctx context.Context, exporterID string) ([]ChatExportSummary, error) {
	var rows []ChatExportSummary
	err := r.db.WithContext(ctx).
		Table("chat_export AS e").
		Select(`e.id, e.title, e.exporter_id, e.original_thread_id,
			e.exported_at, e.expires_at,
			COUNT(c.id) AS comment_count`).
		Joins("LEFT JOIN chat_export_comment AS c ON c.export_id = e.id").
		Where("e.exporter_id = ?", exporterID).
		Group("e.id, e.title, e.exporter_id, e.original_thread_id, e.exported_at, e.expires_at").
		Order("e.exported_at DESC").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// CheckAccess ports checkAccess (chat-export-repository.pg.ts:128):
// exporter-only, used to gate deletion.
func (r *ChatExportRepository) CheckAccess(ctx context.Context, id, userID string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.ChatExport{}).
		Where("id = ? AND exporter_id = ?", id, userID).Count(&count).Error
	return count > 0, err
}

// DeleteByID ports deleteById (chat-export-repository.pg.ts:139). Comments
// go with it via the chat_export_comment FK's ON DELETE CASCADE, which
// SQLite only honors with PRAGMA foreign_keys ON -- internal/db.Open sets
// it on every connection.
func (r *ChatExportRepository) DeleteByID(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Where("id = ?", id).Delete(&models.ChatExport{}).Error
}

// IsExpired ports isExpired (chat-export-repository.pg.ts:142): an export
// with no expires_at never expires.
func (r *ChatExportRepository) IsExpired(ctx context.Context, id string) (bool, error) {
	export, err := r.SelectByID(ctx, id)
	if err != nil || export == nil {
		return false, err
	}
	return export.ExpiresAt != nil && export.ExpiresAt.Before(time.Now()), nil
}

// InsertComment ports insertComment (chat-export-repository.pg.ts:151).
func (r *ChatExportRepository) InsertComment(ctx context.Context, comment *models.ChatExportComment) error {
	return r.db.WithContext(ctx).Create(comment).Error
}

// SelectCommentsByExportID ports selectCommentsByExportId
// (chat-export-repository.pg.ts:154): every comment on an export, oldest
// first, nested one level deep -- replies are attached to their parent and
// only top-level comments are returned. userID is optional (""), matching
// the TS `userId?` that the public, unauthenticated GET passes as
// undefined; when present it sets IsOwner per comment.
func (r *ChatExportRepository) SelectCommentsByExportID(ctx context.Context, exportID, userID string) ([]*ChatExportCommentWithUser, error) {
	var rows []*ChatExportCommentWithUser
	err := r.db.WithContext(ctx).
		Table("chat_export_comment AS c").
		Select(`c.id, c.export_id, c.author_id, c.parent_id, c.content,
			c.created_at, c.updated_at,
			u.name AS author_name, u.image AS author_image`).
		Joins(`LEFT JOIN "user" AS u ON u.id = c.author_id`).
		Where("c.export_id = ?", exportID).
		Order("c.created_at").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	byID := make(map[string]*ChatExportCommentWithUser, len(rows))
	for _, comment := range rows {
		if userID != "" {
			comment.IsOwner = comment.AuthorID == userID
		}
		byID[comment.ID] = comment
	}

	topLevel := make([]*ChatExportCommentWithUser, 0, len(rows))
	for _, comment := range rows {
		if comment.ParentID == nil {
			topLevel = append(topLevel, comment)
			continue
		}
		// A reply whose parent isn't in this export's comment set is
		// dropped from the tree, exactly as the TS version does: it
		// filters on `!comment.parentId` for the return value, so an
		// orphaned reply appears nowhere.
		if parent, ok := byID[*comment.ParentID]; ok {
			parent.Replies = append(parent.Replies, comment)
		}
	}
	return topLevel, nil
}

// CheckCommentAccess ports checkCommentAccess
// (chat-export-repository.pg.ts:201): author-only.
func (r *ChatExportRepository) CheckCommentAccess(ctx context.Context, id, authorID string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.ChatExportComment{}).
		Where("id = ? AND author_id = ?", id, authorID).Count(&count).Error
	return count > 0, err
}

// DeleteComment ports deleteComment (chat-export-repository.pg.ts:215).
func (r *ChatExportRepository) DeleteComment(ctx context.Context, id, authorID string) error {
	return r.db.WithContext(ctx).
		Where("id = ? AND author_id = ?", id, authorID).
		Delete(&models.ChatExportComment{}).Error
}
