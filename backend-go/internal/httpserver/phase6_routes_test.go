package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	bifrostai "amiro/backend/internal/ai/bifrost"
	agentapi "amiro/backend/internal/api/agent"
	archiveapi "amiro/backend/internal/api/archive"
	bookmarkapi "amiro/backend/internal/api/bookmark"
	exportapi "amiro/backend/internal/api/export"
	storageapi "amiro/backend/internal/api/storage"
	threadapi "amiro/backend/internal/api/thread"
	userapi "amiro/backend/internal/api/user"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/mcp"
	"amiro/backend/internal/middleware"
	"amiro/backend/internal/storage"
)

// fakeObjectEngine is a canned agentapi.Engine -- same rationale as
// chat_routes_test.go's fakeEngine: real routing/auth/persistence coverage
// with no Bifrost client and no provider keys.
type fakeObjectEngine struct {
	gotSystem string
	gotSchema json.RawMessage
	object    string
}

func (f *fakeObjectEngine) GenerateObject(_ context.Context, _ bifrostai.ResolvedModel, system string, _ []bifrostai.Message, schema json.RawMessage) (json.RawMessage, *bifrostai.Usage, error) {
	f.gotSystem = system
	f.gotSchema = schema
	if f.object == "" {
		f.object = `{"name":"Researcher","description":"d","instructions":"i","role":"r","tools":[]}`
	}
	return json.RawMessage(f.object), nil, nil
}

// fakeMCPTools / fakeWorkflowTools stand in for the two tool sources the
// agent-generation route enumerates.
type fakeMCPTools struct{ names []string }

func (f *fakeMCPTools) List(_ context.Context, _ string) ([]mcp.ServerInfo, error) {
	tools := make([]bifrostai.MCPToolInfo, 0, len(f.names))
	for _, name := range f.names {
		tools = append(tools, bifrostai.MCPToolInfo{Name: name})
	}
	return []mcp.ServerInfo{{ID: "s1", Name: "everything", ToolInfo: tools}}, nil
}

type fakeWorkflowTools struct{ names []string }

func (f *fakeWorkflowTools) SelectExecuteAbility(_ context.Context, _ string) ([]repository.WorkflowWithOwner, error) {
	out := make([]repository.WorkflowWithOwner, 0, len(f.names))
	for _, name := range f.names {
		out = append(out, repository.WorkflowWithOwner{Workflow: models.Workflow{Name: name}})
	}
	return out, nil
}

type phase6Env struct {
	handler     http.Handler
	db          *gorm.DB
	engine      *fakeObjectEngine
	store       storage.Storage
	authService *auth.Service
	token       string
	userID      string

	otherToken  string
	otherUserID string
}

func newPhase6Env(t *testing.T) phase6Env {
	t.Helper()
	dir := t.TempDir()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}

	authService := auth.NewService(gdb)
	chatRepo := repository.NewChatRepository(gdb)
	exportRepo := repository.NewChatExportRepository(gdb, chatRepo)
	engine := &fakeObjectEngine{}
	store, err := storage.NewLocalStorage(dir, []byte("signing-secret"), "http://127.0.0.1:9999")
	if err != nil {
		t.Fatalf("NewLocalStorage: %v", err)
	}
	handler := New(testConfig(), Handlers{
		Auth: authService,
		Agent: agentapi.NewHandler(
			repository.NewAgentRepository(gdb), engine,
			&fakeMCPTools{names: []string{"echo", "get-sum"}},
			&fakeWorkflowTools{names: []string{"Summarize"}},
		),
		Archive:  archiveapi.NewHandler(repository.NewArchiveRepository(gdb)),
		Bookmark: bookmarkapi.NewHandler(repository.NewBookmarkRepository(gdb)),
		Export:   exportapi.NewHandler(exportRepo),
		Thread:   threadapi.NewHandler(chatRepo),
		User:     userapi.NewHandler(repository.NewUserRepository(gdb), authService),
		Storage:  storageapi.NewHandler(store),
	})

	env := phase6Env{handler: handler, db: gdb, engine: engine, store: store, authService: authService}
	env.userID, env.token = env.registerAndLogin(t, "Ada", "ada@example.com")
	env.otherUserID, env.otherToken = env.registerAndLogin(t, "Grace", "grace@example.com")
	return env
}

func (e phase6Env) registerAndLogin(t *testing.T, name, email string) (string, string) {
	t.Helper()
	registerRec := e.do(t, http.MethodPost, "/api/auth/register",
		map[string]string{"name": name, "email": email, "password": "hunter2"}, "")
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register: status %d, body %s", registerRec.Code, registerRec.Body.String())
	}
	var registerResp struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.Unmarshal(registerRec.Body.Bytes(), &registerResp)

	loginRec := e.do(t, http.MethodPost, "/api/auth/login",
		map[string]string{"email": email, "password": "hunter2"}, "")
	var loginResp struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &loginResp)
	return registerResp.User.ID, loginResp.Token
}

func (e phase6Env) do(t *testing.T, method, path string, body any, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(encoded)
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

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), dst); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
}

// ---------------------------------------------------------------- agent

