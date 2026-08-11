// Package export ports src/app/api/export/**: the exporter's own list of
// shared chat exports, deletion, and the threaded comment surface on a
// shared export.
//
// One route here has no route.ts counterpart: GET /api/export/{id}, which
// reads a single export (with its exporter's display fields and its expiry
// state). In the TS app that read happens inside a React Server Component
// rendering the public /export/[id] page, calling the repository directly
// with no HTTP hop. Phase 7 turns that page into static frontend code with
// no server to call into, so the read has to become a real endpoint --
// exposed now for the same reason internal/api/mcp exposed its
// refresh/share/call-tool operations ahead of their phase: without it,
// most of what this package's repository does is unreachable and untestable.
package export

import (
	"encoding/json"
	"time"

	"betterchatbot/backend/internal/db/repository"
)

type Handler struct {
	exports *repository.ChatExportRepository
}

func NewHandler(exports *repository.ChatExportRepository) *Handler {
	return &Handler{exports: exports}
}

// summaryResponse ports ChatExportSummary (types/chat-export.ts:74).
type summaryResponse struct {
	ID               string     `json:"id"`
	Title            string     `json:"title"`
	ExporterID       string     `json:"exporterId"`
	OriginalThreadID *string    `json:"originalThreadId,omitempty"`
	CommentCount     int64      `json:"commentCount"`
	ExportedAt       time.Time  `json:"exportedAt"`
	ExpiresAt        *time.Time `json:"expiresAt,omitempty"`
}

// exportResponse ports ChatExportWithUser (types/chat-export.ts:62), plus
// an isExpired flag the page would otherwise have to recompute.
type exportResponse struct {
	ID               string          `json:"id"`
	Title            string          `json:"title"`
	ExporterID       string          `json:"exporterId"`
	OriginalThreadID *string         `json:"originalThreadId,omitempty"`
	Messages         json.RawMessage `json:"messages"`
	ExportedAt       time.Time       `json:"exportedAt"`
	ExpiresAt        *time.Time      `json:"expiresAt,omitempty"`
	ExporterName     *string         `json:"exporterName"`
	ExporterImage    *string         `json:"exporterImage,omitempty"`
	IsExpired        bool            `json:"isExpired"`
}

// commentResponse ports ChatExportCommentWithUser (types/chat-export.ts:67).
type commentResponse struct {
	ID          string            `json:"id"`
	ExportID    string            `json:"exportId"`
	AuthorID    string            `json:"authorId"`
	ParentID    *string           `json:"parentId,omitempty"`
	Content     json.RawMessage   `json:"content"`
	CreatedAt   time.Time         `json:"createdAt"`
	UpdatedAt   time.Time         `json:"updatedAt"`
	AuthorName  *string           `json:"authorName"`
	AuthorImage *string           `json:"authorImage,omitempty"`
	IsOwner     bool              `json:"isOwner"`
	Replies     []commentResponse `json:"replies,omitempty"`
}

func toCommentResponse(c *repository.ChatExportCommentWithUser) commentResponse {
	out := commentResponse{
		ID: c.ID, ExportID: c.ExportID, AuthorID: c.AuthorID, ParentID: c.ParentID,
		Content: json.RawMessage(c.Content), CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt,
		AuthorName: c.AuthorName, AuthorImage: c.AuthorImage, IsOwner: c.IsOwner,
	}
	for _, reply := range c.Replies {
		out.Replies = append(out.Replies, toCommentResponse(reply))
	}
	return out
}
