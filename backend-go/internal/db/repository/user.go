package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/user"
)

// UserRepository ports user-repository.pg.ts, minus getUserStats.
//
// getUserStats is deliberately not ported here: its query is built out of
// Postgres-native JSON operators (`metadata->'chatModel'->>'model'`,
// `(... ->>'totalTokens')::numeric`), which have no SQLite equivalent, so
// it would need a real reimplementation (fetch + aggregate in Go) rather
// than a port. Its only call site is a Server Action (api/user/actions.ts),
// which Phase 7 converts to HTTP -- none of Phase 6's own routes
// (user/details, user/details/{id}, user/preferences) touch it.
type UserRepository struct {
	db *gorm.DB
}

func NewUserRepository(db *gorm.DB) *UserRepository {
	return &UserRepository{db: db}
}

// UserWithLastLogin ports BasicUserWithLastLogin (types/user.ts:37): the
// user row minus its password, plus the newest session's updated_at.
type UserWithLastLogin struct {
	models.User
	LastLogin *time.Time
}

// ExistsByEmail ports existsByEmail (user-repository.pg.ts:24).
func (r *UserRepository) ExistsByEmail(ctx context.Context, email string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.User{}).Where("email = ?", email).Count(&count).Error
	return count > 0, err
}

// GetByID ports getUserById (user-repository.pg.ts:82). Returns (nil, nil)
// when there's no such user, matching the TS `... | null`.
func (r *UserRepository) GetByID(ctx context.Context, userID string) (*UserWithLastLogin, error) {
	var u models.User
	err := r.db.WithContext(ctx).Where("id = ?", userID).Take(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// The TS version computes this as a MAX() correlated subquery inside
	// the same SELECT. Both halves change here: it runs as its own query
	// (which keeps the password-stripping below explicit), and it reads
	// the newest row's column via ORDER BY ... LIMIT 1 instead of MAX(),
	// because modernc's SQLite driver returns an aggregate result column
	// as an untyped string that will not scan into a *time.Time. Selecting
	// the column itself preserves its declared type on both dialects --
	// the same fix ChatRepository.SelectThreadsByUserID documents.
	var sessions []models.Session
	err = r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("updated_at DESC").Limit(1).
		Find(&sessions).Error
	if err != nil {
		return nil, err
	}
	var lastLogin *time.Time
	if len(sessions) > 0 {
		lastLogin = &sessions[0].UpdatedAt
	}

	// getUserColumnsWithoutPassword (user-repository.pg.ts:18) -- the
	// password hash must never reach a response DTO.
	u.Password = nil
	return &UserWithLastLogin{User: u, LastLogin: lastLogin}, nil
}

// GetCount ports getUserCount (user-repository.pg.ts:100).
func (r *UserRepository) GetCount(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.User{}).Count(&count).Error
	return count, err
}

// UpdateDetails ports updateUserDetails (user-repository.pg.ts:31): only
// the supplied fields are written, matching the TS conditional spread.
func (r *UserRepository) UpdateDetails(ctx context.Context, userID string, name, email, image *string) (*models.User, error) {
	values := map[string]interface{}{"updated_at": time.Now()}
	if name != nil {
		values["name"] = *name
	}
	if email != nil {
		values["email"] = *email
	}
	if image != nil {
		values["image"] = *image
	}

	result := r.db.WithContext(ctx).Model(&models.User{}).Where("id = ?", userID).Updates(values)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, gorm.ErrRecordNotFound
	}

	var u models.User
	if err := r.db.WithContext(ctx).Where("id = ?", userID).Take(&u).Error; err != nil {
		return nil, err
	}
	u.Password = nil
	return &u, nil
}

// GetPreferences ports getPreferences (user-repository.pg.ts:75).
func (r *UserRepository) GetPreferences(ctx context.Context, userID string) (*user.Preferences, error) {
	var row struct{ Preferences datatypes.JSON }
	err := r.db.WithContext(ctx).Model(&models.User{}).
		Select("preferences").Where("id = ?", userID).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return user.ParsePreferences(row.Preferences), nil
}

// UpdatePreferences ports updatePreferences (user-repository.pg.ts:58) and
// returns the stored value back, the same way the TS method returns the
// updated user's `preferences`.
func (r *UserRepository) UpdatePreferences(ctx context.Context, userID string, prefs user.Preferences) (*user.Preferences, error) {
	encoded, err := json.Marshal(prefs)
	if err != nil {
		return nil, err
	}

	result := r.db.WithContext(ctx).Model(&models.User{}).Where("id = ?", userID).
		Updates(map[string]interface{}{
			"preferences": datatypes.JSON(encoded),
			"updated_at":  time.Now(),
		})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	return r.GetPreferences(ctx, userID)
}

// adminSortColumns ports buildOrderBy's field allowlist (admin-respository.pg.ts):
// an unrecognized sortBy falls back to createdAt rather than erroring, same
// as the TS switch's default branch.
var adminSortColumns = map[string]string{
	"name":      "name",
	"email":     "email",
	"role":      "role",
	"createdAt": "created_at",
	"updatedAt": "updated_at",
}

// AdminUsersQuery ports AdminUsersQuery (types/admin.ts), minus the generic
// filterField/filterValue/filterOperator escape hatch -- admin's own HTTP
// handler (internal/api/admin) never sends one, and the users-table.tsx UI
// this ports only ever drives search+sort+pagination.
type AdminUsersQuery struct {
	SearchValue   string
	Limit         int
	Offset        int
	SortBy        string
	SortDirection string
}

