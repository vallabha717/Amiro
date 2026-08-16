package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"gorm.io/gorm"

	bifrostai "amiro/backend/internal/ai/bifrost"
	mcpapi "amiro/backend/internal/api/mcp"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/mcp"
	"amiro/backend/internal/middleware"
)

// fakeMCPEngine is a canned mcp.Engine -- see chat_routes_test.go's
// fakeEngine for the same rationale (real routing/auth/persistence
// coverage without a real Bifrost client or real MCP servers).
type fakeMCPEngine struct {
	added  map[string]bifrostai.MCPClientConfig
	addErr error
}

func (f *fakeMCPEngine) AddMCPClient(_ context.Context, cfg bifrostai.MCPClientConfig) error {
	if f.addErr != nil {
		return f.addErr
	}
	if f.added == nil {
		f.added = map[string]bifrostai.MCPClientConfig{}
	}
	f.added[cfg.ID] = cfg
	return nil
}
func (f *fakeMCPEngine) RemoveMCPClient(id string) error {
	delete(f.added, id)
	return nil
}
func (f *fakeMCPEngine) MCPClientStates() []bifrostai.MCPClientState {
	out := make([]bifrostai.MCPClientState, 0, len(f.added))
	for id, cfg := range f.added {
		out = append(out, bifrostai.MCPClientState{ID: id, Name: cfg.Name, Status: bifrostai.MCPStatusConnected, Tools: []bifrostai.MCPToolInfo{{Name: "add"}}})
	}
	return out
}
func (f *fakeMCPEngine) CallMCPTool(_ context.Context, _, _ string, _ json.RawMessage) bifrostai.MCPToolCallResult {
	return bifrostai.MCPToolCallResult{Content: "42"}
}

type mcpTestEnv struct {
	handler http.Handler
	db      *gorm.DB
	token   string
	userID  string
}

func newMcpTestEnv(t *testing.T, engine mcp.Engine) mcpTestEnv {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	mcpRepo := repository.NewMcpRepository(gdb)
	serverCustom := repository.NewMcpServerCustomizationRepository(gdb)
	toolCustom := repository.NewMcpToolCustomizationRepository(gdb)
	manager := mcp.NewManager(mcpRepo, engine)
	mcpHandler := mcpapi.NewHandler(manager, serverCustom, toolCustom)
	handler := New(testConfig(), Handlers{Auth: authService, MCP: mcpHandler})

	do := func(method, path string, body any) *httptest.ResponseRecorder {
		var reader *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			reader = bytes.NewReader(b)
		} else {
			reader = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, path, reader)
		req.Header.Set(middleware.AuthHeader, "test-token")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	registerRec := do(http.MethodPost, "/api/auth/register", map[string]string{"name": "Ada", "email": "ada@example.com", "password": "hunter2"})
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", registerRec.Code, registerRec.Body.String())
	}
	var registerResp struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.Unmarshal(registerRec.Body.Bytes(), &registerResp)

	loginRec := do(http.MethodPost, "/api/auth/login", map[string]string{"email": "ada@example.com", "password": "hunter2"})
	var loginResp struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &loginResp)

	return mcpTestEnv{handler: handler, db: gdb, token: loginResp.Token, userID: registerResp.User.ID}
}

// promoteToAdmin flips a user's role directly in the DB -- there is no HTTP
// path to create an admin (no admin-promotion endpoint exists; out of
// scope), so tests that need one bypass the API the same way a one-off
// migration/seed script would.
func (e mcpTestEnv) promoteToAdmin(t *testing.T, userID string) {
	t.Helper()
	if err := e.db.Model(&models.User{}).Where("id = ?", userID).Update("role", "admin").Error; err != nil {
		t.Fatalf("promoteToAdmin: %v", err)
	}
}

// demoteToUser is the counterpart, and it is needed because the *first*
// account registered on a fresh instance is auto-promoted to admin
// (auth.Service.Register) -- which every env here creates. A test that
// wants to prove a non-admin is refused has to strip that role back off
// first, or it is really testing an admin and passing for the wrong reason.
func (e mcpTestEnv) demoteToUser(t *testing.T, userID string) {
	t.Helper()
	if err := e.db.Model(&models.User{}).Where("id = ?", userID).Update("role", "user").Error; err != nil {
		t.Fatalf("demoteToUser: %v", err)
	}
}

