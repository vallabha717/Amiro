package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"gorm.io/datatypes"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/db/repository"
)

// Engine is the subset of *bifrostai.Client the manager needs, narrowed to
// an interface (matching internal/api/chat.Engine's precedent) so manager
// tests can substitute a fake MCP connection layer instead of a real
// Bifrost client and real MCP servers.
type Engine interface {
	AddMCPClient(ctx context.Context, cfg bifrostai.MCPClientConfig) error
	RemoveMCPClient(id string) error
	MCPClientStates() []bifrostai.MCPClientState
	CallMCPTool(ctx context.Context, clientID, toolName string, args json.RawMessage) bifrostai.MCPToolCallResult
}

// nameRule ports saveMcpClientAction's nameSchema (mcp/actions.ts:76): the
// user-facing server name, alphanumeric + hyphens only.
var nameRule = regexp.MustCompile(`^[a-zA-Z0-9\-]+$`)

var (
	ErrInvalidName   = errors.New("mcp: name must contain only alphanumeric characters (A-Z, a-z, 0-9) and hyphens (-)")
	ErrNotFound      = errors.New("mcp: server not found")
	ErrDuplicateName = errors.New("mcp: a featured MCP server with this name already exists")
	// ErrAuthorizationRequired is what connect returns when a remote
	// server's plain connection attempt failed but internal/mcp/oauth's
	// discovery found real OAuth metadata for it -- not a hard failure:
	// a pending authorization flow has been started (server status is
	// now "authorizing"), and Save/Refresh treat this as a successful
	// outcome rather than rolling back or marking the server "error".
	ErrAuthorizationRequired = errors.New("mcp: server requires authorization")
)

// Manager owns the MCP server lifecycle: DB config persistence (via
// repository.McpRepository) plus the live Bifrost connection (via Engine).
// Ports create-mcp-clients-manager.ts's MCPClientsManager, including OAuth-
// authenticated remote servers (oauth_flow.go) -- auto-detected the same
// way better-chatbot does: a plain connection attempt fails, discovery
// (internal/mcp/oauth) checks whether the server actually advertises OAuth
// metadata, and if so a PKCE flow starts instead of surfacing a bare
// connection error. oauthRepo/redirectBaseURL are nil-safe (see WithOAuth):
// a Manager built without them behaves exactly as before OAuth support
// existed -- a real gap, cleanly degraded, not a panic.
type Manager struct {
	repo            *repository.McpRepository
	engine          Engine
	oauthRepo       *repository.McpOAuthSessionRepository
	redirectBaseURL func() string
}

func NewManager(repo *repository.McpRepository, engine Engine) *Manager {
	return &Manager{repo: repo, engine: engine}
}

// WithOAuth wires in OAuth support: oauthRepo persists flow state/tokens,
// redirectBaseURL resolves the sidecar's own current loopback base URL
// (e.g. "http://127.0.0.1:8787") lazily -- the real desktop build only
// knows its OS-assigned port after the listener binds, well after
// NewManager runs, so this is a closure evaluated at flow-start time, not
// a fixed string. Returns m so callers can chain it onto NewManager.
func (m *Manager) WithOAuth(oauthRepo *repository.McpOAuthSessionRepository, redirectBaseURL func() string) *Manager {
	m.oauthRepo = oauthRepo
	m.redirectBaseURL = redirectBaseURL
	return m
}

// bifrostClientName sanitizes a user-facing server name for Bifrost's
// internal client-name rule (ASCII, no hyphens, no spaces -- it uses "-" as
// the tool-name prefix separator). The original hyphenated name stays
// exactly as entered in the DB `name` column and every API response;
// this translation is purely an implementation detail of the live
// connection, never surfaced to a caller.
func bifrostClientName(name string) string {
	return strings.ReplaceAll(name, "-", "_")
}

// SaveInput ports McpServerInsert (types/mcp.ts:66).
type SaveInput struct {
	ID         string
	Name       string
	Config     ServerConfig
	UserID     string
	Visibility string
}

