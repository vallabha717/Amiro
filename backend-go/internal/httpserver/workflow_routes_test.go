package httpserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
	workflowapi "amiro/backend/internal/api/workflow"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/repository"
	"amiro/backend/internal/middleware"
)

// fakeWorkflowEngine is a canned executor.Engine -- same rationale as
// chat_routes_test.go's fakeEngine / mcp_routes_test.go's fakeMCPEngine:
// real routing/auth/persistence/graph-execution coverage without a real
// Bifrost client or real provider keys.
type fakeWorkflowEngine struct{}

func (fakeWorkflowEngine) Generate(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message) (*bifrostai.GenerateResult, error) {
	return &bifrostai.GenerateResult{Text: "fake reply"}, nil
}
func (fakeWorkflowEngine) GenerateObject(ctx context.Context, resolved bifrostai.ResolvedModel, system string, messages []bifrostai.Message, schema json.RawMessage) (json.RawMessage, *bifrostai.Usage, error) {
	return json.RawMessage(`{}`), nil, nil
}
func (fakeWorkflowEngine) GenerateWithTool(ctx context.Context, resolved bifrostai.ResolvedModel, prompt, toolName, toolDescription string, paramSchema json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}

type fakeWorkflowMCP struct{}

func (fakeWorkflowMCP) CallTool(ctx context.Context, id, toolName string, args json.RawMessage) bifrostai.MCPToolCallResult {
	return bifrostai.MCPToolCallResult{Content: "ok"}
}

type workflowTestEnv struct {
	handler http.Handler
	token   string
	userID  string
}

func newWorkflowTestEnv(t *testing.T) workflowTestEnv {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	workflowRepo := repository.NewWorkflowRepository(gdb)
	workflowHandler := workflowapi.NewHandler(workflowRepo, fakeWorkflowEngine{}, fakeWorkflowMCP{})
	handler := New(testConfig(), Handlers{Auth: authService, Workflow: workflowHandler})

	env := workflowTestEnv{handler: handler}
	registerRec := env.do(t, http.MethodPost, "/api/auth/register", map[string]string{"name": "Ada", "email": "ada@example.com", "password": "hunter2"}, "")
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", registerRec.Code, registerRec.Body.String())
	}
	var registerResp struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.Unmarshal(registerRec.Body.Bytes(), &registerResp)

	loginRec := env.do(t, http.MethodPost, "/api/auth/login", map[string]string{"email": "ada@example.com", "password": "hunter2"}, "")
	var loginResp struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &loginResp)

	env.token = loginResp.Token
	env.userID = registerResp.User.ID
	return env
}

