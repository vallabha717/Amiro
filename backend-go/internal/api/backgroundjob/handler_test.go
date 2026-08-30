package backgroundjob_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"amiro/backend/internal/agent/background"
	"amiro/backend/internal/agent/workspace"
	bifrostai "amiro/backend/internal/ai/bifrost"
	backgroundjobapi "amiro/backend/internal/api/backgroundjob"
	chatapi "amiro/backend/internal/api/chat"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

// blockingEngine never returns, so a job Create starts stays "running" for
// as long as a test needs it to -- e.g. to exercise the concurrency cap,
// which only refuses a creation while jobs are genuinely still running.
type blockingEngine struct{}

func (blockingEngine) StreamStep(ctx context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, _ bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (blockingEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

// instantEngine finishes a turn immediately with no tool calls.
type instantEngine struct{}

func (instantEngine) StreamStep(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message, []bifrostai.ToolSpec, bifrostai.StepHooks) (*bifrostai.StepResult, error) {
	return &bifrostai.StepResult{Text: "done"}, nil
}
func (instantEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	ch := make(chan bifrostai.Chunk)
	close(ch)
	return ch, nil
}

type testEnv struct {
	handler *backgroundjobapi.Handler
	jobs    *repository.BackgroundJobRepository
	trust   *repository.WorkspaceTrustRepository
	users   *repository.UserRepository
	auth    *auth.Service
}

// newEnvWithUser wires a full backgroundjob.Handler against a real sqlite
// db (persistence, trust and the concurrency cap are all real queries) and
// registers one real user, since job rows are scoped by a real user_id.
func newEnvWithUser(t *testing.T, engine chatapi.Engine) (testEnv, *models.User) {
	t.Helper()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	authSvc := auth.NewService(gdb)
	user, err := authSvc.Register(context.Background(), "Ada", "ada@example.com", "hunter2hunter2")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	chatRepo := repository.NewChatRepository(gdb)
	jobs := repository.NewBackgroundJobRepository(gdb)
	trust := repository.NewWorkspaceTrustRepository(gdb)
	users := repository.NewUserRepository(gdb)
	chat := chatapi.NewHandler(chatRepo, nil, engine, nil, nil, nil, nil, nil, nil, nil).
		WithWorkspaceTrust(trust).
		WithBackgroundJobs(jobs)
	worker := background.New(chat, jobs, trust, users)
	// Registered after the db-close cleanup above, so t.Cleanup's LIFO
	// order runs this one first: every job's goroutine is canceled and
	// joined (bounded) before the database it writes to closes underneath
	// it, instead of racing a background write against Close().
	t.Cleanup(func() { worker.Shutdown(2 * time.Second) })
	h := backgroundjobapi.NewHandler(jobs, trust, chatRepo, worker, "")
	return testEnv{handler: h, jobs: jobs, trust: trust, users: users, auth: authSvc}, user
}

func mustResolve(t *testing.T, root string) string {
	t.Helper()
	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	return ws.Root()
}

func doCreate(t *testing.T, env testEnv, user *models.User, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/background-jobs", bytes.NewReader(b)).
		WithContext(auth.ContextWithUser(context.Background(), user))
	rec := httptest.NewRecorder()
	env.handler.Create(rec, req)
	return rec
}

func TestHandler_CreateRequiresPrompt(t *testing.T) {
	env, user := newEnvWithUser(t, instantEngine{})
	rec := doCreate(t, env, user, map[string]any{"prompt": "", "mode": "auto", "workspaceRoot": t.TempDir()})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandler_CreateRejectsPlanAndInteractiveModes(t *testing.T) {
	env, user := newEnvWithUser(t, instantEngine{})
	root := t.TempDir()
	if err := env.trust.Grant(context.Background(), user.ID, mustResolve(t, root), repository.GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	for _, mode := range []string{"plan", "interactive", "manual", ""} {
		rec := doCreate(t, env, user, map[string]any{"prompt": "do it", "mode": mode, "workspaceRoot": root})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("mode %q: status = %d, want 400", mode, rec.Code)
		}
	}
}

func TestHandler_CreateRefusesUntrustedRoot(t *testing.T) {
	env, user := newEnvWithUser(t, instantEngine{})
	rec := doCreate(t, env, user, map[string]any{"prompt": "do it", "mode": "auto", "workspaceRoot": t.TempDir()})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for an ungranted root", rec.Code)
	}
}

func TestHandler_CreateSucceedsForATrustedRootAndReturnsTheJob(t *testing.T) {
	env, user := newEnvWithUser(t, instantEngine{})
	root := t.TempDir()
	if err := env.trust.Grant(context.Background(), user.ID, mustResolve(t, root), repository.GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	rec := doCreate(t, env, user, map[string]any{"prompt": "do it", "mode": "auto", "workspaceRoot": root})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID == "" || resp.Status != models.BackgroundJobRunning {
		t.Fatalf("response = %+v", resp)
	}
}

func TestHandler_CreateRefusesBeyondConcurrencyCap(t *testing.T) {
	env, user := newEnvWithUser(t, blockingEngine{})
	root := t.TempDir()
	if err := env.trust.Grant(context.Background(), user.ID, mustResolve(t, root), repository.GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	for i := 0; i < background.MaxConcurrent; i++ {
		rec := doCreate(t, env, user, map[string]any{"prompt": "do it", "mode": "auto", "workspaceRoot": root})
		if rec.Code != http.StatusCreated {
			t.Fatalf("job %d: status = %d, want 201", i, rec.Code)
		}
	}
	// Give the goroutines a moment to actually reach "running" -- Create
	// itself sets the row running before starting the worker, so this is
	// mostly defensive.
	time.Sleep(20 * time.Millisecond)

	rec := doCreate(t, env, user, map[string]any{"prompt": "one too many", "mode": "auto", "workspaceRoot": root})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 beyond the concurrency cap, body: %s", rec.Code, rec.Body.String())
	}
}

func TestHandler_ListScopesToOwnerUnlessAdmin(t *testing.T) {
	// auth.Service.Register promotes the first-ever user to admin (see
	// internal/auth's own TestRegister_FirstUserBecomesAdmin) -- "admin" is
	// deliberately the first-registered user here, "member" the second, so
	// each assertion below exercises the role it names.
	env, admin := newEnvWithUser(t, instantEngine{})
	member, err := env.auth.Register(context.Background(), "Bob", "bob@example.com", "hunter2hunter2")
	if err != nil {
		t.Fatalf("register second user: %v", err)
	}
	if admin.Role != "admin" || member.Role == "admin" {
		t.Fatalf("role setup: admin.Role=%q member.Role=%q, want admin/non-admin", admin.Role, member.Role)
	}

	adminRoot, memberRoot := t.TempDir(), t.TempDir()
	if err := env.trust.Grant(context.Background(), admin.ID, mustResolve(t, adminRoot), repository.GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if err := env.trust.Grant(context.Background(), member.ID, mustResolve(t, memberRoot), repository.GrantedViaPrompt); err != nil {
		t.Fatalf("Grant: %v", err)
	}
	if rec := doCreate(t, env, admin, map[string]any{"prompt": "admin's job", "mode": "auto", "workspaceRoot": adminRoot}); rec.Code != http.StatusCreated {
		t.Fatalf("create: status = %d", rec.Code)
	}
	if rec := doCreate(t, env, member, map[string]any{"prompt": "member's job", "mode": "auto", "workspaceRoot": memberRoot}); rec.Code != http.StatusCreated {
		t.Fatalf("create: status = %d", rec.Code)
	}

	listAs := func(u *models.User) []map[string]any {
		req := httptest.NewRequest(http.MethodGet, "/api/background-jobs", nil).
			WithContext(auth.ContextWithUser(context.Background(), u))
		rec := httptest.NewRecorder()
		env.handler.List(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		var resp struct {
			Jobs []map[string]any `json:"jobs"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return resp.Jobs
	}

	if got := listAs(member); len(got) != 1 {
		t.Fatalf("member's Jobs = %+v, want exactly their own one job", got)
	}
	if got := listAs(admin); len(got) != 2 {
		t.Fatalf("admin's Jobs = %+v, want both users' jobs", got)
	}
}