// Save ports saveMcpClientAction (mcp/actions.ts:57) + persistClient
// (create-mcp-clients-manager.ts:228): validates the name, upserts the DB
// row, then (re)connects live. A brand-new server (no ID given) that fails
// to connect is rolled back entirely (matching persistClient's `if
// (!server.id) removeClient`); an existing server being updated keeps its
// new config with an "error" status instead, so the caller can fix
// credentials and retry without losing what they just entered.
func (m *Manager) Save(ctx context.Context, input SaveInput) (*models.McpServer, error) {
	if !nameRule.MatchString(input.Name) {
		return nil, ErrInvalidName
	}
	if input.Visibility == "" {
		input.Visibility = "private"
	}

	configJSON, err := json.Marshal(input.Config)
	if err != nil {
		return nil, fmt.Errorf("mcp: invalid server config: %w", err)
	}

	isNew := input.ID == ""
	if input.Visibility == "public" && isNew {
		exists, err := m.repo.ExistsByServerName(ctx, input.Name)
		if err != nil {
			return nil, err
		}
		if exists {
			return nil, ErrDuplicateName
		}
	}

	server := &models.McpServer{
		ID:         input.ID,
		Name:       input.Name,
		Config:     datatypes.JSON(configJSON),
		UserID:     input.UserID,
		Visibility: input.Visibility,
	}
	if err := m.repo.Save(ctx, server); err != nil {
		return nil, err
	}

	if err := m.connectBounded(ctx, server); err != nil {
		if errors.Is(err, ErrAuthorizationRequired) {
			// Not a failure: beginOAuthFlow already left the server
			// "authorizing" -- the caller (frontend) surfaces the
			// authorization URL from the next List/Get, same as any
			// other in-progress connection state.
			return server, nil
		}
		if isNew {
			_ = m.repo.DeleteByID(ctx, server.ID)
		} else {
			_ = m.repo.UpdateConnectionStatus(ctx, server.ID, "error")
		}
		return nil, err
	}

	return server, nil
}

// connect (re)establishes the live Bifrost connection for server's current
// DB config: tear down any existing connection first (mirrors
// create-mcp-clients-manager.ts's addClient always disconnecting a
// previous client instance before creating the new one), then dial and
// cache tool info + status on success. A remote server whose plain
// connection attempt fails gets one more chance via OAuth discovery
// (oauth_flow.go's beginOAuthFlow) before giving up -- but only when it
// wasn't already carrying a stored, presumably-valid OAuth token: a
// server that fails even with a valid token attached has some other
// problem (temporarily down, misconfigured, wrong scope) and should
// surface that error plainly, not restart the whole authorization dance
// from scratch on every failed reconnect. See ErrAuthorizationRequired's
// doc comment for what the fallback path means to a caller.
func (m *Manager) connect(ctx context.Context, server *models.McpServer) error {
	var cfg ServerConfig
	if err := json.Unmarshal(server.Config, &cfg); err != nil {
		return fmt.Errorf("mcp: stored config for %q is invalid: %w", server.Name, err)
	}

	_ = m.engine.RemoveMCPClient(server.ID)

	bc := bifrostai.MCPClientConfig{ID: server.ID, Name: bifrostClientName(server.Name)}
	hadStoredToken := false
	switch {
	case cfg.Stdio != nil:
		bc.ConnectionType = bifrostai.MCPConnectionSTDIO
		bc.Command = cfg.Stdio.Command
		bc.Args = cfg.Stdio.Args
		bc.Env = cfg.Stdio.Env
	case cfg.Remote != nil:
		bc.ConnectionType = bifrostai.MCPConnectionHTTP
		bc.URL = cfg.Remote.URL
		bc.Headers, hadStoredToken = m.remoteHeaders(ctx, server.ID, cfg.Remote.Headers)
	default:
		return ErrInvalidServerConfig
	}

	connectErr := m.engine.AddMCPClient(ctx, bc)
	if connectErr == nil {
		m.syncLiveState(ctx, server.ID)
		return nil
	}

	if cfg.Remote != nil && !hadStoredToken {
		if _, oauthErr := m.beginOAuthFlow(ctx, server, cfg.Remote.URL); oauthErr == nil {
			return ErrAuthorizationRequired
		}
	}
	return connectErr
}

