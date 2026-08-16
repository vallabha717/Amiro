package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sync"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

// authGatedEngine is a fakeMCPEngine variant whose AddMCPClient only
// succeeds once the connection headers carry the expected bearer token --
// simulating a real OAuth-protected MCP server rejecting an unauthenticated
// connection attempt, and accepting one bearing a valid access token.
type authGatedEngine struct {
	mu           sync.Mutex
	wantBearer   string
	added        map[string]bifrostai.MCPClientConfig
	states       []bifrostai.MCPClientState
	connectCalls int
}

func (f *authGatedEngine) AddMCPClient(_ context.Context, cfg bifrostai.MCPClientConfig) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.connectCalls++
	if cfg.Headers["Authorization"] != f.wantBearer {
		return errors.New("401 Unauthorized")
	}
	if f.added == nil {
		f.added = map[string]bifrostai.MCPClientConfig{}
	}
	f.added[cfg.ID] = cfg
	f.states = append(f.states, bifrostai.MCPClientState{ID: cfg.ID, Name: cfg.Name, Status: bifrostai.MCPStatusConnected})
	return nil
}

func (f *authGatedEngine) RemoveMCPClient(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.added, id)
	kept := f.states[:0]
	for _, s := range f.states {
		if s.ID != id {
			kept = append(kept, s)
		}
	}
	f.states = kept
	return nil
}

func (f *authGatedEngine) MCPClientStates() []bifrostai.MCPClientState {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]bifrostai.MCPClientState, len(f.states))
	copy(out, f.states)
	return out
}

func (f *authGatedEngine) CallMCPTool(context.Context, string, string, json.RawMessage) bifrostai.MCPToolCallResult {
	return bifrostai.MCPToolCallResult{}
}

// newFakeOAuthServer stands in for a real OAuth-protected MCP server: it
// serves its own RFC 8414 authorization-server metadata (pointing back at
// itself for every endpoint, the common case for a server that is its own
// authorization server), RFC 7591 dynamic client registration, and the
// token endpoint for both the authorization_code and refresh_token grants.
func newFakeOAuthServer(t *testing.T, accessToken, refreshToken string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"authorization_endpoint": srv.URL + "/authorize",
			"token_endpoint":         srv.URL + "/token",
			"registration_endpoint":  srv.URL + "/register",
		})
	})
	mux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"client_id": "client-abc", "client_secret": "secret-xyz"})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			if r.Form.Get("code_verifier") == "" {
				http.Error(w, "missing code_verifier", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": accessToken, "refresh_token": refreshToken, "token_type": "Bearer", "expires_in": 3600,
			})
		case "refresh_token":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": accessToken + "-refreshed", "token_type": "Bearer", "expires_in": 3600,
			})
		default:
			http.Error(w, "unknown grant_type", http.StatusBadRequest)
		}
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newTestManagerWithOAuth(t *testing.T, engine Engine) (*Manager, *models.User) {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	u := &models.User{Name: "Ada", Email: "ada@example.com"}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	repo := repository.NewMcpRepository(gdb)
	oauthRepo := repository.NewMcpOAuthSessionRepository(gdb)
	m := NewManager(repo, engine).WithOAuth(oauthRepo, func() string { return "http://127.0.0.1:9999" })
	return m, u
}

func stateFromAuthURL(t *testing.T, authURL string) string {
	t.Helper()
	u, err := url.Parse(authURL)
	if err != nil {
		t.Fatalf("parse authorization URL: %v", err)
	}
	state := u.Query().Get("state")
	if state == "" {
		t.Fatalf("authorization URL has no state param: %s", authURL)
	}
	return state
}

