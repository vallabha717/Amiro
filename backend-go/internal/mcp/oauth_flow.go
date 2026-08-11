// oauth_flow.go wires internal/mcp/oauth's protocol logic into Manager's
// connect/authorize lifecycle -- the pieces manager.go's connect() and
// List/Get call into, kept separate so manager.go itself stays focused on
// the plain (non-OAuth) connection lifecycle it always had.
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"gorm.io/datatypes"

	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/mcp/oauth"
)

// mcpOAuthCallbackPath is where the OAuth authorization server redirects
// the user's browser back to after they approve (or deny) access -- ported
// from create-mcp-client.ts's `${BASE_URL}/api/mcp/oauth/callback` redirect
// URI, ../internal/api/mcp wires the actual route.
const mcpOAuthCallbackPath = "/api/mcp/oauth/callback"

// oauthScope is the scope requested of every MCP OAuth server, matching
// create-mcp-client.ts's own client metadata ("mcp:tools") -- the value
// the MCP Authorization spec's own examples use.
const oauthScope = "mcp:tools"

// storedClientInfo bundles the resolved OAuth client together with the
// endpoints Discover found, both stored in one mcp_oauth_session.client_info
// JSON column (the table has no separate metadata column) -- everything
// CompleteOAuth, a later token refresh, or rebuilding the authorization
// URL for List/Get need, without re-running discovery each time.
type storedClientInfo struct {
	ClientID      string `json:"clientId"`
	ClientSecret  string `json:"clientSecret,omitempty"`
	RedirectURI   string `json:"redirectUri"`
	AuthEndpoint  string `json:"authEndpoint"`
	TokenEndpoint string `json:"tokenEndpoint"`
}

func (c storedClientInfo) toOAuthClient() oauth.ClientInfo {
	return oauth.ClientInfo{ClientID: c.ClientID, ClientSecret: c.ClientSecret, RedirectURI: c.RedirectURI}
}

// StartOAuth ports authorizeMcpClientAction (mcp/actions.ts:140): runs
// discovery, resolves (or dynamically registers) an OAuth client, and
// starts a fresh PKCE flow for a remote server, returning the
// authorization URL the frontend opens in a popup. Always starts fresh (a
// new state + verifier) rather than reusing any existing pending session,
// matching PgOAuthClientProvider's own "always create a new in-progress
// session when not authenticated" behavior (pg-oauth-provider.ts:76) --
// an abandoned earlier attempt is superseded, not resumed.
func (m *Manager) StartOAuth(ctx context.Context, id string) (string, error) {
	server, err := m.repo.SelectByID(ctx, id)
	if err != nil {
		return "", err
	}
	if server == nil {
		return "", ErrNotFound
	}
	var cfg ServerConfig
	if err := json.Unmarshal(server.Config, &cfg); err != nil || cfg.Remote == nil {
		return "", errors.New("mcp: oauth authorization only applies to a remote server")
	}
	return m.beginOAuthFlow(ctx, server, cfg.Remote.URL)
}

// beginOAuthFlow is StartOAuth's implementation, also called by connect()
// as the automatic fallback when a remote server's plain connection
// attempt fails -- see that function's doc comment for why a failed
// discovery here just means "this server doesn't need OAuth," not an
// error worth surfacing on its own.
func (m *Manager) beginOAuthFlow(ctx context.Context, server *models.McpServer, serverURL string) (string, error) {
	if m.oauthRepo == nil || m.redirectBaseURL == nil {
		return "", errors.New("mcp: oauth is not available on this server")
	}
	meta, err := oauth.Discover(ctx, serverURL)
	if err != nil {
		return "", err
	}

	redirectURI := m.redirectBaseURL() + mcpOAuthCallbackPath
	client, err := m.resolveOAuthClient(ctx, server.ID, meta, redirectURI)
	if err != nil {
		return "", err
	}

	verifier, err := oauth.GenerateVerifier()
	if err != nil {
		return "", err
	}
	state, err := oauth.GenerateState()
	if err != nil {
		return "", err
	}

	stored := storedClientInfo{
		ClientID: client.ClientID, ClientSecret: client.ClientSecret, RedirectURI: redirectURI,
		AuthEndpoint: meta.AuthorizationEndpoint, TokenEndpoint: meta.TokenEndpoint,
	}
	infoJSON, err := json.Marshal(stored)
	if err != nil {
		return "", err
	}

	session, err := m.oauthRepo.CreateSession(ctx, server.ID, serverURL, state, verifier)
	if err != nil {
		return "", err
	}
	if err := m.oauthRepo.SaveClientInfo(ctx, session.ID, datatypes.JSON(infoJSON)); err != nil {
		return "", err
	}

	_ = m.repo.UpdateConnectionStatus(ctx, server.ID, "authorizing")

	return oauth.BuildAuthorizationURL(meta.AuthorizationEndpoint, client.ClientID, redirectURI, state, oauth.Challenge(verifier), oauthScope)
}

