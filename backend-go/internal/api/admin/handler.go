// Package admin ports src/app/api/admin/** + src/lib/admin/server.ts: the
// admin-only user-management panel (list/search/sort/paginate, role
// changes, ban/unban, delete). This subsystem didn't exist on the Go side
// at all before now -- internal/auth.Service only ever implemented
// Register/Login/Logout/ValidateSession/SetPassword, so the frontend's
// admin/users pages were literal placeholder alert screens (see their own
// former doc comments). Per-user OAuth-account and multi-session listing
// (getUserAccounts/getUserSessions) are not ported: this backend has no
// OAuth provider wiring at all (sign-in.tsx's own doc comment), and
// ValidateSession/CreateSession never persist more than the one live
// session a login replaces, so there's nothing meaningful to list beyond
// what UpdateBanStatus/UpdateRole's RevokeSessions call already reports.
package admin

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"gorm.io/gorm"

	"betterchatbot/backend/internal/api/httpjson"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/db/repository"
)

type Handler struct {
	users *repository.UserRepository
}

func NewHandler(users *repository.UserRepository) *Handler {
	return &Handler{users: users}
}

// requireAdmin ports requireAdminPermission (lib/auth/permissions.ts):
// every route in this package needs the caller's own role to be "admin",
// the same inline check internal/mcp.CanShare and internal/api/user's
// canManageUser already use elsewhere in this backend.
func requireAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	authedUser, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpjson.Unauthorized(w)
		return "", false
	}
	if authedUser.Role != "admin" {
		httpjson.Forbidden(w)
		return "", false
	}
	return authedUser.ID, true
}

// adminUserDTO ports AdminUserListItem (types/admin.ts): the user row
// without its password (UserRepository already strips it) or preferences
// (excluded from admin views the same way pgAdminRepository.getUsers'
// `preferences: undefined` spread does).
type adminUserDTO struct {
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
}

func toAdminUserDTO(u models.User) adminUserDTO {
	return adminUserDTO{
		ID: u.ID, Name: u.Name, Email: u.Email, EmailVerified: u.EmailVerified,
		Image: u.Image, Role: u.Role, Banned: u.Banned, BanReason: u.BanReason,
		BanExpires: u.BanExpires, CreatedAt: u.CreatedAt, UpdatedAt: u.UpdatedAt,
	}
}

// List ports getAdminUsers/pgAdminRepository.getUsers (GET /api/admin/users):
// search+sort+paginate. Query params: q (search), sortBy, sortDirection
// (asc|desc), limit, offset -- matching AdminUsersQuery's field names
// (camelCase in the TS body; this is a GET so they're query params
// instead, kept as close to the TS names as a query string allows).
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}

	q := repository.AdminUsersQuery{
		SearchValue:   r.URL.Query().Get("q"),
		SortBy:        r.URL.Query().Get("sortBy"),
		SortDirection: r.URL.Query().Get("sortDirection"),
		Limit:         queryInt(r, "limit", 10),
		Offset:        queryInt(r, "offset", 0),
	}

	result, err := h.users.ListForAdmin(r.Context(), q)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}

	users := make([]adminUserDTO, len(result.Users))
	for i, u := range result.Users {
		users[i] = toAdminUserDTO(u)
	}
	httpjson.OK(w, map[string]any{
		"users": users, "total": result.Total, "limit": q.Limit, "offset": q.Offset,
	})
}

func queryInt(r *http.Request, key string, def int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return def
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < 0 {
		return def
	}
	return v
}

// Get ports a single admin user-detail lookup (admin/users/[id]/page.tsx's
// data need) -- there's no dedicated TS route for this (the Server
// Component read the repository directly), so this is the plain
// equivalent: GET /api/admin/users/{id}.
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id := r.PathValue("id")

	found, err := h.users.GetByID(r.Context(), id)
	if err != nil {
		httpjson.ServerError(w, err)
		return
	}
	if found == nil {
		httpjson.NotFound(w, "user not found")
		return
	}
	dto := toAdminUserDTO(found.User)
	httpjson.OK(w, map[string]any{
		"id": dto.ID, "name": dto.Name, "email": dto.Email, "emailVerified": dto.EmailVerified,
		"image": dto.Image, "role": dto.Role, "banned": dto.Banned, "banReason": dto.BanReason,
		"banExpires": dto.BanExpires, "createdAt": dto.CreatedAt, "updatedAt": dto.UpdatedAt,
		"lastLogin": found.LastLogin,
	})
}

var validRoles = map[string]bool{"user": true, "admin": true}

// UpdateRole ports updateUserRolesAction (admin/actions.ts): PUT
// /api/admin/users/{id}/role. An admin may not change their own role
// (t("cannotUpdateOwnRole")'s guard) -- self-demotion could leave a
// desktop install with zero admins and no way back in through this UI.
func (h *Handler) UpdateRole(w http.ResponseWriter, r *http.Request) {
	callerID, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if id == callerID {
		httpjson.BadRequest(w, "you cannot change your own role")
		return
	}

	var req struct {
		Role string `json:"role"`
	}
	if !httpjson.Decode(w, r, &req) {
		return
	}
	if !validRoles[req.Role] {
		httpjson.BadRequest(w, `role must be "user" or "admin"`)
		return
	}

	if err := h.users.UpdateRole(r.Context(), id, req.Role); err != nil {
		writeUserMutationError(w, err)
		return
	}
	// revokeUserSessions (admin/actions.ts): a role change takes effect on
	// the account's next request, not its already-live session.
	_ = h.users.RevokeSessions(r.Context(), id)
	httpjson.Success(w)
}

// UpdateBanStatus ports updateUserBanStatusAction (admin/actions.ts): PUT
// /api/admin/users/{id}/ban. An admin may not ban themselves (the TS
// action's own guard, `cannotBanUnbanYourself`) -- self-lockout has no
// recovery path in a single-admin desktop install.
func (h *Handler) UpdateBanStatus(w http.ResponseWriter, r *http.Request) {
	callerID, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if id == callerID {
		httpjson.BadRequest(w, "you cannot ban or unban yourself")
		return
	}

	var req struct {
		Banned    bool    `json:"banned"`
		BanReason *string `json:"banReason,omitempty"`
	}
	if !httpjson.Decode(w, r, &req) {
		return
	}

	if err := h.users.UpdateBanStatus(r.Context(), id, req.Banned, req.BanReason); err != nil {
		writeUserMutationError(w, err)
		return
	}
	if req.Banned {
		// revokeUserSessions (admin/actions.ts): banning ends the account's
		// already-live session immediately, not just future logins (which
		// auth.Service.Login's own ban check already blocks).
		_ = h.users.RevokeSessions(r.Context(), id)
	}
	httpjson.Success(w)
}

// Delete ports deleteUserAction (user/actions.ts, admin-permission-gated):
// DELETE /api/admin/users/{id}. Self-deletion through this admin route is
// blocked for the same reason self-ban/self-role-change are -- use the
// ordinary user-settings flow to delete your own account instead (not
// ported in this pass; out of this gap's scope).
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	callerID, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if id == callerID {
		httpjson.BadRequest(w, "you cannot delete your own account from here")
		return
	}

	if err := h.users.Delete(r.Context(), id); err != nil {
		writeUserMutationError(w, err)
		return
	}
	httpjson.Success(w)
}

func writeUserMutationError(w http.ResponseWriter, err error) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		httpjson.NotFound(w, "user not found")
		return
	}
	httpjson.ServerError(w, err)
}
