package apiclient

import (
	"context"
	"encoding/json"
	"time"
)

// User is the identity shape every auth and user route returns.
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

// Session is what register and login return: the user plus a bearer token.
type Session struct {
	User  User   `json:"user"`
	Token string `json:"token"`
}

// AuthStatus answers whether the database is empty.
//
// This is the fact the whole seeding order depends on: internal/auth makes
// the FIRST registered account the admin, so a test harness that registers
// in a different order gets a different permission model.
type AuthStatus struct {
	IsFirstUser bool `json:"isFirstUser"`
}

func (c *Client) AuthStatus(ctx context.Context) (AuthStatus, error) {
	var out AuthStatus
	err := c.Get(ctx, "/api/auth/status", &out)
	return out, err
}

// Register creates an account. The returned Session's token is what As()
// takes; the client does not adopt it implicitly, because a test that
// registers three accounts must decide which one it is acting as.
func (c *Client) Register(ctx context.Context, name, email, password string) (Session, error) {
	var out Session
	err := c.Post(ctx, "/api/auth/register", map[string]string{
		"name": name, "email": email, "password": password,
	}, &out)
	return out, err
}

func (c *Client) Login(ctx context.Context, email, password string) (Session, error) {
	var out Session
	err := c.Post(ctx, "/api/auth/login", map[string]string{
		"email": email, "password": password,
	}, &out)
	return out, err
}

func (c *Client) Logout(ctx context.Context) error {
	return c.Post(ctx, "/api/auth/logout", nil, nil)
}

// Me returns the signed-in user. A 401 here is the canonical assertion that
// a session was actually invalidated.
func (c *Client) Me(ctx context.Context) (User, error) {
	var out User
	err := c.Get(ctx, "/api/auth/session", &out)
	return out, err
}

// UserDetails is the richer user record /api/user/details returns.
type UserDetails struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Email         string     `json:"email"`
	EmailVerified bool       `json:"emailVerified"`
	Image         *string    `json:"image,omitempty"`
	Role          string     `json:"role"`
	Banned        *bool      `json:"banned,omitempty"`
	BanReason     *string    `json:"banReason,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	LastLogin     *time.Time `json:"lastLogin"`
}

func (c *Client) UserDetails(ctx context.Context) (UserDetails, error) {
	var out UserDetails
	err := c.Get(ctx, "/api/user/details", &out)
	return out, err
}

func (c *Client) UserDetailsByID(ctx context.Context, id string) (UserDetails, error) {
	var out UserDetails
	err := c.Get(ctx, join("/api/user/details", id), &out)
	return out, err
}

func (c *Client) UpdateUserDetails(ctx context.Context, patch map[string]any) (UserDetails, error) {
	var out UserDetails
	err := c.Put(ctx, "/api/user/details", patch, &out)
	return out, err
}

func (c *Client) UserStats(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, "/api/user/stats", &out)
	return out, err
}

func (c *Client) ChangePassword(ctx context.Context, current, next string) error {
	return c.Put(ctx, "/api/user/password", map[string]string{
		"currentPassword": current, "newPassword": next,
	}, nil)
}

func (c *Client) AuthMethods(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, "/api/user/auth-methods", &out)
	return out, err
}

func (c *Client) Preferences(ctx context.Context) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Get(ctx, "/api/user/preferences", &out)
	return out, err
}

func (c *Client) SetPreferences(ctx context.Context, prefs any) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.Put(ctx, "/api/user/preferences", prefs, &out)
	return out, err
}
