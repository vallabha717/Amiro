// Package user ports src/app/api/user/**: the caller's own profile
// details, an admin-or-self lookup of another user's, and preferences
// read/write.
package user

import (
	"time"

	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/repository"
)

type Handler struct {
	users *repository.UserRepository
	auth  *auth.Service
}

func NewHandler(users *repository.UserRepository, authService *auth.Service) *Handler {
	return &Handler{users: users, auth: authService}
}

// userResponse ports BasicUserWithLastLogin (types/user.ts:37). Note the
// absent password field: repository.UserRepository already clears it, and
// not declaring it here means a future repository change can't leak one
// through this DTO either.
type userResponse struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Email         string     `json:"email"`
	EmailVerified bool       `json:"emailVerified"`
	Image         *string    `json:"image,omitempty"`
	Role          string     `json:"role"`
	Banned        *bool      `json:"banned,omitempty"`
	BanReason     *string    `json:"banReason,omitempty"`
	BanExpires    *time.Time `json:"banExpires,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	LastLogin     *time.Time `json:"lastLogin"`
}

func toUserResponse(u repository.UserWithLastLogin) userResponse {
	return userResponse{
		ID: u.User.ID, Name: u.User.Name, Email: u.User.Email,
		EmailVerified: u.User.EmailVerified, Image: u.User.Image, Role: u.User.Role,
		Banned: u.User.Banned, BanReason: u.User.BanReason, BanExpires: u.User.BanExpires,
		CreatedAt: u.User.CreatedAt, UpdatedAt: u.User.UpdatedAt, LastLogin: u.LastLogin,
	}
}
