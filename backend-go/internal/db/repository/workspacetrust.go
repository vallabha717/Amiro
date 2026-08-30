package repository

import (
	"context"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"amiro/backend/internal/db/models"
)

// Sources workspace_trust.granted_via records, so a revoke UI (or a later
// audit trail -- Tier 3 of docs/future-implementation/amiro-vs-coding-agents-comparison.md,
// not this phase) can say *why* a root is trusted without guessing.
const (
	// GrantedViaPrompt is a grant a human answered "yes" to on a
	// first-open-of-project trust prompt.
	GrantedViaPrompt = "prompt"
	// GrantedViaEnv is the one exception docs/coding-agent-parity/
	// 01-workspace-trust-and-rules.md carves out: AMIRO_WORKSPACE_ROOT /
	// BETTERCHATBOT_WORKSPACE_ROOT or a CLI flag *is* the user's trust
	// gesture, so the root is granted at process start with no prompt.
	GrantedViaEnv = "env"
)

// WorkspaceTrustRepository ports the trust-grant model from
// docs/coding-agent-parity/01-workspace-trust-and-rules.md: one row per
// (user, resolved_root), consulted by the permission engine every turn.
type WorkspaceTrustRepository struct {
	db *gorm.DB
}

func NewWorkspaceTrustRepository(db *gorm.DB) *WorkspaceTrustRepository {
	return &WorkspaceTrustRepository{db: db}
}

// IsTrusted reports whether userID has ever granted resolvedRoot. Callers
// must pass the same symlink-resolved, absolute path workspace.Workspace.Root()
// produces -- this method does no normalization of its own, deliberately,
// so there is exactly one place a path gets resolved (see the design doc's
// "a grant table that silently diverges from workspace.Resolve's notion of
// 'the same root'" risk).
func (r *WorkspaceTrustRepository) IsTrusted(ctx context.Context, userID, resolvedRoot string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&models.WorkspaceTrust{}).
		Where("user_id = ? AND resolved_root = ?", userID, resolvedRoot).
		Count(&count).Error
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// IsTrustedForTurn is IsTrusted with the one auto-grant exception the
// design doc carves out folded in: when resolvedRoot equals
// processDefaultRoot (the server's own configured default -- setting
// AMIRO_WORKSPACE_ROOT, passing a CLI flag, or, for the TUI, simply
// launching in that directory), that root *is* the user's trust gesture
// and is granted here rather than checked.
//
// This one method is called from both the turn-construction path
// (internal/api/chat/runner.go) and the plain status check
// (internal/api/workspacetrust) precisely so they can never disagree: a
// status check made before any turn has ever run must report the same
// answer a turn would have produced as a side effect, or a first-open
// trust prompt would show for a workspace that was never actually going to
// ask. processDefaultRoot empty (no default workspace configured, e.g. a
// multi-user "serve" deployment) disables the exception entirely -- every
// root is then checked normally.
func (r *WorkspaceTrustRepository) IsTrustedForTurn(ctx context.Context, userID, resolvedRoot, processDefaultRoot string) (bool, error) {
	if processDefaultRoot != "" && resolvedRoot == processDefaultRoot {
		if err := r.Grant(ctx, userID, resolvedRoot, GrantedViaEnv); err != nil {
			return false, err
		}
		return true, nil
	}
	return r.IsTrusted(ctx, userID, resolvedRoot)
}

// Grant records userID's consent for resolvedRoot. Idempotent: granting an
// already-granted root is a no-op rather than a second row or an error, via
// the (user_id, resolved_root) unique constraint the migration declares.
func (r *WorkspaceTrustRepository) Grant(ctx context.Context, userID, resolvedRoot, grantedVia string) error {
	grant := &models.WorkspaceTrust{UserID: userID, ResolvedRoot: resolvedRoot, GrantedVia: grantedVia}
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(grant).Error
}

// Revoke deletes userID's grant for resolvedRoot, if one exists. Per the
// design doc, this is forward-only: it changes what a *future* turn against
// this root may do and undoes nothing already run.
func (r *WorkspaceTrustRepository) Revoke(ctx context.Context, userID, resolvedRoot string) error {
	return r.db.WithContext(ctx).
		Where("user_id = ? AND resolved_root = ?", userID, resolvedRoot).
		Delete(&models.WorkspaceTrust{}).Error
}

// List returns every root userID has granted, newest first -- the data a
// Settings "granted roots, with a revoke action" section renders directly.
func (r *WorkspaceTrustRepository) List(ctx context.Context, userID string) ([]models.WorkspaceTrust, error) {
	var grants []models.WorkspaceTrust
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("granted_at DESC").
		Find(&grants).Error
	return grants, err
}