func (e mcpTestEnv) do(t *testing.T, method, path string, body any, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set(middleware.AuthHeader, "test-token")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

func stdioSaveBody(name string) map[string]any {
	return map[string]any{"name": name, "config": map[string]any{"command": "echo"}}
}

func TestRouter_McpSaveCreatesServerAndReturnsID(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	rec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Success bool   `json:"success"`
		ID      string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.Success || resp.ID == "" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestRouter_McpSaveRejectsInvalidName(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	rec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("not a valid name!"), env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestRouter_McpRoutesRequireASessionBearerToken(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	rec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRouter_McpListReturnsCreatedServerWithToolsFromLiveState(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	saveRec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), env.token)
	var saveResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &saveResp)

	rec := env.do(t, http.MethodGet, "/api/mcp/list", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var servers []mcp.ServerInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &servers); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(servers) != 1 || servers[0].ID != saveResp.ID {
		t.Fatalf("servers = %+v", servers)
	}
	if servers[0].Status != bifrostai.MCPStatusConnected {
		t.Fatalf("status = %q, want connected", servers[0].Status)
	}
	if len(servers[0].ToolInfo) != 1 || servers[0].ToolInfo[0].Name != "add" {
		t.Fatalf("toolInfo = %+v", servers[0].ToolInfo)
	}
}

func TestRouter_McpGetHidesConfigFromNonOwner(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	saveRec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("shared-server"), env.token)
	var saveResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &saveResp)

	env.promoteToAdmin(t, env.userID)
	shareRec := env.do(t, http.MethodPost, "/api/mcp/servers/"+saveResp.ID+"/share", map[string]string{"visibility": "public"}, env.token)
	if shareRec.Code != http.StatusOK {
		t.Fatalf("share status = %d, body = %s", shareRec.Code, shareRec.Body.String())
	}

	bobToken := env.registerAndLogin(t, "bob@example.com")
	rec := env.do(t, http.MethodGet, "/api/mcp/servers/"+saveResp.ID, nil, bobToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var info mcp.ServerInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if info.Config != nil {
		t.Fatal("expected config to be hidden from a non-owner")
	}
}

func TestRouter_McpDeleteRejectsNonOwnerAndSucceedsForOwner(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	saveRec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), env.token)
	var saveResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &saveResp)

	bobToken := env.registerAndLogin(t, "bob@example.com")
	rec := env.do(t, http.MethodDelete, "/api/mcp/servers/"+saveResp.ID, nil, bobToken)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-owner delete status = %d, want %d", rec.Code, http.StatusForbidden)
	}

	rec = env.do(t, http.MethodDelete, "/api/mcp/servers/"+saveResp.ID, nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner delete status = %d, body = %s", rec.Code, rec.Body.String())
	}

	getRec := env.do(t, http.MethodGet, "/api/mcp/servers/"+saveResp.ID, nil, env.token)
	if getRec.Code != http.StatusNotFound {
		t.Fatalf("status after delete = %d, want %d", getRec.Code, http.StatusNotFound)
	}
}

func TestRouter_McpRefreshReconnectsServer(t *testing.T) {
	engine := &fakeMCPEngine{}
	env := newMcpTestEnv(t, engine)
	saveRec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), env.token)
	var saveResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &saveResp)

	delete(engine.added, saveResp.ID) // simulate the live connection dropping

	rec := env.do(t, http.MethodPost, "/api/mcp/servers/"+saveResp.ID+"/refresh", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, ok := engine.added[saveResp.ID]; !ok {
		t.Fatal("expected refresh to have reconnected the client")
	}
}