// remoteHeaders merges a remote server's own configured static headers
// with its stored OAuth Authorization header (refreshing first if
// expired), and reports whether it actually added one -- an explicitly
// user-configured Authorization header always wins over an OAuth token,
// matching a user who typed one in wanting exactly that value used, not
// silently overridden (and in that case the return is false: connect()
// should still be free to try OAuth discovery, since a plain static header
// isn't an OAuth token this manager can vouch for).
func (m *Manager) remoteHeaders(ctx context.Context, serverID string, configured map[string]string) (map[string]string, bool) {
	if _, hasAuth := configured["Authorization"]; hasAuth {
		return configured, false
	}
	authHeader := m.storedAuthHeader(ctx, serverID)
	if authHeader == "" {
		return configured, false
	}
	merged := make(map[string]string, len(configured)+1)
	for k, v := range configured {
		merged[k] = v
	}
	merged["Authorization"] = authHeader
	return merged, true
}

// isAuthorizing reports whether server's last known status is a pending
// OAuth flow -- List/Get/CallTool use this to skip a doomed-to-fail
// reconnect attempt (which would otherwise re-run discovery + potentially
// re-register a DCR client on every single poll) until the user actually
// completes it.
func isAuthorizing(server *models.McpServer) bool {
	return server.LastConnectionStatus != nil && *server.LastConnectionStatus == "authorizing"
}

// syncLiveState caches the freshly-connected client's discovered tools and
// status back onto the DB row -- mirrors onToolInfoUpdate/
// onConnectionStatusChange (create-mcp-client.ts:35-36) persisting through
// storage.updateToolInfo/updateConnectionStatus.
func (m *Manager) syncLiveState(ctx context.Context, id string) {
	for _, s := range m.engine.MCPClientStates() {
		if s.ID != id {
			continue
		}
		if toolInfoJSON, err := json.Marshal(s.Tools); err == nil {
			_ = m.repo.UpdateToolInfo(ctx, id, datatypes.JSON(toolInfoJSON))
		}
		status := "connected"
		if s.Status == bifrostai.MCPStatusError {
			status = "error"
		}
		_ = m.repo.UpdateConnectionStatus(ctx, id, status)
		return
	}
}

// Remove ports removeMcpClientAction (mcp/actions.ts:117): delete the DB
// row and disconnect the live client (best-effort -- the client may
// already be down), plus any OAuth session state for it (a re-added
// server with the same URL should never silently inherit a stale/revoked
// token or a client registration tied to a since-changed redirect port).
func (m *Manager) Remove(ctx context.Context, id string) error {
	if err := m.repo.DeleteByID(ctx, id); err != nil {
		return err
	}
	_ = m.engine.RemoveMCPClient(id)
	if m.oauthRepo != nil {
		_ = m.oauthRepo.DeleteForServer(ctx, id)
	}
	return nil
}

// Refresh ports refreshMcpClientAction (mcp/actions.ts:136): reconnect
// using the server's current stored config.
func (m *Manager) Refresh(ctx context.Context, id string) (*models.McpServer, error) {
	server, err := m.repo.SelectByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if server == nil {
		return nil, ErrNotFound
	}
	if err := m.connectBounded(ctx, server); err != nil {
		if errors.Is(err, ErrAuthorizationRequired) {
			return server, nil
		}
		_ = m.repo.UpdateConnectionStatus(ctx, id, "error")
		return server, err
	}
	return server, nil
}

// ShareVisibility ports shareMcpServerAction (mcp/actions.ts:174).
func (m *Manager) ShareVisibility(ctx context.Context, id, visibility string) error {
	if visibility != "public" && visibility != "private" {
		return fmt.Errorf("mcp: invalid visibility %q", visibility)
	}
	return m.repo.UpdateVisibility(ctx, id, visibility)
}