func (e phase6Env) createAgent(t *testing.T, bearer, name, visibility string) string {
	t.Helper()
	rec := e.do(t, http.MethodPost, "/api/agent", map[string]any{
		"name":         name,
		"visibility":   visibility,
		"instructions": map[string]any{"role": "tester"},
	}, bearer)
	if rec.Code != http.StatusOK {
		t.Fatalf("create agent: status %d, body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		ID string `json:"id"`
	}
	decodeBody(t, rec, &resp)
	return resp.ID
}

func TestPhase6Routes_AgentCreateReadUpdateDelete(t *testing.T) {
	env := newPhase6Env(t)
	id := env.createAgent(t, env.token, "Researcher", "private")

	getRec := env.do(t, http.MethodGet, "/api/agent/"+id, nil, env.token)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get: status %d, body %s", getRec.Code, getRec.Body.String())
	}
	var got struct {
		Name         string          `json:"name"`
		Instructions json.RawMessage `json:"instructions"`
	}
	decodeBody(t, getRec, &got)
	if got.Name != "Researcher" {
		t.Fatalf("name = %q", got.Name)
	}
	if !strings.Contains(string(got.Instructions), "tester") {
		t.Fatalf("instructions = %s", got.Instructions)
	}

	putRec := env.do(t, http.MethodPut, "/api/agent/"+id, map[string]any{"name": "Renamed"}, env.token)
	if putRec.Code != http.StatusOK {
		t.Fatalf("put: status %d, body %s", putRec.Code, putRec.Body.String())
	}

	afterRec := env.do(t, http.MethodGet, "/api/agent/"+id, nil, env.token)
	decodeBody(t, afterRec, &got)
	if got.Name != "Renamed" {
		t.Fatalf("name after update = %q", got.Name)
	}
	// The update omitted instructions, so they must survive untouched.
	if !strings.Contains(string(got.Instructions), "tester") {
		t.Fatalf("instructions were blanked by a partial update: %s", got.Instructions)
	}

	delRec := env.do(t, http.MethodDelete, "/api/agent/"+id, nil, env.token)
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete: status %d", delRec.Code)
	}
	if gone := env.do(t, http.MethodGet, "/api/agent/"+id, nil, env.token); gone.Code == http.StatusOK {
		t.Fatal("agent still readable after delete")
	}
}

func TestPhase6Routes_AgentListOmitsInstructionsAndForeignPrivateAgents(t *testing.T) {
	env := newPhase6Env(t)
	env.createAgent(t, env.token, "Mine", "private")
	env.createAgent(t, env.otherToken, "Theirs Private", "private")
	env.createAgent(t, env.otherToken, "Theirs Public", "public")

	rec := env.do(t, http.MethodGet, "/api/agent", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	var list []struct {
		Name         string          `json:"name"`
		Instructions json.RawMessage `json:"instructions"`
		UserName     string          `json:"userName"`
	}
	decodeBody(t, rec, &list)

	names := map[string]bool{}
	for _, item := range list {
		names[item.Name] = true
		if len(item.Instructions) != 0 {
			t.Fatalf("%q carried instructions into the list response", item.Name)
		}
		if item.UserName == "" {
			t.Fatalf("%q has no userName -- the owner join did not run", item.Name)
		}
	}
	if !names["Mine"] || !names["Theirs Public"] {
		t.Fatalf("got %v", names)
	}
	if names["Theirs Private"] {
		t.Fatal("another user's private agent leaked into the list")
	}
}

func TestPhase6Routes_AgentListRejectsAnInvalidLimit(t *testing.T) {
	env := newPhase6Env(t)

	for _, query := range []string{"?limit=0", "?limit=101", "?limit=abc", "?type=bogus"} {
		rec := env.do(t, http.MethodGet, "/api/agent"+query, nil, env.token)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d, want 400", query, rec.Code)
		}
	}
}

func TestPhase6Routes_AgentCreateRejectsAnOverlongName(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPost, "/api/agent", map[string]any{
		"name": strings.Repeat("x", 101),
	}, env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}

// A non-owner editing a public agent may change its content but not its
// visibility -- otherwise anyone could take a shared agent private.
func TestPhase6Routes_AgentUpdatePreservesVisibilityForNonOwners(t *testing.T) {
	env := newPhase6Env(t)
	id := env.createAgent(t, env.token, "Shared", "public")

	rec := env.do(t, http.MethodPut, "/api/agent/"+id,
		map[string]any{"name": "Hijacked", "visibility": "private"}, env.otherToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}

	getRec := env.do(t, http.MethodGet, "/api/agent/"+id, nil, env.token)
	var got struct {
		Name       string `json:"name"`
		Visibility string `json:"visibility"`
	}
	decodeBody(t, getRec, &got)
	if got.Name != "Hijacked" {
		t.Fatalf("name = %q -- a non-owner edit of a public agent should apply", got.Name)
	}
	if got.Visibility != "public" {
		t.Fatalf("visibility = %q, want public", got.Visibility)
	}
}

