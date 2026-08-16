package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"amiro/backend/internal/db/models"
)

// AgentRepository ports agent-repository.pg.ts. selectAgentsByUserId is not
// ported: its only TS call sites are Server Actions (agent/actions.ts),
// which Phase 7 converts to HTTP calls -- and every one of them is already
// covered by SelectAgents with filters ["mine"], which is what
// agent/route.ts's GET actually serves.
type AgentRepository struct {
	db *gorm.DB
}

func NewAgentRepository(db *gorm.DB) *AgentRepository {
	return &AgentRepository{db: db}
}

// AgentWithMeta adds the joined display/bookmark columns
// selectAgents/selectAgentById return alongside the row itself
// (agent-repository.pg.ts:196-219). The list query deliberately omits
// Instructions -- the TS select does too ("Exclude instructions from list
// queries for performance", agent-repository.pg.ts:202).
type AgentWithMeta struct {
	models.Agent
	UserName     string
	UserAvatar   *string
	IsBookmarked bool
}

// agentJoinRow is the flat scan target for the two joined queries below.
// GORM can't Scan directly into AgentWithMeta's embedded struct across a
// multi-table join, so the columns land here and get mapped explicitly.
type agentJoinRow struct {
	ID           string
	Name         string
	Description  *string
	Icon         datatypes.JSON
	UserID       string
	Instructions datatypes.JSON
	Visibility   string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	UserName     *string
	UserAvatar   *string
	IsBookmarked bool
}

func (r agentJoinRow) toAgentWithMeta() AgentWithMeta {
	out := AgentWithMeta{
		Agent: models.Agent{
			ID:           r.ID,
			Name:         r.Name,
			Description:  r.Description,
			Icon:         r.Icon,
			UserID:       r.UserID,
			Instructions: r.Instructions,
			Visibility:   r.Visibility,
			CreatedAt:    r.CreatedAt,
			UpdatedAt:    r.UpdatedAt,
		},
		UserAvatar:   r.UserAvatar,
		IsBookmarked: r.IsBookmarked,
	}
	if r.UserName != nil {
		out.UserName = *r.UserName
	}
	return out
}

// Insert ports insertAgent (agent-repository.pg.ts:8).
func (r *AgentRepository) Insert(ctx context.Context, agent *models.Agent) error {
	if agent.Visibility == "" {
		agent.Visibility = "private"
	}
	return r.db.WithContext(ctx).Create(agent).Error
}

// SelectByID ports selectAgentById (agent-repository.pg.ts:32): the row is
// only visible to its owner, or to anyone when it's public/readonly.
// Returns (nil, nil) when there's no visible row, matching the TS `null`.
func (r *AgentRepository) SelectByID(ctx context.Context, id, userID string) (*AgentWithMeta, error) {
	var row agentJoinRow
	err := r.db.WithContext(ctx).
		Table("agent AS a").
		Select(`a.id, a.name, a.description, a.icon, a.user_id, a.instructions,
			a.visibility, a.created_at, a.updated_at,
			b.id IS NOT NULL AS is_bookmarked`).
		Joins(`LEFT JOIN bookmark AS b ON b.item_id = a.id AND b.user_id = ? AND b.item_type = ?`, userID, BookmarkItemTypeAgent).
		Where(`a.id = ? AND (a.user_id = ? OR a.visibility IN ?)`, id, userID, []string{"public", "readonly"}).
		Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	result := row.toAgentWithMeta()
	return &result, nil
}

// AgentUpdate ports AgentUpdateSchema's partial shape (types/agent.ts:33):
// a nil field means "not supplied, leave unchanged", matching the way the
// TS route spreads only the keys Zod actually parsed.
type AgentUpdate struct {
	Name         *string
	Description  *string
	Icon         datatypes.JSON
	Instructions datatypes.JSON
	Visibility   *string
}