func (e workflowTestEnv) do(t *testing.T, method, path string, body any, bearer string) *httptest.ResponseRecorder {
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

func (e workflowTestEnv) registerAndLogin(t *testing.T, email string) string {
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

func TestRouter_WorkflowSaveCreatesWorkflowWithDefaultInputNode(t *testing.T) {
	env := newWorkflowTestEnv(t)
	rec := env.do(t, http.MethodPost, "/api/workflow", map[string]any{"name": "My Flow"}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var wf struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &wf); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if wf.ID == "" || wf.Name != "My Flow" {
		t.Fatalf("wf = %+v", wf)
	}

	structRec := env.do(t, http.MethodGet, "/api/workflow/"+wf.ID+"/structure", nil, env.token)
	var structure struct {
		Nodes []struct {
			Kind string `json:"kind"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(structRec.Body.Bytes(), &structure); err != nil {
		t.Fatalf("unmarshal structure: %v", err)
	}
	if len(structure.Nodes) != 1 || structure.Nodes[0].Kind != "input" {
		t.Fatalf("expected a seeded Input node, got %+v", structure.Nodes)
	}
}

func TestRouter_WorkflowRoutesRequireASessionBearerToken(t *testing.T) {
	env := newWorkflowTestEnv(t)
	rec := env.do(t, http.MethodGet, "/api/workflow", nil, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRouter_WorkflowGetRejectsNonOwnerOnPrivate(t *testing.T) {
	env := newWorkflowTestEnv(t)
	saveRec := env.do(t, http.MethodPost, "/api/workflow", map[string]any{"name": "Private Flow"}, env.token)
	var wf struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &wf)

	bobToken := env.registerAndLogin(t, "bob@example.com")
	rec := env.do(t, http.MethodGet, "/api/workflow/"+wf.ID, nil, bobToken)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
}

func TestRouter_WorkflowDeleteRejectsNonOwnerAndSucceedsForOwner(t *testing.T) {
	env := newWorkflowTestEnv(t)
	saveRec := env.do(t, http.MethodPost, "/api/workflow", map[string]any{"name": "wf"}, env.token)
	var wf struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &wf)

	bobToken := env.registerAndLogin(t, "bob@example.com")
	rec := env.do(t, http.MethodDelete, "/api/workflow/"+wf.ID, nil, bobToken)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("non-owner delete status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	rec = env.do(t, http.MethodDelete, "/api/workflow/"+wf.ID, nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner delete status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// CheckAccess itself returns false for a nonexistent workflow (its
	// underlying SELECT finds no row), so Get 401s before ever reaching its
	// own "not found" branch -- matching workflow/[id]/route.ts's GET
	// exactly: checkAccess(id, userId) is always called first there too, and
	// TS's checkAccess also returns false when `!workflow`.
	getRec := env.do(t, http.MethodGet, "/api/workflow/"+wf.ID, nil, env.token)
	if getRec.Code != http.StatusUnauthorized {
		t.Fatalf("status after delete = %d, want %d", getRec.Code, http.StatusUnauthorized)
	}
}

func TestRouter_WorkflowUpdateVisibilityAndPublish(t *testing.T) {
	env := newWorkflowTestEnv(t)
	saveRec := env.do(t, http.MethodPost, "/api/workflow", map[string]any{"name": "wf"}, env.token)
	var wf struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &wf)

	rec := env.do(t, http.MethodPut, "/api/workflow/"+wf.ID, map[string]any{"visibility": "public", "isPublished": true}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var updated struct {
		Visibility  string `json:"visibility"`
		IsPublished bool   `json:"isPublished"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if updated.Visibility != "public" || !updated.IsPublished {
		t.Fatalf("updated = %+v", updated)
	}

	// Now visible to a stranger via SelectExecuteAbility.
	bobToken := env.registerAndLogin(t, "bob@example.com")
	execRec := env.do(t, http.MethodGet, "/api/workflow/tools", nil, bobToken)
	var summaries []struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(execRec.Body.Bytes(), &summaries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	found := false
	for _, s := range summaries {
		if s.ID == wf.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the published public workflow in Bob's execute-ability list, got %+v", summaries)
	}
}

// TestRouter_WorkflowExecute_StreamsToWorkflowEnd builds a minimal
// Input->Output structure via the structure API, then runs it through
// Execute and verifies the WF_EVENT wire framing (shared.workflow.ts's
// WORKFLOW_STREAM_PREFIX) ends in a successful WORKFLOW_END.
func TestRouter_WorkflowExecute_StreamsToWorkflowEnd(t *testing.T) {
	env := newWorkflowTestEnv(t)
	saveRec := env.do(t, http.MethodPost, "/api/workflow", map[string]any{"name": "wf"}, env.token)
	var wf struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &wf)

	structRec := env.do(t, http.MethodGet, "/api/workflow/"+wf.ID+"/structure", nil, env.token)
	var structure struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
	}
	_ = json.Unmarshal(structRec.Body.Bytes(), &structure)
	inputID := structure.Nodes[0].ID

	outputNode := map[string]any{
		"id": "out-1", "kind": "output", "name": "OUT",
		"nodeConfig": map[string]any{"outputData": []any{}},
		"uiConfig":   map[string]any{"position": map[string]any{"x": 0, "y": 0}, "type": "default"},
	}
	edge := map[string]any{"id": "e-1", "source": inputID, "target": "out-1", "uiConfig": map[string]any{}}
	saveStructRec := env.do(t, http.MethodPost, "/api/workflow/"+wf.ID+"/structure", map[string]any{
		"nodes": []any{outputNode}, "edges": []any{edge},
	}, env.token)
	if saveStructRec.Code != http.StatusOK {
		t.Fatalf("save structure status = %d, body = %s", saveStructRec.Code, saveStructRec.Body.String())
	}

	req := httptest.NewRequest(http.MethodPost, "/api/workflow/"+wf.ID+"/execute", bytes.NewReader([]byte(`{"query":{}}`)))
	req.Header.Set(middleware.AuthHeader, "test-token")
	req.Header.Set("Authorization", "Bearer "+env.token)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("execute status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var lastEventType string
	var isOk *bool
	scanner := bufio.NewScanner(strings.NewReader(rec.Body.String()))
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "WF_EVENT:") {
			continue
		}
		var ev struct {
			EventType string `json:"eventType"`
			IsOk      *bool  `json:"isOk"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "WF_EVENT:")), &ev); err != nil {
			t.Fatalf("unmarshal event line %q: %v", line, err)
		}
		lastEventType = ev.EventType
		if ev.EventType == "WORKFLOW_END" {
			isOk = ev.IsOk
		}
	}
	if lastEventType != "WORKFLOW_END" {
		t.Fatalf("expected the stream to end with WORKFLOW_END, last event was %q; body=%s", lastEventType, rec.Body.String())
	}
	if isOk == nil || !*isOk {
		t.Fatalf("expected a successful WORKFLOW_END, isOk=%v; body=%s", isOk, rec.Body.String())
	}
}

func TestRouter_WorkflowExecuteRejectsNonOwnerOnPrivate(t *testing.T) {
	env := newWorkflowTestEnv(t)
	saveRec := env.do(t, http.MethodPost, "/api/workflow", map[string]any{"name": "wf"}, env.token)
	var wf struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(saveRec.Body.Bytes(), &wf)

	bobToken := env.registerAndLogin(t, "bob@example.com")
	req := httptest.NewRequest(http.MethodPost, "/api/workflow/"+wf.ID+"/execute", bytes.NewReader([]byte(`{"query":{}}`)))
	req.Header.Set(middleware.AuthHeader, "test-token")
	req.Header.Set("Authorization", "Bearer "+bobToken)
	rec := httptest.NewRecorder()
	env.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}