func TestPhase6Routes_AgentDeleteRejectsANonOwnerEvenOnAPublicAgent(t *testing.T) {
	env := newPhase6Env(t)
	id := env.createAgent(t, env.token, "Shared", "public")

	rec := env.do(t, http.MethodDelete, "/api/agent/"+id, nil, env.otherToken)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
	if still := env.do(t, http.MethodGet, "/api/agent/"+id, nil, env.token); still.Code != http.StatusOK {
		t.Fatal("the agent was deleted by a non-owner")
	}
}

// POST /api/agent/ai and GET /api/agent/{id} share a path shape that
// net/http.ServeMux would reject if both were registered for one method;
// this pins that the split by method actually routes correctly.
func TestPhase6Routes_AgentGenerateRoutesAheadOfTheIDWildcard(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPost, "/api/agent/ai", map[string]any{"message": "build me a researcher"}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("content type = %q, want text/plain (toTextStreamResponse's)", ct)
	}

	var object struct {
		Name string `json:"name"`
	}
	decodeBody(t, rec, &object)
	if object.Name != "Researcher" {
		t.Fatalf("object = %s", rec.Body.String())
	}
}

func TestPhase6Routes_AgentGenerateOffersEveryAvailableToolToTheModel(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPost, "/api/agent/ai", map[string]any{"message": "hi"}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}

	for _, tool := range []string{"echo", "get-sum", "Summarize"} {
		if !strings.Contains(env.engine.gotSystem, "- "+tool) {
			t.Fatalf("system prompt is missing tool %q:\n%s", tool, env.engine.gotSystem)
		}
		if !strings.Contains(string(env.engine.gotSchema), `"`+tool+`"`) {
			t.Fatalf("schema enum is missing tool %q: %s", tool, env.engine.gotSchema)
		}
	}
}

// -------------------------------------------------------------- archive

func TestPhase6Routes_ArchiveLifecycleWithItems(t *testing.T) {
	env := newPhase6Env(t)
	ctx := context.Background()
	chats := repository.NewChatRepository(env.db)
	if err := chats.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "Thread", UserID: env.userID}); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}

	createRec := env.do(t, http.MethodPost, "/api/archive",
		map[string]any{"name": "Reading list", "description": "later"}, env.token)
	if createRec.Code != http.StatusOK {
		t.Fatalf("create: status %d, body %s", createRec.Code, createRec.Body.String())
	}
	var archive struct {
		ID string `json:"id"`
	}
	decodeBody(t, createRec, &archive)

	addRec := env.do(t, http.MethodPost, "/api/archive/"+archive.ID+"/items", map[string]any{"itemId": "t1"}, env.token)
	if addRec.Code != http.StatusOK {
		t.Fatalf("add item: status %d, body %s", addRec.Code, addRec.Body.String())
	}

	listRec := env.do(t, http.MethodGet, "/api/archive", nil, env.token)
	var list []struct {
		Name      string `json:"name"`
		ItemCount int    `json:"itemCount"`
	}
	decodeBody(t, listRec, &list)
	if len(list) != 1 || list[0].ItemCount != 1 {
		t.Fatalf("list = %+v, want one archive holding one item", list)
	}

	getRec := env.do(t, http.MethodGet, "/api/archive/"+archive.ID, nil, env.token)
	var detail struct {
		Name  string `json:"name"`
		Items []struct {
			ItemID string `json:"itemId"`
		} `json:"items"`
	}
	decodeBody(t, getRec, &detail)
	if len(detail.Items) != 1 || detail.Items[0].ItemID != "t1" {
		t.Fatalf("detail = %+v", detail)
	}

	removeRec := env.do(t, http.MethodDelete, "/api/archive/"+archive.ID+"/items/t1", nil, env.token)
	if removeRec.Code != http.StatusOK {
		t.Fatalf("remove item: status %d, body %s", removeRec.Code, removeRec.Body.String())
	}
	if again := env.do(t, http.MethodDelete, "/api/archive/"+archive.ID+"/items/t1", nil, env.token); again.Code != http.StatusNotFound {
		t.Fatalf("removing an absent item: status %d, want 404", again.Code)
	}

	delRec := env.do(t, http.MethodDelete, "/api/archive/"+archive.ID, nil, env.token)
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete: status %d", delRec.Code)
	}
}

func TestPhase6Routes_ArchiveIsInvisibleToOtherUsers(t *testing.T) {
	env := newPhase6Env(t)
	createRec := env.do(t, http.MethodPost, "/api/archive", map[string]any{"name": "Mine"}, env.token)
	var archive struct {
		ID string `json:"id"`
	}
	decodeBody(t, createRec, &archive)

	for _, tc := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/archive/" + archive.ID, nil},
		{http.MethodPut, "/api/archive/" + archive.ID, map[string]any{"name": "Theirs"}},
		{http.MethodDelete, "/api/archive/" + archive.ID, nil},
		{http.MethodGet, "/api/archive/" + archive.ID + "/items", nil},
		{http.MethodPost, "/api/archive/" + archive.ID + "/items", map[string]any{"itemId": "t1"}},
	} {
		rec := env.do(t, tc.method, tc.path, tc.body, env.otherToken)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s %s: status %d, want 403", tc.method, tc.path, rec.Code)
		}
	}
}

