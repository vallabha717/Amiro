package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"amiro/backend/internal/db/models"
	"amiro/backend/internal/pricing"
	"amiro/backend/internal/user"
)

// DailyUsageStat represents aggregated token, cost, and message usage for a specific day.
type DailyUsageStat struct {
	Date             string  `json:"date"`
	TotalTokens      int64   `json:"totalTokens"`
	PromptTokens     int64   `json:"promptTokens"`
	CompletionTokens int64   `json:"completionTokens"`
	TotalCost        float64 `json:"totalCost"`
	PromptCost       float64 `json:"promptCost"`
	CompletionCost   float64 `json:"completionCost"`
	MessageCount     int     `json:"messageCount"`
}

// ModelStat represents token, cost, and message statistics for a specific model.
type ModelStat struct {
	Model            string  `json:"model"`
	Provider         string  `json:"provider"`
	MessageCount     int     `json:"messageCount"`
	TotalTokens      int64   `json:"totalTokens"`
	PromptTokens     int64   `json:"promptTokens"`
	CompletionTokens int64   `json:"completionTokens"`
	TotalCost        float64 `json:"totalCost"`
	PromptCost       float64 `json:"promptCost"`
	CompletionCost   float64 `json:"completionCost"`
}

// UserStats represents aggregated usage and cost metrics for a user over a period.
type UserStats struct {
	ThreadCount      int              `json:"threadCount"`
	MessageCount     int              `json:"messageCount"`
	ModelStats       []ModelStat      `json:"modelStats"`
	TotalTokens      int64            `json:"totalTokens"`
	PromptTokens     int64            `json:"promptTokens"`
	CompletionTokens int64            `json:"completionTokens"`
	TotalCost        float64          `json:"totalCost"`
	PromptCost       float64          `json:"promptCost"`
	CompletionCost   float64          `json:"completionCost"`
	DailyUsage       []DailyUsageStat `json:"dailyUsage"`
	Period           string           `json:"period"`
}

// UserStatsOptions defines filtering parameters for stats calculation.
type UserStatsOptions struct {
	From *time.Time
	To   *time.Time
	Days *int
}

// UserRepository ports user-repository.pg.ts.
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

type chatMessageMetadataForStats struct {
	Usage *struct {
		PromptTokens     int64 `json:"promptTokens"`
		CompletionTokens int64 `json:"completionTokens"`
		TotalTokens      int64 `json:"totalTokens"`
	} `json:"usage"`
	ChatModel *struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
	} `json:"chatModel"`
}