// Update ports updateAgent (agent-repository.pg.ts:110), including its
// WHERE clause -- only the owner, or anyone for a "public" agent, may
// write. Returns (nil, nil) when nothing matched.
func (r *AgentRepository) Update(ctx context.Context, id, userID string, update AgentUpdate) (*models.Agent, error) {
	values := map[string]interface{}{"updated_at": time.Now()}
	if update.Name != nil {
		values["name"] = *update.Name
	}
	if update.Description != nil {
		values["description"] = *update.Description
	}
	if update.Icon != nil {
		values["icon"] = update.Icon
	}
	if update.Instructions != nil {
		values["instructions"] = update.Instructions
	}
	if update.Visibility != nil {
		values["visibility"] = *update.Visibility
	}

	result := r.db.WithContext(ctx).Model(&models.Agent{}).
		Where(`id = ? AND (user_id = ? OR visibility = ?)`, id, userID, "public").
		Updates(values)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, nil
	}

	var agent models.Agent
	if err := r.db.WithContext(ctx).Where("id = ?", id).Take(&agent).Error; err != nil {
		return nil, err
	}
	return &agent, nil
}

// Delete ports deleteAgent (agent-repository.pg.ts:137): owner-only, and
// silent when nothing matches (the TS delete has no rowcount check either).
func (r *AgentRepository) Delete(ctx context.Context, id, userID string) error {
	return r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", id, userID).
		Delete(&models.Agent{}).Error
}

// SelectAgents ports selectAgents (agent-repository.pg.ts:143): builds an
// OR of the requested filters ("all" short-circuits everything else),
// orders the caller's own agents first, and caps the result at limit.
func (r *AgentRepository) SelectAgents(ctx context.Context, userID string, filters []string, limit int) ([]AgentWithMeta, error) {
	if len(filters) == 0 {
		filters = []string{"all"}
	}
	if limit <= 0 {
		limit = 50
	}

	shared := `(a.user_id <> ? AND a.visibility IN ?)`
	var conditions []*gorm.DB
	for _, filter := range filters {
		switch filter {
		case "mine":
			conditions = append(conditions, r.db.Where(`a.user_id = ?`, userID))
		case "shared":
			conditions = append(conditions, r.db.Where(shared, userID, []string{"public", "readonly"}))
		case "bookmarked":
			conditions = append(conditions, r.db.Where(shared+` AND b.id IS NOT NULL`, userID, []string{"public", "readonly"}))
		case "all":
			// "all" overrides everything else (agent-repository.pg.ts:191).
			conditions = []*gorm.DB{r.db.Where(`a.user_id = ? OR `+shared, userID, userID, []string{"public", "readonly"})}
			filters = nil
		}
		if filters == nil {
			break
		}
	}
	if len(conditions) == 0 {
		return []AgentWithMeta{}, nil
	}

	where := conditions[0]
	for _, condition := range conditions[1:] {
		where = where.Or(condition)
	}

	var rows []agentJoinRow
	err := r.db.WithContext(ctx).
		Table("agent AS a").
		Select(`a.id, a.name, a.description, a.icon, a.user_id,
			a.visibility, a.created_at, a.updated_at,
			u.name AS user_name, u.image AS user_avatar,
			b.id IS NOT NULL AS is_bookmarked`).
		Joins(`INNER JOIN "user" AS u ON u.id = a.user_id`).
		Joins(`LEFT JOIN bookmark AS b ON b.item_id = a.id AND b.item_type = ? AND b.user_id = ?`, BookmarkItemTypeAgent, userID).
		Where(where).
		// Own agents first, then newest-first -- the two-key ORDER BY at
		// agent-repository.pg.ts:221. Passed as a clause.OrderBy expression
		// rather than an Order("...") string because the CASE arm needs a
		// bound parameter, and GORM's string form has no placeholder support.
		Order(clause.OrderBy{Expression: clause.Expr{
			SQL:  "CASE WHEN a.user_id = ? THEN 0 ELSE 1 END, a.created_at DESC",
			Vars: []interface{}{userID},
		}}).
		Limit(limit).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	out := make([]AgentWithMeta, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.toAgentWithMeta())
	}
	return out, nil
}

// CheckAccess ports checkAccess (agent-repository.pg.ts:238): the owner
// always has access; a public agent grants non-destructive access to
// anyone; everything else is denied.
func (r *AgentRepository) CheckAccess(ctx context.Context, agentID, userID string, destructive bool) (bool, error) {
	var row struct {
		Visibility string
		UserID     string
	}
	err := r.db.WithContext(ctx).Model(&models.Agent{}).
		Select("visibility", "user_id").Where("id = ?", agentID).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if userID == row.UserID {
		return true, nil
	}
	return row.Visibility == "public" && !destructive, nil
}