// ServerInfo ports MCPServerInfo (types/mcp.ts:41). AuthorizationURL is new
// (not in the TS type, which the frontend gets via a separate
// authorizeMcpClientAction call) -- populated only for the owner of a
// server whose Status is Authorizing, sparing the frontend a second
// round trip to discover where to send the user.
type ServerInfo struct {
	ID                   string                    `json:"id"`
	Name                 string                    `json:"name"`
	Config               *ServerConfig             `json:"config,omitempty"` // nil when the caller doesn't own the server (config hidden from non-owners)
	Visibility           string                    `json:"visibility"`
	Enabled              bool                      `json:"enabled"`
	UserID               string                    `json:"userId"`
	Status               bifrostai.MCPClientStatus `json:"status"`
	LastConnectionStatus *string                   `json:"lastConnectionStatus,omitempty"`
	AuthorizationURL     *string                   `json:"authorizationUrl,omitempty"`
	ToolInfo             []bifrostai.MCPToolInfo   `json:"toolInfo"`
	CreatedAt            time.Time                 `json:"createdAt"`
	UpdatedAt            time.Time                 `json:"updatedAt"`
	UserName             *string                   `json:"userName,omitempty"`
	UserAvatar           *string                   `json:"userAvatar,omitempty"`
	IsOwner              bool                      `json:"isOwner"`
}

// List ports mcp/list/route.ts's GET handler: every server the user can
// access (their own + public), merged with live connection state. Any
// server in the DB with no live entry yet (e.g. the sidecar's Init hasn't
// reached it, or another process just added it) gets a best-effort
// background connect kicked off, not awaited -- matching the TS route's
// `Promise.allSettled` fire-and-forget refresh.
func (m *Manager) List(ctx context.Context, userID string) ([]ServerInfo, error) {
	rows, err := m.repo.SelectAllForUser(ctx, userID)
	if err != nil {
		return nil, err
	}

	live := make(map[string]bifrostai.MCPClientState)
	for _, s := range m.engine.MCPClientStates() {
		live[s.ID] = s
	}

	out := make([]ServerInfo, 0, len(rows))
	for _, row := range rows {
		isOwner := row.UserID == userID
		info := ServerInfo{
			ID:                   row.ID,
			Name:                 row.Name,
			Visibility:           row.Visibility,
			Enabled:              row.Enabled,
			UserID:               row.UserID,
			LastConnectionStatus: row.LastConnectionStatus,
			CreatedAt:            row.CreatedAt,
			UpdatedAt:            row.UpdatedAt,
			UserName:             row.OwnerName,
			UserAvatar:           row.OwnerAvatar,
			IsOwner:              isOwner,
			Status:               bifrostai.MCPStatusDisconnected,
			ToolInfo:             []bifrostai.MCPToolInfo{},
		}
		if isOwner {
			var cfg ServerConfig
			if json.Unmarshal(row.Config, &cfg) == nil {
				info.Config = &cfg
			}
		}

		if state, ok := live[row.ID]; ok {
			info.Status = state.Status
			info.ToolInfo = nonNilToolInfo(state.Tools)
		} else {
			var cached []bifrostai.MCPToolInfo
			_ = json.Unmarshal(row.ToolInfo, &cached)
			info.ToolInfo = nonNilToolInfo(cached)

			if isAuthorizing(&row.McpServer) {
				info.Status = bifrostai.MCPStatusAuthorizing
				if isOwner {
					info.AuthorizationURL = m.authorizationURLForServer(ctx, row.ID)
				}
			} else {
				rowCopy := row.McpServer
				go func() {
					_ = m.connect(context.WithoutCancel(ctx), &rowCopy)
				}()
			}
		}

		out = append(out, info)
	}
	return out, nil
}