func TestPhase6Routes_ArchiveUpdateKeepsTheNameWhenOnlyTheDescriptionChanges(t *testing.T) {
	env := newPhase6Env(t)
	createRec := env.do(t, http.MethodPost, "/api/archive", map[string]any{"name": "Keep me"}, env.token)
	var archive struct {
		ID string `json:"id"`
	}
	decodeBody(t, createRec, &archive)

	putRec := env.do(t, http.MethodPut, "/api/archive/"+archive.ID, map[string]any{"description": "new"}, env.token)
	if putRec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", putRec.Code, putRec.Body.String())
	}
	var updated struct {
		Name        string  `json:"name"`
		Description *string `json:"description"`
	}
	decodeBody(t, putRec, &updated)
	if updated.Name != "Keep me" {
		t.Fatalf("name = %q -- a description-only edit must not blank the name", updated.Name)
	}
	if updated.Description == nil || *updated.Description != "new" {
		t.Fatalf("description = %v", updated.Description)
	}
}

func TestPhase6Routes_ArchiveMissingIDIsNotFound(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodGet, "/api/archive/no-such-id", nil, env.token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
}

// ------------------------------------------------------------- bookmark

func TestPhase6Routes_BookmarkCreateThenDeleteFlowsThroughAgentList(t *testing.T) {
	env := newPhase6Env(t)
	id := env.createAgent(t, env.otherToken, "Shared", "public")

	createRec := env.do(t, http.MethodPost, "/api/bookmark",
		map[string]any{"itemId": id, "itemType": "agent"}, env.token)
	if createRec.Code != http.StatusOK {
		t.Fatalf("create: status %d, body %s", createRec.Code, createRec.Body.String())
	}

	listRec := env.do(t, http.MethodGet, "/api/agent?type=bookmarked", nil, env.token)
	var list []struct {
		Name         string `json:"name"`
		IsBookmarked bool   `json:"isBookmarked"`
	}
	decodeBody(t, listRec, &list)
	if len(list) != 1 || !list[0].IsBookmarked {
		t.Fatalf("bookmarked list = %+v", list)
	}

	delRec := env.do(t, http.MethodDelete, "/api/bookmark",
		map[string]any{"itemId": id, "itemType": "agent"}, env.token)
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete: status %d", delRec.Code)
	}

	afterRec := env.do(t, http.MethodGet, "/api/agent?type=bookmarked", nil, env.token)
	decodeBody(t, afterRec, &list)
	if len(list) != 0 {
		t.Fatalf("bookmarked list after removal = %+v", list)
	}
}

func TestPhase6Routes_BookmarkRejectsAnInaccessibleItem(t *testing.T) {
	env := newPhase6Env(t)
	id := env.createAgent(t, env.otherToken, "Private", "private")

	rec := env.do(t, http.MethodPost, "/api/bookmark",
		map[string]any{"itemId": id, "itemType": "agent"}, env.token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
}

func TestPhase6Routes_BookmarkRejectsAnUnknownItemType(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPost, "/api/bookmark",
		map[string]any{"itemId": "x", "itemType": "mcp"}, env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}

// --------------------------------------------------------------- thread

func TestPhase6Routes_ThreadListReportsLastMessageAtAsEpochMillis(t *testing.T) {
	env := newPhase6Env(t)
	ctx := context.Background()
	chats := repository.NewChatRepository(env.db)
	_ = chats.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "With messages", UserID: env.userID})
	_ = chats.InsertThread(ctx, &models.ChatThread{ID: "t2", Title: "Empty", UserID: env.userID})
	_ = chats.UpsertMessage(ctx, &models.ChatMessage{ID: "m1", ThreadID: "t1", Role: "user", Parts: []byte(`[]`)})

	rec := env.do(t, http.MethodGet, "/api/thread", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	var list []struct {
		ID            string `json:"id"`
		LastMessageAt int64  `json:"lastMessageAt"`
	}
	decodeBody(t, rec, &list)

	if len(list) != 2 || list[0].ID != "t1" {
		t.Fatalf("list = %+v, want the active thread first", list)
	}
	if list[0].LastMessageAt <= 0 {
		t.Fatalf("lastMessageAt = %d, want epoch millis", list[0].LastMessageAt)
	}
	if list[1].LastMessageAt != 0 {
		t.Fatalf("an empty thread reported lastMessageAt = %d, want 0", list[1].LastMessageAt)
	}
}

func TestPhase6Routes_ThreadListRequiresASession(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodGet, "/api/thread", nil, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
}

// --------------------------------------------------------------- export

func (e phase6Env) seedExport(t *testing.T, exporterID string) string {
	t.Helper()
	export := &models.ChatExport{
		Title:      "Shared chat",
		ExporterID: exporterID,
		Messages:   []byte(`[{"id":"m1","role":"user","parts":[]}]`),
	}
	if err := e.db.Create(export).Error; err != nil {
		t.Fatalf("seed export: %v", err)
	}
	return export.ID
}

