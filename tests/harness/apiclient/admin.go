package apiclient

import (
	"context"
	"encoding/json"
	"time"
)

// AdminUser is the record /api/admin/users returns.
type AdminUser struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Email         string     `json:"email"`
	EmailVerified bool       `json:"emailVerified"`
	Role          string     `json:"role"`
	Banned        *bool      `json:"banned,omitempty"`
	BanReason     *string    `json:"banReason,omitempty"`
	BanExpires    *time.Time `json:"banExpires,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	LastLogin     *time.Time `json:"lastLogin"`
}

// AdminUserPage is what GET /api/admin/users returns: a paginated envelope,
// not a bare array.
//
// The envelope is easy to get wrong from the outside -- this client
// originally modelled it as []AdminUser, and the smoke suite caught it on
// its first run against a real server. That is the transcribed client
// earning its keep: a generated one would have been silently correct here
// and silently wrong the next time the shape changed.
type AdminUserPage struct {
	Users  []AdminUser `json:"users"`
	Total  int64       `json:"total"`
	Limit  int         `json:"limit"`
	Offset int         `json:"offset"`
}

// ListUsers is admin-only. Called with a non-admin session it returns 403,
// and that is a test, not an accident -- see StatusOf.
func (c *Client) ListUsers(ctx context.Context) (AdminUserPage, error) {
	var out AdminUserPage
	err := c.Get(ctx, "/api/admin/users", &out)
	return out, err
}

func (c *Client) GetUser(ctx context.Context, id string) (AdminUser, error) {
	var out AdminUser
	err := c.Get(ctx, join("/api/admin/users", id), &out)
	return out, err
}

func (c *Client) UserStatsByID(ctx context.Context, id string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, join("/api/admin/users", id)+"/stats", &out)
	return out, err
}

func (c *Client) SetUserRole(ctx context.Context, id, role string) error {
	return c.Put(ctx, join("/api/admin/users", id)+"/role", map[string]string{"role": role}, nil)
}

func (c *Client) BanUser(ctx context.Context, id string, banned bool, reason *string) error {
	return c.Put(ctx, join("/api/admin/users", id)+"/ban",
		map[string]any{"banned": banned, "banReason": reason}, nil)
}

func (c *Client) DeleteUser(ctx context.Context, id string) error {
	return c.Delete(ctx, join("/api/admin/users", id), nil)
}
