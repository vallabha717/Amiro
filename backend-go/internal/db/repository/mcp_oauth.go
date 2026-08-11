package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"betterchatbot/backend/internal/db/models"
)

// McpOAuthSessionRepository ports pgMcpOAuthRepository
// (mcp-oauth-repository.pg.ts): persistence for internal/mcp/oauth's
// protocol logic, backing the pending-flow state (state/codeVerifier),
// the registered client, and the resulting tokens. Unlike the TS
// repository (a thin key-value CRUD layer that pg-oauth-provider.ts
// drives), this one is consumed directly by internal/mcp's own
// connect/authorize lifecycle -- there's no equivalent to the SDK's
// OAuthClientProvider interface on the Go side to sit behind.
type McpOAuthSessionRepository struct {
	db *gorm.DB
}

func NewMcpOAuthSessionRepository(db *gorm.DB) *McpOAuthSessionRepository {
	return &McpOAuthSessionRepository{db: db}
}

// CreateSession starts a new pending flow for mcpServerID: state +
// codeVerifier are known up front (generated before the authorization URL
// is built), clientInfo/tokens are filled in later via SaveClientInfo/
// SaveTokens as the flow progresses.
func (r *McpOAuthSessionRepository) CreateSession(ctx context.Context, mcpServerID, serverURL, state, codeVerifier string) (*models.McpOAuthSession, error) {
	session := &models.McpOAuthSession{
		McpServerID:  mcpServerID,
		ServerURL:    serverURL,
		State:        &state,
		CodeVerifier: &codeVerifier,
	}
	if err := r.db.WithContext(ctx).Create(session).Error; err != nil {
		return nil, err
	}
	return session, nil
}

// GetByState looks up a pending or completed session by its OAuth state
// parameter -- how the callback route (which only ever receives state,
// never the mcp_server_id) finds which server this authorization belongs
// to.
func (r *McpOAuthSessionRepository) GetByState(ctx context.Context, state string) (*models.McpOAuthSession, error) {
	var session models.McpOAuthSession
	err := r.db.WithContext(ctx).Where("state = ?", state).Take(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &session, nil
}

// GetLatestForServer returns the most recent session row for a server
// (by updated_at), used both to check for already-valid tokens before
// starting a new flow and to reuse a previously-registered OAuth client
// rather than re-running dynamic client registration on every connect.
func (r *McpOAuthSessionRepository) GetLatestForServer(ctx context.Context, mcpServerID string) (*models.McpOAuthSession, error) {
	var session models.McpOAuthSession
	err := r.db.WithContext(ctx).
		Where("mcp_server_id = ?", mcpServerID).
		Order("updated_at DESC").
		Take(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &session, nil
}

// SaveClientInfo persists the resolved OAuth client (registered via DCR,
// or reused from a prior session) plus the discovered endpoints needed to
// complete/repeat the flow later -- internal/mcp's storedClientInfo type
// bundles both into this one JSON column since the table has no separate
// metadata column.
func (r *McpOAuthSessionRepository) SaveClientInfo(ctx context.Context, id string, clientInfo datatypes.JSON) error {
	return r.db.WithContext(ctx).Model(&models.McpOAuthSession{}).Where("id = ?", id).
		Updates(map[string]interface{}{"client_info": clientInfo, "updated_at": time.Now()}).Error
}

// SaveTokens persists the access/refresh token pair after a successful
// code exchange or refresh -- the session row's completion signal
// (internal/mcp treats "has tokens" as "this server is authorized").
func (r *McpOAuthSessionRepository) SaveTokens(ctx context.Context, id string, tokens datatypes.JSON) error {
	return r.db.WithContext(ctx).Model(&models.McpOAuthSession{}).Where("id = ?", id).
		Updates(map[string]interface{}{"tokens": tokens, "updated_at": time.Now()}).Error
}

// SaveTokensAndCleanup ports saveTokensAndCleanup (mcp-oauth-repository.pg.ts:78):
// saves the completed session's tokens, then deletes every other
// abandoned/superseded pending session for the same server (rows that
// never got tokens -- an earlier "Authorize" click the user didn't finish,
// or a retry after a failed exchange) so they don't pile up or get
// mistaken for a valid client registration by GetLatestForServer.
func (r *McpOAuthSessionRepository) SaveTokensAndCleanup(ctx context.Context, id, mcpServerID string, tokens datatypes.JSON) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&models.McpOAuthSession{}).Where("id = ?", id).
			Updates(map[string]interface{}{"tokens": tokens, "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		return tx.Where("mcp_server_id = ? AND id <> ? AND tokens IS NULL", mcpServerID, id).
			Delete(&models.McpOAuthSession{}).Error
	})
}

// DeleteForServer removes every session row for a server -- used when the
// server itself is deleted (Manager.Remove) and by an explicit
// "re-authorize from scratch" action, so a stale/revoked token or a
// client registration tied to a since-changed redirect port never gets
// reused.
func (r *McpOAuthSessionRepository) DeleteForServer(ctx context.Context, mcpServerID string) error {
	return r.db.WithContext(ctx).Where("mcp_server_id = ?", mcpServerID).Delete(&models.McpOAuthSession{}).Error
}