func TestPhase6Routes_ExportListAndDelete(t *testing.T) {
	env := newPhase6Env(t)
	id := env.seedExport(t, env.userID)

	listRec := env.do(t, http.MethodGet, "/api/export", nil, env.token)
	var list []struct {
		ID           string `json:"id"`
		CommentCount int    `json:"commentCount"`
	}
	decodeBody(t, listRec, &list)
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("list = %+v", list)
	}

	if foreign := env.do(t, http.MethodDelete, "/api/export/"+id, nil, env.otherToken); foreign.Code != http.StatusForbidden {
		t.Fatalf("non-exporter delete: status %d, want 403", foreign.Code)
	}
	if own := env.do(t, http.MethodDelete, "/api/export/"+id, nil, env.token); own.Code != http.StatusOK {
		t.Fatalf("exporter delete: status %d", own.Code)
	}
}

// The share link is public: reading an export and its comments must work
// with no Authorization header at all.
func TestPhase6Routes_ExportIsReadableWithoutASession(t *testing.T) {
	env := newPhase6Env(t)
	id := env.seedExport(t, env.userID)

	rec := env.do(t, http.MethodGet, "/api/export/"+id, nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Title        string          `json:"title"`
		ExporterName *string         `json:"exporterName"`
		Messages     json.RawMessage `json:"messages"`
		IsExpired    bool            `json:"isExpired"`
	}
	decodeBody(t, rec, &got)
	if got.Title != "Shared chat" || got.ExporterName == nil || *got.ExporterName != "Ada" {
		t.Fatalf("got %+v", got)
	}
	if got.IsExpired {
		t.Fatal("isExpired = true for an export with no expiry")
	}
	if !strings.Contains(string(got.Messages), "m1") {
		t.Fatalf("messages = %s", got.Messages)
	}
}

func TestPhase6Routes_ExpiredExportWithholdsItsMessages(t *testing.T) {
	env := newPhase6Env(t)
	id := env.seedExport(t, env.userID)
	past := time.Now().Add(-time.Hour)
	if err := env.db.Model(&models.ChatExport{}).Where("id = ?", id).Update("expires_at", past).Error; err != nil {
		t.Fatalf("expire: %v", err)
	}

	rec := env.do(t, http.MethodGet, "/api/export/"+id, nil, "")
	var got struct {
		Messages  json.RawMessage `json:"messages"`
		IsExpired bool            `json:"isExpired"`
	}
	decodeBody(t, rec, &got)

	if !got.IsExpired {
		t.Fatal("isExpired = false for an export whose expiry has passed")
	}
	if strings.Contains(string(got.Messages), "m1") {
		t.Fatalf("an expired export served its messages: %s", got.Messages)
	}
}

func TestPhase6Routes_ExportCommentsThreadAndOwnership(t *testing.T) {
	env := newPhase6Env(t)
	id := env.seedExport(t, env.userID)

	postRec := env.do(t, http.MethodPost, "/api/export/"+id+"/comments",
		map[string]any{"content": map[string]any{"type": "doc"}}, env.otherToken)
	if postRec.Code != http.StatusOK {
		t.Fatalf("post comment: status %d, body %s", postRec.Code, postRec.Body.String())
	}

	// Anonymous read: comments visible, but nothing is claimed as owned.
	anonRec := env.do(t, http.MethodGet, "/api/export/"+id+"/comments", nil, "")
	var anon []struct {
		ID      string `json:"id"`
		IsOwner bool   `json:"isOwner"`
	}
	decodeBody(t, anonRec, &anon)
	if len(anon) != 1 || anon[0].IsOwner {
		t.Fatalf("anonymous comments = %+v", anon)
	}

	// The author's read marks their own comment.
	authorRec := env.do(t, http.MethodGet, "/api/export/"+id+"/comments", nil, env.otherToken)
	var authored []struct {
		ID      string `json:"id"`
		IsOwner bool   `json:"isOwner"`
	}
	decodeBody(t, authorRec, &authored)
	if !authored[0].IsOwner {
		t.Fatal("isOwner = false for the comment's own author")
	}

	commentID := authored[0].ID
	if foreign := env.do(t, http.MethodDelete, "/api/export/"+id+"/comments/"+commentID, nil, env.token); foreign.Code != http.StatusForbidden {
		t.Fatalf("non-author delete: status %d, want 403", foreign.Code)
	}
	if own := env.do(t, http.MethodDelete, "/api/export/"+id+"/comments/"+commentID, nil, env.otherToken); own.Code != http.StatusOK {
		t.Fatalf("author delete: status %d", own.Code)
	}
}

func TestPhase6Routes_ExportCommentOnAMissingExportIsNotFound(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPost, "/api/export/no-such-id/comments",
		map[string]any{"content": map[string]any{"type": "doc"}}, env.token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status %d, want 404", rec.Code)
	}
}

// ----------------------------------------------------------------- user

func TestPhase6Routes_UserDetailsNeverIncludesAPasswordField(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodGet, "/api/user/details", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), "password") {
		t.Fatalf("password field present in response: %s", rec.Body.String())
	}

	var got struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	}
	decodeBody(t, rec, &got)
	if got.ID != env.userID || got.Email != "ada@example.com" {
		t.Fatalf("got %+v", got)
	}
}