// GetUserStats ports and extends getUserStats (user-repository.pg.ts:104): calculates
// thread count, message count, total tokens, prompt/completion breakdown, daily time series,
// and top models used for a specified date range. Uses in-memory aggregation of message
// metadata to maintain 100% SQLite and Postgres dialect portability.
func (r *UserRepository) GetUserStats(ctx context.Context, userID string, opts ...UserStatsOptions) (*UserStats, error) {
	var opt UserStatsOptions
	if len(opts) > 0 {
		opt = opts[0]
	}

	var startDate time.Time
	var endDate *time.Time
	period := "Last 30 Days"

	if opt.From != nil {
		startDate = *opt.From
		if opt.To != nil {
			endDate = opt.To
			period = fmt.Sprintf("%s - %s", opt.From.Format("Jan 2, 2006"), opt.To.Format("Jan 2, 2006"))
		} else {
			period = fmt.Sprintf("From %s", opt.From.Format("Jan 2, 2006"))
		}
	} else if opt.Days != nil {
		d := *opt.Days
		if d <= 1 {
			now := time.Now()
			startDate = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
			period = "Today"
		} else {
			startDate = time.Now().AddDate(0, 0, -d)
			period = fmt.Sprintf("Last %d Days", d)
		}
	} else {
		startDate = time.Now().AddDate(0, 0, -30)
		period = "Last 30 Days"
	}

	var threadIDs []string
	if err := r.db.WithContext(ctx).Model(&models.ChatThread{}).
		Where("user_id = ?", userID).
		Pluck("id", &threadIDs).Error; err != nil {
		return nil, err
	}

	if len(threadIDs) == 0 {
		return &UserStats{
			ThreadCount:      0,
			MessageCount:     0,
			ModelStats:       []ModelStat{},
			TotalTokens:      0,
			PromptTokens:     0,
			CompletionTokens: 0,
			TotalCost:        0,
			PromptCost:       0,
			CompletionCost:   0,
			DailyUsage:       []DailyUsageStat{},
			Period:           period,
		}, nil
	}

	threadQuery := r.db.WithContext(ctx).Model(&models.ChatThread{}).Where("user_id = ? AND created_at >= ?", userID, startDate)
	if endDate != nil {
		threadQuery = threadQuery.Where("created_at <= ?", *endDate)
	}
	var threadCount int64
	if err := threadQuery.Count(&threadCount).Error; err != nil {
		return nil, err
	}

	msgQuery := r.db.WithContext(ctx).Where("thread_id IN ? AND created_at >= ?", threadIDs, startDate)
	if endDate != nil {
		msgQuery = msgQuery.Where("created_at <= ?", *endDate)
	}
	var messages []models.ChatMessage
	if err := msgQuery.Order("created_at asc").Find(&messages).Error; err != nil {
		return nil, err
	}

	var totalTokens int64
	var totalPromptTokens int64
	var totalCompletionTokens int64
	var totalCost float64
	var totalPromptCost float64
	var totalCompletionCost float64

	modelStatsMap := make(map[string]*ModelStat)
	dailyUsageMap := make(map[string]*DailyUsageStat)
	pricingCatalog := pricing.DefaultCatalog()

	for _, msg := range messages {
		dayKey := msg.CreatedAt.Format("2006-01-02")
		dayEntry, ok := dailyUsageMap[dayKey]
		if !ok {
			dayEntry = &DailyUsageStat{
				Date: dayKey,
			}
			dailyUsageMap[dayKey] = dayEntry
		}
		dayEntry.MessageCount++

		if len(msg.Metadata) == 0 {
			continue
		}
		var meta chatMessageMetadataForStats
		if err := json.Unmarshal(msg.Metadata, &meta); err != nil {
			continue
		}

		var promptTok, completionTok, tok int64
		if meta.Usage != nil {
			promptTok = meta.Usage.PromptTokens
			completionTok = meta.Usage.CompletionTokens
			tok = meta.Usage.TotalTokens
			if tok == 0 && (promptTok > 0 || completionTok > 0) {
				tok = promptTok + completionTok
			} else if tok > 0 && promptTok == 0 && completionTok == 0 {
				promptTok = int64(float64(tok) * 0.6)
				completionTok = tok - promptTok
			}
		}

		modelName := ""
		providerName := ""
		if meta.ChatModel != nil && meta.ChatModel.Model != "" {
			modelName = meta.ChatModel.Model
			providerName = meta.ChatModel.Provider
		}

		msgTotalCost, msgPromptCost, msgCompletionCost := pricingCatalog.CalculateCost(providerName, modelName, promptTok, completionTok)

		totalTokens += tok
		totalPromptTokens += promptTok
		totalCompletionTokens += completionTok
		totalCost += msgTotalCost
		totalPromptCost += msgPromptCost
		totalCompletionCost += msgCompletionCost

		dayEntry.TotalTokens += tok
		dayEntry.PromptTokens += promptTok
		dayEntry.CompletionTokens += completionTok
		dayEntry.TotalCost += msgTotalCost
		dayEntry.PromptCost += msgPromptCost
		dayEntry.CompletionCost += msgCompletionCost

		if modelName != "" {
			entry, exists := modelStatsMap[modelName]
			if !exists {
				entry = &ModelStat{
					Model:    modelName,
					Provider: providerName,
				}
				modelStatsMap[modelName] = entry
			}
			entry.MessageCount++
			entry.TotalTokens += tok
			entry.PromptTokens += promptTok
			entry.CompletionTokens += completionTok
			entry.TotalCost += msgTotalCost
			entry.PromptCost += msgPromptCost
			entry.CompletionCost += msgCompletionCost
		}
	}

	modelStatsList := make([]ModelStat, 0, len(modelStatsMap))
	for _, stat := range modelStatsMap {
		modelStatsList = append(modelStatsList, *stat)
	}

	// Sort by total tokens descending; tie-break by message count descending
	sort.Slice(modelStatsList, func(i, j int) bool {
		if modelStatsList[i].TotalTokens == modelStatsList[j].TotalTokens {
			return modelStatsList[i].MessageCount > modelStatsList[j].MessageCount
		}
		return modelStatsList[i].TotalTokens > modelStatsList[j].TotalTokens
	})

	// Limit to top 20 models (allows more granular filtering on frontend)
	if len(modelStatsList) > 20 {
		modelStatsList = modelStatsList[:20]
	}

	// Build sorted daily usage list (chronological)
	dailyUsageList := make([]DailyUsageStat, 0, len(dailyUsageMap))
	for _, day := range dailyUsageMap {
		dailyUsageList = append(dailyUsageList, *day)
	}
	sort.Slice(dailyUsageList, func(i, j int) bool {
		return dailyUsageList[i].Date < dailyUsageList[j].Date
	})

	return &UserStats{
		ThreadCount:      int(threadCount),
		MessageCount:     len(messages),
		ModelStats:       modelStatsList,
		TotalTokens:      totalTokens,
		PromptTokens:     totalPromptTokens,
		CompletionTokens: totalCompletionTokens,
		TotalCost:        totalCost,
		PromptCost:       totalPromptCost,
		CompletionCost:   totalCompletionCost,
		DailyUsage:       dailyUsageList,
		Period:           period,
	}, nil
}
