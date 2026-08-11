// Package repository ports src/lib/db/pg/repositories/*.ts: a thin query
// layer over the GORM structs in internal/db/models, built on the same
// *gorm.DB working against either dialect (plan section 3) that
// internal/auth's Service already uses successfully. Methods land here as
// the phase whose routes need them arrives -- Phase 3 brought the chat
// loop's own queries, Phase 6 added selectThreadsByUserId and
// deleteThread's archive-item cascade with the thread/archive routes,
// Phase 7 added UpdateThread/DeleteUnarchivedThreads for the
// Server-Action-only thread-management routes that phase exposes over
// HTTP for the first time.
package repository

import (
	"context"
	"errors"
	"sort"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"betterchatbot/backend/internal/db/models"
)

// onConflictUpdateThreadTitle/onConflictUpdateMessageParts port the two
// Drizzle `.onConflictDoUpdate({ target: [...Table.id], set: {...} })`
// calls in chat-repository.pg.ts (upsertThread:134, upsertMessage:175) as
// GORM's equivalent clause.OnConflict.
var onConflictUpdateThreadTitle = clause.OnConflict{
	Columns:   []clause.Column{{Name: "id"}},
	DoUpdates: clause.AssignmentColumns([]string{"title"}),
}

var onConflictUpdateMessageParts = clause.OnConflict{
	Columns:   []clause.Column{{Name: "id"}},
	DoUpdates: clause.AssignmentColumns([]string{"parts", "metadata"}),
}

// ChatRepository wraps *gorm.DB with the chat_thread/chat_message queries
// Phase 3's routes need.
type ChatRepository struct {
	db *gorm.DB
}

func NewChatRepository(db *gorm.DB) *ChatRepository {
	return &ChatRepository{db: db}
}

// ThreadDetails ports selectThreadDetails' return shape
// (chat-repository.pg.ts:40): the thread plus its owner's preferences and
// full message history in one call.
type ThreadDetails struct {
	Thread      models.ChatThread
	Preferences datatypes.JSON
	Messages    []models.ChatMessage
}

// InsertThread ports insertThread (chat-repository.pg.ts:14).
func (r *ChatRepository) InsertThread(ctx context.Context, thread *models.ChatThread) error {
	return r.db.WithContext(ctx).Create(thread).Error
}

// SelectThread ports selectThread (chat-repository.pg.ts:32).
func (r *ChatRepository) SelectThread(ctx context.Context, id string) (*models.ChatThread, error) {
	var t models.ChatThread
	if err := r.db.WithContext(ctx).Where("id = ?", id).First(&t).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &t, nil
}

// SelectThreadDetails ports selectThreadDetails (chat-repository.pg.ts:40).
// Returns (nil, nil) when the thread doesn't exist, matching the TS
// method's `| null` return.
func (r *ChatRepository) SelectThreadDetails(ctx context.Context, id string) (*ThreadDetails, error) {
	if id == "" {
		return nil, nil
	}
	thread, err := r.SelectThread(ctx, id)
	if err != nil || thread == nil {
		return nil, err
	}

	var owner models.User
	var prefs datatypes.JSON
	if err := r.db.WithContext(ctx).Select("preferences").Where("id = ?", thread.UserID).First(&owner).Error; err == nil {
		prefs = owner.Preferences
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	messages, err := r.SelectMessagesByThreadID(ctx, id)
	if err != nil {
		return nil, err
	}

	return &ThreadDetails{Thread: *thread, Preferences: prefs, Messages: messages}, nil
}

// SelectMessagesByThreadID ports selectMessagesByThreadId
// (chat-repository.pg.ts:65), ordered oldest-first like the TS
// `.orderBy(ChatMessageTable.createdAt)`.
func (r *ChatRepository) SelectMessagesByThreadID(ctx context.Context, threadID string) ([]models.ChatMessage, error) {
	var messages []models.ChatMessage
	if err := r.db.WithContext(ctx).Where("thread_id = ?", threadID).Order("created_at ASC").Find(&messages).Error; err != nil {
		return nil, err
	}
	return messages, nil
}

// UpdateThread ports updateThread (chat-repository.pg.ts:115): the
// rename-thread path, title only -- the TS signature accepts a broader
// partial but only ever sets `title` in its `.set({...})` call.
func (r *ChatRepository) UpdateThread(ctx context.Context, id, title string) error {
	return r.db.WithContext(ctx).Model(&models.ChatThread{}).Where("id = ?", id).Update("title", title).Error
}

// UpsertThread ports upsertThread (chat-repository.pg.ts:128): inserts a
// new thread, or updates just the title if id already exists.
func (r *ChatRepository) UpsertThread(ctx context.Context, thread *models.ChatThread) error {
	return r.db.WithContext(ctx).Clauses(onConflictUpdateThreadTitle).Create(thread).Error
}

// UpsertMessage ports upsertMessage (chat-repository.pg.ts:169): inserts a
// new message, or updates parts/metadata if id already exists.
func (r *ChatRepository) UpsertMessage(ctx context.Context, msg *models.ChatMessage) error {
	return r.db.WithContext(ctx).Clauses(onConflictUpdateMessageParts).Create(msg).Error
}

// DeleteThread ports deleteThread (chat-repository.pg.ts:144): messages,
// then the thread's membership in every archive, then the thread itself.
func (r *ChatRepository) DeleteThread(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("thread_id = ?", id).Delete(&models.ChatMessage{}).Error; err != nil {
			return err
		}
		if err := tx.Where("item_id = ?", id).Delete(&models.ArchiveItem{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", id).Delete(&models.ChatThread{}).Error
	})
}

// ThreadWithLastMessage ports selectThreadsByUserId's return shape
// (chat-repository.pg.ts:73): the thread plus the timestamp of its newest
// message, which the sidebar sorts and groups by.
type ThreadWithLastMessage struct {
	models.ChatThread
	LastMessageAt *time.Time
}

// SelectThreadsByUserID ports selectThreadsByUserId
// (chat-repository.pg.ts:73), with two changes forced by dual-dialect
// portability rather than chosen:
//
//  1. The newest message's timestamp comes from an ORDER BY ... LIMIT 1
//     correlated subquery, not the TS query's MAX() aggregate over a LEFT
//     JOIN. Under modernc's SQLite driver an aggregate's result column
//     carries no declared type, so MAX(created_at) comes back as a string
//     and scanning it into a *time.Time fails outright ("unsupported Scan,
//     storing driver.Value type string into type *time.Time"). Selecting
//     the column itself keeps its declared type on both dialects. Found by
//     TestUserRepository_GetByIDReportsTheNewestSessionAsLastLogin failing
//     on the same pattern, not by reading driver docs.
//
//  2. The newest-first ordering is applied in Go. Postgres sorts NULLs
//     last on a DESC ordering and SQLite sorts them first, so a thread
//     with no messages yet would land at opposite ends of the sidebar
//     depending on the deploy target.
func (r *ChatRepository) SelectThreadsByUserID(ctx context.Context, userID string) ([]ThreadWithLastMessage, error) {
	var rows []struct {
		models.ChatThread
		LastMessageAt *time.Time
	}
	err := r.db.WithContext(ctx).
		Table("chat_thread AS t").
		Select(`t.id, t.title, t.user_id, t.created_at,
			(SELECT m.created_at FROM chat_message AS m
			 WHERE m.thread_id = t.id
			 ORDER BY m.created_at DESC LIMIT 1) AS last_message_at`).
		Where("t.user_id = ?", userID).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	out := make([]ThreadWithLastMessage, 0, len(rows))
	for _, row := range rows {
		out = append(out, ThreadWithLastMessage{ChatThread: row.ChatThread, LastMessageAt: row.LastMessageAt})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return lastMessageUnix(out[i]) > lastMessageUnix(out[j])
	})
	return out, nil
}

