package apiclient

import (
	"context"
	"encoding/json"
	"time"
)

// Thread is one conversation, as /api/thread lists it.
type Thread struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	UserID string `json:"userId"`
	// CreatedAt is a time on the list route and a raw value on the detail
	// route (internal/api/thread/id.go keeps it as json.RawMessage), so the
	// two are modelled separately rather than papered over with one type
	// that is wrong on one of them.
	CreatedAt     time.Time `json:"createdAt"`
	LastMessageAt int64     `json:"lastMessageAt"`
}

// Message is one turn's persisted record.
type Message struct {
	ID        string          `json:"id"`
	ThreadID  string          `json:"threadId"`
	Role      string          `json:"role"`
	Parts     json.RawMessage `json:"parts"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
}

// ThreadDetail is /api/thread/{id}: the thread plus its messages.
type ThreadDetail struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	UserID    string          `json:"userId"`
	CreatedAt json.RawMessage `json:"createdAt"`
	Messages  []Message       `json:"messages"`
}

func (c *Client) ListThreads(ctx context.Context) ([]Thread, error) {
	var out []Thread
	err := c.Get(ctx, "/api/thread", &out)
	return out, err
}

func (c *Client) GetThread(ctx context.Context, id string) (ThreadDetail, error) {
	var out ThreadDetail
	err := c.Get(ctx, join("/api/thread", id), &out)
	return out, err
}

func (c *Client) RenameThread(ctx context.Context, id, title string) error {
	return c.Put(ctx, join("/api/thread", id), map[string]string{"title": title}, nil)
}

func (c *Client) DeleteThread(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/thread", id), nil)
}

// DeleteAllThreads is DELETE /api/thread -- the "clear my history" route.
func (c *Client) DeleteAllThreads(ctx context.Context) error {
	return c.Delete(ctx, "/api/thread", nil)
}

func (c *Client) DeleteMessage(ctx context.Context, messageID string) error {
	return c.Delete(ctx, join("/api/thread/messages", messageID), nil)
}

// TruncateFrom deletes the named message and everything after it -- the
// "edit and resend" path.
func (c *Client) TruncateFrom(ctx context.Context, messageID string) error {
	return c.Post(ctx, join("/api/thread/messages", messageID)+"/truncate", nil, nil)
}