func TestRouter_McpShareRequiresAdmin(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	saveRec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), env.token)
	var saveResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &saveResp)

	// This env's user is the instance's first account and so was auto-
	// promoted to admin; drop it back to a plain user, which is the role
	// this test is actually about.
	env.demoteToUser(t, env.userID)

	rec := env.do(t, http.MethodPost, "/api/mcp/servers/"+saveResp.ID+"/share", map[string]string{"visibility": "public"}, env.token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d (non-admin owner still can't share), body = %s", rec.Code, http.StatusForbidden, rec.Body.String())
	}
}

func TestRouter_McpCallToolReturnsEngineResult(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	saveRec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), env.token)
	var saveResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &saveResp)

	rec := env.do(t, http.MethodPost, "/api/mcp/servers/"+saveResp.ID+"/tools/add/call", map[string]any{"a": 1, "b": 2}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var result bifrostai.MCPToolCallResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Content != "42" {
		t.Fatalf("content = %q, want \"42\"", result.Content)
	}
}

func TestRouter_McpServerCustomizationCRUD(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	saveRec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), env.token)
	var saveResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &saveResp)

	path := "/api/mcp/server-customizations/" + saveResp.ID

	getRec := env.do(t, http.MethodGet, path, nil, env.token)
	if getRec.Code != http.StatusOK || getRec.Body.String() != "{}\n" {
		t.Fatalf("initial GET = %d %q, want an empty object", getRec.Code, getRec.Body.String())
	}

	saveCustomRec := env.do(t, http.MethodPost, path, map[string]string{"prompt": "be terse"}, env.token)
	if saveCustomRec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body = %s", saveCustomRec.Code, saveCustomRec.Body.String())
	}

	getAfterRec := env.do(t, http.MethodGet, path, nil, env.token)
	var result struct {
		Prompt *string `json:"prompt"`
	}
	if err := json.Unmarshal(getAfterRec.Body.Bytes(), &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.Prompt == nil || *result.Prompt != "be terse" {
		t.Fatalf("prompt = %v, want \"be terse\"", result.Prompt)
	}

	deleteRec := env.do(t, http.MethodDelete, path, nil, env.token)
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", deleteRec.Code)
	}
	getFinalRec := env.do(t, http.MethodGet, path, nil, env.token)
	if getFinalRec.Body.String() != "{}\n" {
		t.Fatalf("GET after delete = %q, want an empty object", getFinalRec.Body.String())
	}
}

func TestRouter_McpToolCustomizationCRUD(t *testing.T) {
	env := newMcpTestEnv(t, &fakeMCPEngine{})
	saveRec := env.do(t, http.MethodPost, "/api/mcp", stdioSaveBody("my-server"), env.token)
	var saveResp struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &saveResp)

	path := "/api/mcp/tool-customizations/" + saveResp.ID + "/add"

	saveCustomRec := env.do(t, http.MethodPost, path, map[string]string{"prompt": "round to 2dp"}, env.token)
	if saveCustomRec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body = %s", saveCustomRec.Code, saveCustomRec.Body.String())
	}

	listRec := env.do(t, http.MethodGet, "/api/mcp/tool-customizations/"+saveResp.ID, nil, env.token)
	var list []map[string]any
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d tool customizations, want 1", len(list))
	}

	deleteRec := env.do(t, http.MethodDelete, path, nil, env.token)
	if deleteRec.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", deleteRec.Code)
	}
	getRec := env.do(t, http.MethodGet, path, nil, env.token)
	if getRec.Body.String() != "{}\n" {
		t.Fatalf("GET after delete = %q, want an empty object", getRec.Body.String())
	}
}

// registerAndLogin is a small helper for tests needing a second user.
func (e mcpTestEnv) registerAndLogin(t *testing.T, email string) string {
	t.Helper()
	registerRec := e.do(t, http.MethodPost, "/api/auth/register", map[string]string{"name": "Bob", "email": email, "password": "hunter2"}, "")
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", registerRec.Code, registerRec.Body.String())
	}
	loginRec := e.do(t, http.MethodPost, "/api/auth/login", map[string]string{"email": email, "password": "hunter2"}, "")
	var loginResp struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &loginResp)
	return loginResp.Token
}
