package apiclient

import (
	"context"
	"encoding/json"
	"time"
)

// Export is a published, shareable copy of a thread.
type Export struct {
	ID               string     `json:"id"`
	Title            string     `json:"title"`
	ExporterID       string     `json:"exporterId"`
	OriginalThreadID *string    `json:"originalThreadId,omitempty"`
	CommentCount     int64      `json:"commentCount"`
	ExportedAt       time.Time  `json:"exportedAt"`
	ExpiresAt        *time.Time `json:"expiresAt,omitempty"`
}

// ExportDetail is GET /api/export/{id} -- the public read, which needs no
// session. It is the one route in the suite reachable anonymously, and the
// anonymous case is worth testing precisely because it is the exception.
type ExportDetail struct {
	ID               string          `json:"id"`
	Title            string          `json:"title"`
	ExporterID       string          `json:"exporterId"`
	OriginalThreadID *string         `json:"originalThreadId,omitempty"`
	Messages         json.RawMessage `json:"messages"`
}

// Comment is one comment on an export.
type Comment struct {
	ID       string          `json:"id"`
	ParentID *string         `json:"parentId"`
	Content  json.RawMessage `json:"content"`
}

func (c *Client) ListExports(ctx context.Context) ([]Export, error) {
	var out []Export
	err := c.Get(ctx, "/api/export", &out)
	return out, err
}

func (c *Client) GetExport(ctx context.Context, id string) (ExportDetail, error) {
	var out ExportDetail
	err := c.Get(ctx, join("/api/export", id), &out)
	return out, err
}

func (c *Client) DeleteExport(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/export", id), nil)
}

func (c *Client) ExportComments(ctx context.Context, id string) ([]Comment, error) {
	var out []Comment
	err := c.Get(ctx, join("/api/export", id)+"/comments", &out)
	return out, err
}

func (c *Client) AddExportComment(ctx context.Context, id string, body any) (Comment, error) {
	var out Comment
	err := c.Post(ctx, join("/api/export", id)+"/comments", body, &out)
	return out, err
}

func (c *Client) DeleteExportComment(ctx context.Context, exportID, commentID string) error {
	return c.Delete(ctx, join("/api/export", exportID, "comments", commentID), nil)
}