func TestPhase6Routes_UserDetailsByIDIsSelfOrAdminOnly(t *testing.T) {
	env := newPhase6Env(t)

	// env.userID is the instance's first account, which auth.Service.Register
	// auto-promotes to admin -- so the "not an admin" half of this test has
	// to strip that role first, or it proves nothing.
	if err := env.db.Model(&models.User{}).Where("id = ?", env.userID).Update("role", "user").Error; err != nil {
		t.Fatalf("demote: %v", err)
	}

	if own := env.do(t, http.MethodGet, "/api/user/details/"+env.userID, nil, env.token); own.Code != http.StatusOK {
		t.Fatalf("own details: status %d", own.Code)
	}
	if foreign := env.do(t, http.MethodGet, "/api/user/details/"+env.otherUserID, nil, env.token); foreign.Code != http.StatusForbidden {
		t.Fatalf("another user's details: status %d, want 403", foreign.Code)
	}

	// No HTTP path creates an admin, so the role is set the way a seed
	// script would -- same approach mcp_routes_test.go's promoteToAdmin takes.
	if err := env.db.Model(&models.User{}).Where("id = ?", env.userID).Update("role", "admin").Error; err != nil {
		t.Fatalf("promote: %v", err)
	}
	if asAdmin := env.do(t, http.MethodGet, "/api/user/details/"+env.otherUserID, nil, env.token); asAdmin.Code != http.StatusOK {
		t.Fatalf("admin reading another user: status %d", asAdmin.Code)
	}
}

func TestPhase6Routes_UserDetailsUpdateChangesNameAndImage(t *testing.T) {
	env := newPhase6Env(t)

	putRec := env.do(t, http.MethodPut, "/api/user/details",
		map[string]any{"name": "Ada, Countess of Lovelace", "image": "https://example.com/avatar.png"}, env.token)
	if putRec.Code != http.StatusOK {
		t.Fatalf("put: status %d, body %s", putRec.Code, putRec.Body.String())
	}

	var got struct {
		Name  string `json:"name"`
		Image string `json:"image"`
	}
	decodeBody(t, putRec, &got)
	if got.Name != "Ada, Countess of Lovelace" || got.Image != "https://example.com/avatar.png" {
		t.Fatalf("got %+v", got)
	}

	getRec := env.do(t, http.MethodGet, "/api/user/details", nil, env.token)
	decodeBody(t, getRec, &got)
	if got.Name != "Ada, Countess of Lovelace" {
		t.Fatalf("update did not persist: %+v", got)
	}
}

func TestPhase6Routes_UserDetailsUpdateRejectsAnEmptyName(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPut, "/api/user/details", map[string]any{"name": "   "}, env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400, body %s", rec.Code, rec.Body.String())
	}
}

func TestPhase6Routes_UserDetailsUpdateRejectsANonHTTPImage(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPut, "/api/user/details",
		map[string]any{"image": "javascript:alert(1)"}, env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400, body %s", rec.Code, rec.Body.String())
	}
}

func TestPhase6Routes_UserDetailsUpdateRejectsADuplicateEmail(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPut, "/api/user/details",
		map[string]any{"email": "grace@example.com"}, env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400, body %s", rec.Code, rec.Body.String())
	}
}

func TestPhase6Routes_UserDetailsUpdateAllowsAnUnusedEmail(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPut, "/api/user/details",
		map[string]any{"email": "ada.new@example.com"}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Email string `json:"email"`
	}
	decodeBody(t, rec, &got)
	if got.Email != "ada.new@example.com" {
		t.Fatalf("got %+v", got)
	}
}

func TestPhase6Routes_UserDetailsUpdateBlocksEmailChangeForTheDesktopDefaultUser(t *testing.T) {
	env := newPhase6Env(t)

	_, session, err := env.authService.EnsureDesktopDefaultUser(context.Background())
	if err != nil {
		t.Fatalf("EnsureDesktopDefaultUser: %v", err)
	}

	rec := env.do(t, http.MethodPut, "/api/user/details",
		map[string]any{"email": "someone-else@example.com"}, session.Token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400, body %s", rec.Code, rec.Body.String())
	}

	// A same-account no-op (case/whitespace differences included) must
	// still be accepted -- only an actual change is blocked.
	stillOK := env.do(t, http.MethodPut, "/api/user/details",
		map[string]any{"email": "  " + auth.DesktopDefaultUserEmail + "  ", "name": "Local User"}, session.Token)
	if stillOK.Code != http.StatusOK {
		t.Fatalf("no-op email: status %d, body %s", stillOK.Code, stillOK.Body.String())
	}
}