// Get ports selectMcpClientAction (mcp/actions.ts:46): a single server's
// current merged info, connecting lazily first if it has no live state yet
// (mirrors MCPClientsManager.getClient's refreshClient-on-miss) -- unless
// it's already mid-OAuth-flow, matching List's same isAuthorizing skip.
func (m *Manager) Get(ctx context.Context, id string) (*ServerInfo, error) {
	server, err := m.repo.SelectByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if server == nil {
		return nil, nil
	}

	if !m.hasLiveState(id) && !isAuthorizing(server) {
		_ = m.connectBounded(ctx, server)
	}

	info := ServerInfo{
		ID: server.ID, Name: server.Name, Visibility: server.Visibility,
		Enabled: server.Enabled, UserID: server.UserID,
		LastConnectionStatus: server.LastConnectionStatus,
		CreatedAt:            server.CreatedAt, UpdatedAt: server.UpdatedAt,
		Status:   bifrostai.MCPStatusDisconnected,
		ToolInfo: []bifrostai.MCPToolInfo{},
	}
	var cfg ServerConfig
	if json.Unmarshal(server.Config, &cfg) == nil {
		info.Config = &cfg
	}
	if isAuthorizing(server) && !m.hasLiveState(id) {
		info.Status = bifrostai.MCPStatusAuthorizing
		info.AuthorizationURL = m.authorizationURLForServer(ctx, id)
	}
	for _, s := range m.engine.MCPClientStates() {
		if s.ID == id {
			info.Status = s.Status
			info.ToolInfo = nonNilToolInfo(s.Tools)
			break
		}
	}
	return &info, nil
}

// authorizationURLForServer rebuilds the current pending flow's
// authorization URL for the frontend, or nil if there isn't one (no
// session yet, or something about the stored session is incomplete --
// treated as "nothing to show" rather than an error the caller must
// handle).
func (m *Manager) authorizationURLForServer(ctx context.Context, id string) *string {
	if m.oauthRepo == nil {
		return nil
	}
	session, err := m.oauthRepo.GetLatestForServer(ctx, id)
	if err != nil || session == nil {
		return nil
	}
	url, err := m.rebuildAuthorizationURL(*session)
	if err != nil {
		return nil
	}
	return &url
}

// nonNilToolInfo guards against MCPServerInfo.toolInfo ever marshaling to
// JSON `null` -- found live, not assumed: the TS type
// (types/mcp.ts:41) declares toolInfo as a plain (non-nullable) array, and
// mcp-card.tsx reads `toolInfo.length` unconditionally. A Go nil slice
// marshals to `null` by default, which crashes that read the moment a
// server the frontend renders has never had live tool info cached (e.g.
// brand new, or -- the case that actually surfaced this live while
// testing OAuth -- stuck "authorizing" with no successful connection
// yet).
func nonNilToolInfo(tools []bifrostai.MCPToolInfo) []bifrostai.MCPToolInfo {
	if tools == nil {
		return []bifrostai.MCPToolInfo{}
	}
	return tools
}

func (m *Manager) hasLiveState(id string) bool {
	for _, s := range m.engine.MCPClientStates() {
		if s.ID == id {
			return true
		}
	}
	return false
}

// CallTool ports toolCall (create-mcp-clients-manager.ts:319): connects
// lazily if the client has no live state yet, then invokes the tool. A
// server mid-OAuth-flow fails fast with a clear error instead of
// re-running discovery (and potentially re-registering a DCR client) on
// every single tool call attempted while the user still hasn't finished
// authorizing in their browser.
func (m *Manager) CallTool(ctx context.Context, id, toolName string, args json.RawMessage) bifrostai.MCPToolCallResult {
	if !m.hasLiveState(id) {
		server, err := m.repo.SelectByID(ctx, id)
		if err != nil || server == nil {
			return bifrostai.MCPToolCallResult{IsError: true, Error: ErrNotFound.Error()}
		}
		if isAuthorizing(server) {
			return bifrostai.MCPToolCallResult{IsError: true, Error: ErrAuthorizationRequired.Error()}
		}
		if err := m.connectBounded(ctx, server); err != nil {
			return bifrostai.MCPToolCallResult{IsError: true, Error: err.Error()}
		}
	}
	return m.engine.CallMCPTool(ctx, id, toolName, args)
}