// AdminUsersPaginated ports AdminUsersPaginated (types/admin.ts).
type AdminUsersPaginated struct {
	Users []models.User
	Total int64
}

// ListForAdmin ports pgAdminRepository.getUsers (admin-respository.pg.ts):
// case-insensitive name/email search, an allowlisted sort column, offset
// pagination. Every returned row has its password hash stripped, matching
// getUserColumnsWithoutPassword.
func (r *UserRepository) ListForAdmin(ctx context.Context, q AdminUsersQuery) (AdminUsersPaginated, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 10
	}
	sortColumn, ok := adminSortColumns[q.SortBy]
	if !ok {
		sortColumn = "created_at"
	}
	direction := "DESC"
	if q.SortDirection == "asc" {
		direction = "ASC"
	}

	query := r.db.WithContext(ctx).Model(&models.User{})
	if trimmed := strings.TrimSpace(q.SearchValue); trimmed != "" {
		like := "%" + trimmed + "%"
		// SQLite's LIKE is already case-insensitive for ASCII by default
		// (no COLLATE needed); Postgres' plain LIKE is case-sensitive, so
		// it needs the ILIKE ports ilike() (admin-respository.pg.ts) uses.
		op := "LIKE"
		if r.db.Dialector.Name() == "postgres" {
			op = "ILIKE"
		}
		query = query.Where("name "+op+" ? OR email "+op+" ?", like, like)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		return AdminUsersPaginated{}, err
	}

	var users []models.User
	if err := query.Order(sortColumn + " " + direction).Limit(limit).Offset(q.Offset).Find(&users).Error; err != nil {
		return AdminUsersPaginated{}, err
	}
	for i := range users {
		users[i].Password = nil
	}
	return AdminUsersPaginated{Users: users, Total: total}, nil
}

// UpdateRole ports auth.api.setRole's effect (admin/actions.ts's
// updateUserRolesAction) -- the caller (internal/api/admin) enforces the
// "can't change your own role" rule the TS action does, this method is the
// bare write.
func (r *UserRepository) UpdateRole(ctx context.Context, userID, role string) error {
	result := r.db.WithContext(ctx).Model(&models.User{}).Where("id = ?", userID).
		Updates(map[string]interface{}{"role": role, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// UpdateBanStatus ports auth.api.banUser/unbanUser's effect
// (admin/actions.ts's updateUserBanStatusAction). banReason is only
// meaningful when banned is true; unbanning always clears both banReason
// and banExpires, matching auth.api.unbanUser's own field-clearing
// behavior (better-auth's ban plugin has no ban-expiry input from this
// admin UI, so BanExpires is never set here -- a ban from this panel is
// indefinite until explicitly unbanned).
func (r *UserRepository) UpdateBanStatus(ctx context.Context, userID string, banned bool, banReason *string) error {
	values := map[string]interface{}{"banned": banned, "updated_at": time.Now()}
	if banned {
		values["ban_reason"] = banReason
	} else {
		values["ban_reason"] = nil
		values["ban_expires"] = nil
	}
	result := r.db.WithContext(ctx).Model(&models.User{}).Where("id = ?", userID).Updates(values)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// RevokeSessions ports auth.api.revokeUserSessions -- every one of a
// user's live sessions, called after a role change or a ban so the change
// takes effect immediately rather than waiting for the session to expire
// naturally.
func (r *UserRepository) RevokeSessions(ctx context.Context, userID string) error {
	return r.db.WithContext(ctx).Where("user_id = ?", userID).Delete(&models.Session{}).Error
}

// Delete ports auth.api.removeUser's effect (user/actions.ts's
// deleteUserAction, admin-only when targeting someone other than the
// caller). Only the user/session/account rows are removed, matching
// Better Auth's own removeUser scope -- content the user owns (threads,
// agents, workflows, ...) is left in place, exactly as it would be after
// the TS action runs (Better Auth never touches those tables either).
func (r *UserRepository) Delete(ctx context.Context, userID string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&models.Session{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", userID).Delete(&models.Account{}).Error; err != nil {
			return err
		}
		result := tx.Where("id = ?", userID).Delete(&models.User{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
}

// AuthMethods ports getUserAuthMethods' return shape
// (user-repository.pg.ts:165).
type AuthMethods struct {
	HasPassword    bool
	OAuthProviders []string
}

// GetAuthMethods ports getUserAuthMethods (user-repository.pg.ts:165). The
// "credential" provider id is better-auth's marker for a password login;
// this backend writes the password hash on the user row directly (Phase 2)
// and never creates a credential account row, so HasPassword also reflects
// a non-empty user.password -- otherwise a locally registered user would
// report "no password" here while logging in with one every day.
func (r *UserRepository) GetAuthMethods(ctx context.Context, userID string) (*AuthMethods, error) {
	var providers []string
	err := r.db.WithContext(ctx).Model(&models.Account{}).
		Where("user_id = ?", userID).Pluck("provider_id", &providers).Error
	if err != nil {
		return nil, err
	}

	out := &AuthMethods{OAuthProviders: []string{}}
	for _, provider := range providers {
		if provider == "credential" {
			out.HasPassword = true
			continue
		}
		out.OAuthProviders = append(out.OAuthProviders, provider)
	}

	if !out.HasPassword {
		var u models.User
		if err := r.db.WithContext(ctx).Select("password").Where("id = ?", userID).Take(&u).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
		}
		out.HasPassword = u.Password != nil && *u.Password != ""
	}
	return out, nil
}