// lastMessageUnix mirrors the TS mapper's `lastMessageAt: row.lastMessageAt
// ? new Date(...).getTime() : 0` (chat-repository.pg.ts:104) -- a thread
// with no messages sorts as timestamp 0, i.e. last.
func lastMessageUnix(t ThreadWithLastMessage) int64 {
	if t.LastMessageAt == nil {
		return 0
	}
	return t.LastMessageAt.UnixMilli()
}

// DeleteChatMessage ports deleteChatMessage (chat-repository.pg.ts:28).
func (r *ChatRepository) DeleteChatMessage(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Where("id = ?", id).Delete(&models.ChatMessage{}).Error
}

// DeleteMessagesByChatIDAfterTimestamp ports
// deleteMessagesByChatIdAfterTimestamp (chat-repository.pg.ts:186): deletes
// every message in the same thread created at-or-after the named message's
// timestamp (including the named message itself).
func (r *ChatRepository) DeleteMessagesByChatIDAfterTimestamp(ctx context.Context, messageID string) error {
	var msg models.ChatMessage
	err := r.db.WithContext(ctx).Where("id = ?", messageID).First(&msg).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return r.db.WithContext(ctx).
		Where("thread_id = ? AND created_at >= ?", msg.ThreadID, msg.CreatedAt).
		Delete(&models.ChatMessage{}).Error
}

// DeleteAllThreads ports deleteAllThreads (chat-repository.pg.ts:207).
func (r *ChatRepository) DeleteAllThreads(ctx context.Context, userID string) error {
	var ids []string
	if err := r.db.WithContext(ctx).Model(&models.ChatThread{}).Where("user_id = ?", userID).Pluck("id", &ids).Error; err != nil {
		return err
	}
	for _, id := range ids {
		if err := r.DeleteThread(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// DeleteUnarchivedThreads ports deleteUnarchivedThreads
// (chat-repository.pg.ts:217): every one of the user's threads with no
// archive_item row at all -- a LEFT JOIN ... WHERE archive_item.id IS
// NULL in the TS query, expressed here as a NOT IN subquery since GORM's
// query builder has no first-class LEFT JOIN helper.
func (r *ChatRepository) DeleteUnarchivedThreads(ctx context.Context, userID string) error {
	var ids []string
	err := r.db.WithContext(ctx).Model(&models.ChatThread{}).
		Where("user_id = ? AND id NOT IN (SELECT item_id FROM archive_item)", userID).
		Pluck("id", &ids).Error
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := r.DeleteThread(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// CheckAccess ports checkAccess (chat-repository.pg.ts:249).
func (r *ChatRepository) CheckAccess(ctx context.Context, threadID, userID string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.ChatThread{}).
		Where("id = ? AND user_id = ?", threadID, userID).
		Count(&count).Error
	return count > 0, err
}