func TestOAuthFlow_SaveRemoteServerNeedingAuthEndsInAuthorizingWithURL(t *testing.T) {
	oauthSrv := newFakeOAuthServer(t, "at-1", "rt-1")
	engine := &authGatedEngine{wantBearer: "Bearer at-1"}
	manager, u := newTestManagerWithOAuth(t, engine)

	server, err := manager.Save(context.Background(), SaveInput{
		Name: "my-oauth-server", UserID: u.ID,
		Config: ServerConfig{Remote: &RemoteConfig{URL: oauthSrv.URL}},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if server == nil {
		t.Fatal("expected the server row to survive (not rolled back) when authorization is needed")
	}

	info, err := manager.Get(context.Background(), server.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if info.Status != bifrostai.MCPStatusAuthorizing {
		t.Fatalf("Status = %q, want authorizing", info.Status)
	}
	if info.AuthorizationURL == nil || *info.AuthorizationURL == "" {
		t.Fatal("expected a non-empty AuthorizationURL")
	}
	authURL, err := url.Parse(*info.AuthorizationURL)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if authURL.Query().Get("client_id") != "client-abc" {
		t.Fatalf("client_id = %q, want the DCR-registered client", authURL.Query().Get("client_id"))
	}
	if authURL.Query().Get("code_challenge_method") != "S256" {
		t.Fatal("expected a PKCE S256 challenge in the authorization URL")
	}
}

func TestOAuthFlow_CompleteOAuthExchangesCodeAndReconnectsWithBearerToken(t *testing.T) {
	oauthSrv := newFakeOAuthServer(t, "at-1", "rt-1")
	engine := &authGatedEngine{wantBearer: "Bearer at-1"}
	manager, u := newTestManagerWithOAuth(t, engine)

	server, err := manager.Save(context.Background(), SaveInput{
		Name: "my-oauth-server", UserID: u.ID,
		Config: ServerConfig{Remote: &RemoteConfig{URL: oauthSrv.URL}},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := manager.Get(context.Background(), server.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := stateFromAuthURL(t, *info.AuthorizationURL)

	if err := manager.CompleteOAuth(context.Background(), state, "the-auth-code"); err != nil {
		t.Fatalf("CompleteOAuth: %v", err)
	}

	final, err := manager.Get(context.Background(), server.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != bifrostai.MCPStatusConnected {
		t.Fatalf("Status = %q, want connected after completing OAuth", final.Status)
	}
	if got := engine.added[server.ID].Headers["Authorization"]; got != "Bearer at-1" {
		t.Fatalf("connection Authorization header = %q, want the exchanged access token", got)
	}
}

func TestOAuthFlow_CompleteOAuthWithUnknownStateFails(t *testing.T) {
	engine := &authGatedEngine{}
	manager, _ := newTestManagerWithOAuth(t, engine)

	err := manager.CompleteOAuth(context.Background(), "not-a-real-state", "code")
	if err == nil {
		t.Fatal("expected an error for an unknown oauth state")
	}
}

func TestOAuthFlow_StartOAuthOnNonRemoteServerFails(t *testing.T) {
	engine := &fakeMCPEngine{}
	manager, u := newTestManagerWithOAuth(t, engine)

	server, err := manager.Save(context.Background(), stdioInput("", "stdio-server", u.ID))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	_, err = manager.StartOAuth(context.Background(), server.ID)
	if err == nil {
		t.Fatal("expected an error starting OAuth on a stdio server")
	}
}

func TestOAuthFlow_PlainConnectionFailureWithNoOAuthMetadataStaysAnError(t *testing.T) {
	// A server that fails to connect AND doesn't advertise any OAuth
	// metadata should behave exactly like pre-OAuth Manager: a normal
	// connection error, no "authorizing" status.
	deadServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer deadServer.Close()

	engine := &authGatedEngine{wantBearer: "Bearer never-issued"}
	manager, u := newTestManagerWithOAuth(t, engine)

	_, err := manager.Save(context.Background(), SaveInput{
		Name: "no-oauth-here", UserID: u.ID,
		Config: ServerConfig{Remote: &RemoteConfig{URL: deadServer.URL}},
	})
	if err == nil {
		t.Fatal("expected Save to fail for a server with no OAuth metadata and a rejected connection")
	}
	if errors.Is(err, ErrAuthorizationRequired) {
		t.Fatalf("error should be the plain connection failure, not ErrAuthorizationRequired: %v", err)
	}
	if err.Error() != "401 Unauthorized" {
		t.Fatalf("expected the underlying connection error surfaced unchanged, got: %v", err)
	}
}

// TestOAuthFlow_ReconnectFailureWithAValidTokenSurfacesTheRealErrorNotANewAuthFlow
// is a regression test for a real bug found live (not assumed): after
// CompleteOAuth successfully exchanged a code for tokens, its own
// reconnect attempt failed for an unrelated reason (the fake target
// wasn't a real MCP server) -- and because connect()'s OAuth-fallback
// used to fire on *any* remote connection failure, it silently started a
// brand-new authorization flow (fresh state, fresh URL) instead of
// surfacing that real failure, even though a perfectly valid token had
// just been obtained. Confirmed live via curl against the actual running
// binary before being fixed here and reproduced as a test.
func TestOAuthFlow_ReconnectFailureWithAValidTokenSurfacesTheRealErrorNotANewAuthFlow(t *testing.T) {
	oauthSrv := newFakeOAuthServer(t, "at-1", "rt-1")
	// wantBearer never matches what will actually be sent, even after a
	// successful token exchange -- simulating "the server rejects this
	// otherwise-valid token for some other reason" (wrong scope, briefly
	// down, etc.), not "no token at all."
	engine := &authGatedEngine{wantBearer: "Bearer something-else-entirely"}
	manager, u := newTestManagerWithOAuth(t, engine)

	server, err := manager.Save(context.Background(), SaveInput{
		Name: "flaky-oauth-server", UserID: u.ID,
		Config: ServerConfig{Remote: &RemoteConfig{URL: oauthSrv.URL}},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := manager.Get(context.Background(), server.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := stateFromAuthURL(t, *info.AuthorizationURL)

	err = manager.CompleteOAuth(context.Background(), state, "the-auth-code")
	if err == nil {
		t.Fatal("expected CompleteOAuth to surface the real reconnect failure")
	}
	if errors.Is(err, ErrAuthorizationRequired) {
		t.Fatalf("expected the plain connection error, not another authorization-required signal: %v", err)
	}

	final, err := manager.Get(context.Background(), server.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status == bifrostai.MCPStatusAuthorizing {
		t.Fatal("expected the server NOT to be silently sent back into a fresh oauth flow after a token was already obtained")
	}
}

// TestOAuthFlow_AuthorizingServerNeverHasNilToolInfo is a regression test
// for a real bug found live (not assumed) while browser-testing the
// OAuth UI: a server stuck "authorizing" (never successfully connected,
// so no cached tool info exists yet) serialized ToolInfo as JSON `null`,
// and the frontend's mcp-card.tsx crashed on `toolInfo.length` the moment
// it rendered such a card -- reproduced live, then fixed in
// nonNilToolInfo, and pinned here.
func TestOAuthFlow_AuthorizingServerNeverHasNilToolInfo(t *testing.T) {
	oauthSrv := newFakeOAuthServer(t, "at-1", "rt-1")
	engine := &authGatedEngine{wantBearer: "Bearer at-1"}
	manager, u := newTestManagerWithOAuth(t, engine)

	server, err := manager.Save(context.Background(), SaveInput{
		Name: "authorizing-server", UserID: u.ID,
		Config: ServerConfig{Remote: &RemoteConfig{URL: oauthSrv.URL}},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := manager.Get(context.Background(), server.ID)
	if err != nil {
		t.Fatal(err)
	}
	if info.Status != bifrostai.MCPStatusAuthorizing {
		t.Fatalf("Status = %q, want authorizing (test setup assumption)", info.Status)
	}
	if info.ToolInfo == nil {
		t.Fatal("ToolInfo is nil -- would marshal to JSON null and crash mcp-card.tsx's toolInfo.length read")
	}

	list, err := manager.List(context.Background(), u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ToolInfo == nil {
		t.Fatalf("List()'s ToolInfo is nil, want a non-nil (possibly empty) slice: %+v", list)
	}
}

func TestOAuthFlow_RemoveDeletesOAuthSessions(t *testing.T) {
	oauthSrv := newFakeOAuthServer(t, "at-1", "rt-1")
	engine := &authGatedEngine{wantBearer: "Bearer at-1"}
	manager, u := newTestManagerWithOAuth(t, engine)

	server, err := manager.Save(context.Background(), SaveInput{
		Name: "my-oauth-server", UserID: u.ID,
		Config: ServerConfig{Remote: &RemoteConfig{URL: oauthSrv.URL}},
	})
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Confirm a session actually exists before Remove -- otherwise this
	// test would pass trivially.
	before, err := manager.oauthRepo.GetLatestForServer(context.Background(), server.ID)
	if err != nil || before == nil {
		t.Fatalf("expected an oauth session to exist before Remove, got %+v, err=%v", before, err)
	}

	if err := manager.Remove(context.Background(), server.ID); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	after, err := manager.oauthRepo.GetLatestForServer(context.Background(), server.ID)
	if err != nil {
		t.Fatalf("GetLatestForServer after Remove: %v", err)
	}
	if after != nil {
		t.Fatalf("expected oauth sessions cleaned up after Remove, got %+v", after)
	}
}