// mcpConnectTimeout bounds connectBounded's wait for a first-time connect
// mid tool-call -- generous enough for a real `npx` package fetch, but
// short enough that a stuck one doesn't out-wait a user's patience. Kept
// under bifrost/core's own DefaultToolExecutionTimeout (30s) so, once
// connected, the actual tool call still gets to run within the request's
// remaining budget rather than this timeout eating all of it. A var, not a
// const, so tests can shrink it instead of waiting out the real duration.
var mcpConnectTimeout = 20 * time.Second

// connectBounded runs connect on its own goroutine and returns as soon as
// it finishes, ctx is canceled, or mcpConnectTimeout elapses -- whichever
// comes first. This exists because connect()'s STDIO transport spawns the
// server subprocess on bifrost/core's own un-timed "long-lived" context,
// deliberately decoupled from the request context so the connection can
// outlive a single chat request -- which also means a stalled `npx`
// (network hang, zombie child, ...) never returns from connect() and
// never notices ctx cancellation either. Found live: a chat request
// against a tool name the server didn't expose triggered exactly this,
// and the UI's Stop button couldn't recover it because nothing was
// watching a deadline on this specific path (every other call in the MCP
// chain is already bounded, by bifrost/core's own tool-execution timeout
// or by ctx). The connect() goroutine itself keeps running to completion
// in the background either way -- we can't kill what the vendored
// library won't let us cancel -- but the caller, and therefore the user's
// chat request, is no longer held hostage by it.
func (m *Manager) connectBounded(ctx context.Context, server *models.McpServer) error {
	done := make(chan error, 1)
	go func() { done <- m.connect(ctx, server) }()

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(mcpConnectTimeout):
		return fmt.Errorf("mcp: connecting to server %q timed out after %s", server.Name, mcpConnectTimeout)
	}
}

// CallToolByServerName ports toolCallByServerName (create-mcp-clients-manager.ts:300).
func (m *Manager) CallToolByServerName(ctx context.Context, serverName, toolName string, args json.RawMessage) bifrostai.MCPToolCallResult {
	server, err := m.repo.SelectByServerName(ctx, serverName)
	if err != nil || server == nil {
		return bifrostai.MCPToolCallResult{IsError: true, Error: fmt.Sprintf("mcp: server %q not found", serverName)}
	}
	return m.CallTool(ctx, server.ID, toolName, args)
}

// Init connects every server persisted in the DB at startup. Unlike the TS
// manager's init() (which skips connecting servers whose last known status
// was "error", registering them inertly for a manual refresh), this always
// attempts a live reconnect for every stored config -- simpler, and Bifrost
// itself already retains a failed client in a recoverable disconnected
// state with its own health-monitor retry for the boot-config path; for
// dynamically-added clients (this manager's AddMCPClient/connect path) a
// failed attempt here just leaves last_connection_status="error" in the DB,
// visible to a manual Refresh the same as the TS behavior's end state.
// Deliberate simplification, not a bug -- documented in the progress log.
func (m *Manager) Init(ctx context.Context) {
	servers, err := m.repo.SelectAll(ctx)
	if err != nil {
		return
	}
	done := make(chan struct{}, len(servers))
	for _, s := range servers {
		s := s
		go func() {
			defer func() { done <- struct{}{} }()
			if isAuthorizing(&s) {
				// Leave it be: a pending flow from before this restart is
				// still completable (its state/verifier are stored, not
				// tied to the process), and re-running connect here would
				// just kick off a redundant new one via beginOAuthFlow.
				return
			}
			if err := m.connectBounded(ctx, &s); err != nil && !errors.Is(err, ErrAuthorizationRequired) {
				_ = m.repo.UpdateConnectionStatus(ctx, s.ID, "error")
			}
		}()
	}
	for range servers {
		<-done
	}
}