func TestPhase6Routes_UserPasswordChangeRequiresCurrentPassword(t *testing.T) {
	env := newPhase6Env(t)

	wrongRec := env.do(t, http.MethodPut, "/api/user/password",
		map[string]any{"currentPassword": "wrong", "newPassword": "newpassword1"}, env.token)
	if wrongRec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong current password: status %d, want 401, body %s", wrongRec.Code, wrongRec.Body.String())
	}

	missingRec := env.do(t, http.MethodPut, "/api/user/password",
		map[string]any{"newPassword": "newpassword1"}, env.token)
	if missingRec.Code != http.StatusBadRequest {
		t.Fatalf("missing current password: status %d, want 400, body %s", missingRec.Code, missingRec.Body.String())
	}

	rec := env.do(t, http.MethodPut, "/api/user/password",
		map[string]any{"currentPassword": "hunter2", "newPassword": "newpassword1"}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}

	loginRec := env.do(t, http.MethodPost, "/api/auth/login",
		map[string]string{"email": "ada@example.com", "password": "newpassword1"}, "")
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login with new password: status %d, body %s", loginRec.Code, loginRec.Body.String())
	}
}

func TestPhase6Routes_UserPasswordChangeRejectsATooShortPassword(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPut, "/api/user/password",
		map[string]any{"currentPassword": "hunter2", "newPassword": "short"}, env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400, body %s", rec.Code, rec.Body.String())
	}
}

func TestPhase6Routes_UserPasswordSetWithoutCurrentForTheDesktopDefaultUser(t *testing.T) {
	env := newPhase6Env(t)

	user, session, err := env.authService.EnsureDesktopDefaultUser(context.Background())
	if err != nil {
		t.Fatalf("EnsureDesktopDefaultUser: %v", err)
	}

	rec := env.do(t, http.MethodPut, "/api/user/password",
		map[string]any{"newPassword": "brandnewpass1"}, session.Token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}

	loginRec := env.do(t, http.MethodPost, "/api/auth/login",
		map[string]string{"email": user.Email, "password": "brandnewpass1"}, "")
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login with newly set password: status %d, body %s", loginRec.Code, loginRec.Body.String())
	}
}

func TestPhase6Routes_UserAuthMethodsReportsHasPassword(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodGet, "/api/user/auth-methods", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body.String())
	}
	var got struct {
		HasPassword    bool     `json:"hasPassword"`
		OAuthProviders []string `json:"oauthProviders"`
	}
	decodeBody(t, rec, &got)
	if !got.HasPassword {
		t.Fatalf("got %+v, want hasPassword=true (registered with a password)", got)
	}

	_, session, err := env.authService.EnsureDesktopDefaultUser(context.Background())
	if err != nil {
		t.Fatalf("EnsureDesktopDefaultUser: %v", err)
	}
	desktopRec := env.do(t, http.MethodGet, "/api/user/auth-methods", nil, session.Token)
	decodeBody(t, desktopRec, &got)
	if got.HasPassword {
		t.Fatalf("desktop default user should have no password yet, got %+v", got)
	}
}

func TestPhase6Routes_UserPreferencesRoundTrip(t *testing.T) {
	env := newPhase6Env(t)

	emptyRec := env.do(t, http.MethodGet, "/api/user/preferences", nil, env.token)
	if emptyRec.Code != http.StatusOK || strings.TrimSpace(emptyRec.Body.String()) != "{}" {
		t.Fatalf("unset preferences = %q, want {}", emptyRec.Body.String())
	}

	putRec := env.do(t, http.MethodPut, "/api/user/preferences",
		map[string]any{"displayName": "Ada L.", "botName": "Engine"}, env.token)
	if putRec.Code != http.StatusOK {
		t.Fatalf("put: status %d, body %s", putRec.Code, putRec.Body.String())
	}

	getRec := env.do(t, http.MethodGet, "/api/user/preferences", nil, env.token)
	var prefs struct {
		DisplayName string `json:"displayName"`
		BotName     string `json:"botName"`
	}
	decodeBody(t, getRec, &prefs)
	if prefs.DisplayName != "Ada L." || prefs.BotName != "Engine" {
		t.Fatalf("got %+v", prefs)
	}
}

// -------------------------------------------------------------- storage