// resolveOAuthClient reuses a previously dynamically-registered client for
// this server when its redirect URI still matches the current one, or
// registers a fresh one via RFC 7591 DCR otherwise. The loopback callback
// port is only stable within one sidecar run -- a restart picks a new
// OS-assigned port -- so a stale registration from a prior run is
// deliberately not reused once the redirect URI no longer matches.
func (m *Manager) resolveOAuthClient(ctx context.Context, serverID string, meta *oauth.Metadata, redirectURI string) (*oauth.ClientInfo, error) {
	if prior, err := m.oauthRepo.GetLatestForServer(ctx, serverID); err == nil && prior != nil && len(prior.ClientInfo) > 0 {
		var info storedClientInfo
		if json.Unmarshal(prior.ClientInfo, &info) == nil && info.ClientID != "" && info.RedirectURI == redirectURI {
			client := info.toOAuthClient()
			return &client, nil
		}
	}
	if meta.RegistrationEndpoint == "" {
		return nil, fmt.Errorf("mcp: server does not support dynamic client registration and has no other way to obtain OAuth credentials")
	}
	return oauth.RegisterClient(ctx, meta.RegistrationEndpoint, redirectURI, "better-chatbot-desktop")
}

// CompleteOAuth ports the callback route's handler body
// (api/mcp/oauth/callback/route.ts): exchanges the code for tokens using
// the pending session's stored PKCE verifier and client, persists the
// tokens, then reconnects the live MCP client so it immediately picks up
// the new Authorization header -- matching the TS route's own
// mcpClientsManager.refreshClient call after a successful finishAuth.
func (m *Manager) CompleteOAuth(ctx context.Context, state, code string) error {
	if m.oauthRepo == nil {
		return errors.New("mcp: oauth is not available on this server")
	}
	session, err := m.oauthRepo.GetByState(ctx, state)
	if err != nil {
		return err
	}
	if session == nil {
		return errors.New("mcp: invalid or expired oauth state")
	}
	if session.CodeVerifier == nil || *session.CodeVerifier == "" {
		return errors.New("mcp: missing pkce verifier for this oauth session")
	}
	var info storedClientInfo
	if err := json.Unmarshal(session.ClientInfo, &info); err != nil || info.TokenEndpoint == "" {
		return errors.New("mcp: missing client info for this oauth session")
	}

	client := info.toOAuthClient()
	tokens, err := oauth.ExchangeCode(ctx, info.TokenEndpoint, &client, code, *session.CodeVerifier)
	if err != nil {
		return err
	}
	tokensJSON, err := json.Marshal(tokens)
	if err != nil {
		return err
	}
	if err := m.oauthRepo.SaveTokensAndCleanup(ctx, session.ID, session.McpServerID, datatypes.JSON(tokensJSON)); err != nil {
		return err
	}

	server, err := m.repo.SelectByID(ctx, session.McpServerID)
	if err != nil {
		return err
	}
	if server == nil {
		return ErrNotFound
	}
	if err := m.connect(ctx, server); err != nil {
		if errors.Is(err, ErrAuthorizationRequired) {
			return nil
		}
		// A real failure with a token now in hand -- mark it "error" (the
		// same outcome Save/Refresh leave a failed reconnect in) rather
		// than leaving the row silently stuck reporting "authorizing"
		// with a now-stale authorization URL from the session that just
		// completed.
		_ = m.repo.UpdateConnectionStatus(ctx, server.ID, "error")
		return err
	}
	return nil
}

// storedAuthHeader returns the Authorization header value for server's
// current OAuth tokens, refreshing first if they're expired and a
// refresh_token is available. Returns "" when there's no usable token (no
// session yet, tokens missing, or a refresh failed) -- connect() treats
// that as "no OAuth header to add," not an error, since a server might
// not need OAuth at all.
func (m *Manager) storedAuthHeader(ctx context.Context, serverID string) string {
	if m.oauthRepo == nil {
		return ""
	}
	session, err := m.oauthRepo.GetLatestForServer(ctx, serverID)
	if err != nil || session == nil || len(session.Tokens) == 0 {
		return ""
	}
	var tokens oauth.Tokens
	if json.Unmarshal(session.Tokens, &tokens) != nil || tokens.AccessToken == "" {
		return ""
	}

	if tokens.Expired() {
		if tokens.RefreshToken == "" {
			return ""
		}
		var info storedClientInfo
		if json.Unmarshal(session.ClientInfo, &info) != nil || info.TokenEndpoint == "" {
			return ""
		}
		client := info.toOAuthClient()
		refreshed, err := oauth.Refresh(ctx, info.TokenEndpoint, &client, tokens.RefreshToken)
		if err != nil {
			return ""
		}
		if tokensJSON, err := json.Marshal(refreshed); err == nil {
			_ = m.oauthRepo.SaveTokens(ctx, session.ID, datatypes.JSON(tokensJSON))
		}
		tokens = *refreshed
	}

	return tokens.AuthHeaderValue()
}

// rebuildAuthorizationURL reconstructs the exact authorization URL for a
// still-pending session, deterministically from its stored state/client
// info/verifier -- List/Get use this to surface it without caching the
// URL string anywhere (PKCE's code_challenge is a pure function of the
// verifier, so this always reproduces the same URL beginOAuthFlow
// originally built).
func (m *Manager) rebuildAuthorizationURL(session models.McpOAuthSession) (string, error) {
	if session.State == nil || session.CodeVerifier == nil {
		return "", errors.New("mcp: incomplete oauth session")
	}
	var info storedClientInfo
	if err := json.Unmarshal(session.ClientInfo, &info); err != nil || info.AuthEndpoint == "" {
		return "", errors.New("mcp: missing client info for this oauth session")
	}
	return oauth.BuildAuthorizationURL(info.AuthEndpoint, info.ClientID, info.RedirectURI, *session.State, oauth.Challenge(*session.CodeVerifier), oauthScope)
}