func TestPhase6Routes_StorageUploadThenServeRoundTrip(t *testing.T) {
	env := newPhase6Env(t)

	uploadRec := env.upload(t, "notes.csv", "text/csv", "a,b\n1,2\n", env.token)
	if uploadRec.Code != http.StatusOK {
		t.Fatalf("upload: status %d, body %s", uploadRec.Code, uploadRec.Body.String())
	}
	var uploaded struct {
		Key      string `json:"key"`
		URL      string `json:"url"`
		Metadata struct {
			ContentType string `json:"contentType"`
			Size        int64  `json:"size"`
		} `json:"metadata"`
	}
	decodeBody(t, uploadRec, &uploaded)
	if uploaded.Key == "" || uploaded.URL == "" {
		t.Fatalf("upload response = %+v", uploaded)
	}
	if uploaded.Metadata.ContentType != "text/csv" || uploaded.Metadata.Size == 0 {
		t.Fatalf("metadata = %+v", uploaded.Metadata)
	}

	// The source URL must be fetchable with no shared-secret header, since
	// a webview <img>/<a> can't send one.
	req := httptest.NewRequest(http.MethodGet, uploaded.URL, nil)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("serve: status %d, body %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "a,b\n1,2\n" {
		t.Fatalf("served body = %q", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/csv" {
		t.Fatalf("served content type = %q", ct)
	}
}

func TestPhase6Routes_StorageServeRejectsAForgedToken(t *testing.T) {
	env := newPhase6Env(t)

	req := httptest.NewRequest(http.MethodGet, "/storage/bm90LWEtcmVhbC10b2tlbg.forged", nil)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

// An upload slot must not double as a read grant: the two operations are
// signed distinctly for exactly this reason.
func TestPhase6Routes_StorageServeRejectsAnUploadToken(t *testing.T) {
	env := newPhase6Env(t)

	uploadURL, err := env.store.PresignUploadURL(context.Background(), "uploads/x.txt", time.Minute)
	if err != nil {
		t.Fatalf("PresignUploadURL: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, uploadURL, nil)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

func TestPhase6Routes_StorageUploadURLThenDirectPut(t *testing.T) {
	env := newPhase6Env(t)

	slotRec := env.do(t, http.MethodPost, "/api/storage/upload-url",
		map[string]any{"filename": "photo.png", "contentType": "image/png"}, env.token)
	if slotRec.Code != http.StatusOK {
		t.Fatalf("upload-url: status %d, body %s", slotRec.Code, slotRec.Body.String())
	}
	var slot struct {
		DirectUploadSupported bool   `json:"directUploadSupported"`
		Key                   string `json:"key"`
		URL                   string `json:"url"`
		Method                string `json:"method"`
		SourceURL             string `json:"sourceUrl"`
	}
	decodeBody(t, slotRec, &slot)
	if !slot.DirectUploadSupported || slot.Method != "PUT" || slot.URL == "" || slot.SourceURL == "" {
		t.Fatalf("slot = %+v", slot)
	}

	putReq := httptest.NewRequest(http.MethodPut, slot.URL, strings.NewReader("PNGDATA"))
	putRec := httptest.NewRecorder()
	env.handler.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("direct PUT: status %d, body %s", putRec.Code, putRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, slot.SourceURL, nil)
	getRec := httptest.NewRecorder()
	env.handler.ServeHTTP(getRec, getReq)
	if getRec.Body.String() != "PNGDATA" {
		t.Fatalf("served body = %q", getRec.Body.String())
	}
}

func TestPhase6Routes_StorageIngestPreviewsAnUploadedCSV(t *testing.T) {
	env := newPhase6Env(t)
	uploadRec := env.upload(t, "data.csv", "text/csv", "name,score\nada,10\ngrace,20\n", env.token)
	var uploaded struct {
		Key string `json:"key"`
		URL string `json:"url"`
	}
	decodeBody(t, uploadRec, &uploaded)

	for _, body := range []map[string]any{
		{"key": uploaded.Key},
		// The URL form has to resolve back through the signed token.
		{"url": uploaded.URL},
	} {
		rec := env.do(t, http.MethodPost, "/api/storage/ingest", body, env.token)
		if rec.Code != http.StatusOK {
			t.Fatalf("ingest %v: status %d, body %s", body, rec.Code, rec.Body.String())
		}
		var got struct {
			OK      bool   `json:"ok"`
			Key     string `json:"key"`
			Text    string `json:"text"`
			Preview struct {
				Header    []string `json:"header"`
				TotalRows int      `json:"totalRows"`
			} `json:"preview"`
		}
		decodeBody(t, rec, &got)
		if !got.OK || got.Key != uploaded.Key {
			t.Fatalf("ingest %v: got %+v", body, got)
		}
		if len(got.Preview.Header) != 2 || got.Preview.TotalRows != 3 {
			t.Fatalf("ingest %v: preview = %+v", body, got.Preview)
		}
		if !strings.Contains(got.Text, "| name | score |") {
			t.Fatalf("ingest %v: text = %q", body, got.Text)
		}
	}
}

func TestPhase6Routes_StorageIngestRejectsANonCSVFile(t *testing.T) {
	env := newPhase6Env(t)
	uploadRec := env.upload(t, "photo.png", "image/png", "PNG", env.token)
	var uploaded struct {
		Key string `json:"key"`
	}
	decodeBody(t, uploadRec, &uploaded)

	rec := env.do(t, http.MethodPost, "/api/storage/ingest", map[string]any{"key": uploaded.Key}, env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Unsupported file type") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPhase6Routes_StorageIngestRequiresAKeyOrURL(t *testing.T) {
	env := newPhase6Env(t)

	rec := env.do(t, http.MethodPost, "/api/storage/ingest", map[string]any{}, env.token)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}

// Unlike the TS route, ingest is session-gated here -- otherwise any
// caller could read any storage key it can name.
func TestPhase6Routes_StorageWriteRoutesRequireASession(t *testing.T) {
	env := newPhase6Env(t)

	for _, path := range []string{"/api/storage/upload-url", "/api/storage/ingest"} {
		rec := env.do(t, http.MethodPost, path, map[string]any{"key": "uploads/x.csv"}, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status %d, want 401", path, rec.Code)
		}
	}
}

func (e phase6Env) upload(t *testing.T, filename, contentType, content, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(map[string][]string)
	header["Content-Disposition"] = []string{`form-data; name="file"; filename="` + filename + `"`}
	header["Content-Type"] = []string{contentType}
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("CreatePart: %v", err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/storage/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set(middleware.AuthHeader, "test-token")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}
