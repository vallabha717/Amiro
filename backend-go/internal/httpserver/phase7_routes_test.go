package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	aiapi "betterchatbot/backend/internal/api/ai"
	chatapi "betterchatbot/backend/internal/api/chat"
	threadapi "betterchatbot/backend/internal/api/thread"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/models"
	"betterchatbot/backend/internal/db/repository"
	"betterchatbot/backend/internal/middleware"
	"betterchatbot/backend/internal/secrets"

	"gorm.io/gorm"
)

// fakeGenerateObjectEngine is a canned aiapi.Engine/chatapi.Engine, letting
// these tests exercise real routing/auth/persistence without a real
// Bifrost client -- same substitution pattern as chat_routes_test.go's
// fakeEngine.
type fakeGenerateObjectEngine struct {
	object json.RawMessage
	err    error
}

func (f fakeGenerateObjectEngine) Stream(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	panic("not used by phase7 tests")
}

func (f fakeGenerateObjectEngine) StreamStep(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message, []bifrostai.ToolSpec, func(string)) (*bifrostai.StepResult, error) {
	panic("not used by phase7 tests")
}

func (f fakeGenerateObjectEngine) GenerateObject(context.Context, bifrostai.ResolvedModel, string, []bifrostai.Message, json.RawMessage) (json.RawMessage, *bifrostai.Usage, error) {
	return f.object, nil, f.err
}

type phase7TestEnv struct {
	handler  http.Handler
	db       *gorm.DB
	chatRepo *repository.ChatRepository
	token    string
	userID   string
}

func newPhase7TestEnv(t *testing.T, engine interface {
	chatapi.Engine
	aiapi.Engine
}) phase7TestEnv {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	chatRepo := repository.NewChatRepository(gdb)
	exportRepo := repository.NewChatExportRepository(gdb, chatRepo)
	chatHandler := chatapi.NewHandler(chatRepo, exportRepo, engine, nil, secrets.NewEnvStore(), nil, nil, nil, nil, nil)
	threadHandler := threadapi.NewHandler(chatRepo)
	aiHandler := aiapi.NewHandler(engine)
	handler := New(testConfig(), Handlers{Auth: authService, Chat: chatHandler, Thread: threadHandler, AI: aiHandler})

	env := phase7TestEnv{handler: handler, db: gdb, chatRepo: chatRepo}

	registerRec := env.do(t, http.MethodPost, "/api/auth/register", map[string]string{"name": "Ada", "email": "ada@example.com", "password": "hunter2"}, "")
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, body = %s", registerRec.Code, registerRec.Body.String())
	}
	var registerResp struct {
		User  struct{ ID string } `json:"user"`
		Token string              `json:"token"`
	}
	if err := json.Unmarshal(registerRec.Body.Bytes(), &registerResp); err != nil {
		t.Fatalf("unmarshal register response: %v", err)
	}
	env.token = registerResp.Token
	env.userID = registerResp.User.ID
	return env
}

func (e phase7TestEnv) do(t *testing.T, method, path string, body any, bearer string) *httptest.ResponseRecorder {
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

// registerOtherUser creates a second real user row (chat_thread.user_id has
// a foreign key to user.id, so "someone-else" as a bare literal fails at
// the DB layer -- these tests need an actual second account).
func (e phase7TestEnv) registerOtherUser(t *testing.T) string {
	t.Helper()
	rec := e.do(t, http.MethodPost, "/api/auth/register", map[string]string{"name": "Bea", "email": "bea@example.com", "password": "hunter2"}, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("register other user: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		User struct{ ID string } `json:"user"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return resp.User.ID
}

func TestRouter_ThreadGetReturnsThreadWithMessages(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	ctx := context.Background()
	if err := env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "Hello", UserID: env.userID}); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}
	if err := env.chatRepo.UpsertMessage(ctx, &models.ChatMessage{ID: "m1", ThreadID: "t1", Role: "user", Parts: []byte(`[{"type":"text","text":"hi"}]`)}); err != nil {
		t.Fatalf("UpsertMessage: %v", err)
	}

	rec := env.do(t, http.MethodGet, "/api/thread/t1", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		ID       string `json:"id"`
		Title    string `json:"title"`
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Title != "Hello" || len(resp.Messages) != 1 || resp.Messages[0].ID != "m1" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestRouter_ThreadGetReturns404ForAnotherUsersThread(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	otherUserID := env.registerOtherUser(t)
	if err := env.chatRepo.InsertThread(context.Background(), &models.ChatThread{ID: "t1", Title: "Hello", UserID: otherUserID}); err != nil {
		t.Fatalf("InsertThread: %v", err)
	}
	rec := env.do(t, http.MethodGet, "/api/thread/t1", nil, env.token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404, body = %s", rec.Code, rec.Body.String())
	}
}

func TestRouter_ThreadUpdateRenamesOwnThreadOnly(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	otherUserID := env.registerOtherUser(t)
	ctx := context.Background()
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "mine", Title: "Old", UserID: env.userID})
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "theirs", Title: "Old", UserID: otherUserID})

	rec := env.do(t, http.MethodPut, "/api/thread/mine", map[string]string{"title": "New Title"}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	updated, err := env.chatRepo.SelectThread(ctx, "mine")
	if err != nil || updated.Title != "New Title" {
		t.Fatalf("thread not renamed: %+v, err=%v", updated, err)
	}

	rec = env.do(t, http.MethodPut, "/api/thread/theirs", map[string]string{"title": "Hijacked"}, env.token)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404, body = %s", rec.Code, rec.Body.String())
	}
	untouched, _ := env.chatRepo.SelectThread(ctx, "theirs")
	if untouched.Title != "Old" {
		t.Fatalf("cross-user rename leaked through: %+v", untouched)
	}
}

func TestRouter_ThreadDeleteRemovesThreadAndMessages(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	ctx := context.Background()
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "t1", Title: "Bye", UserID: env.userID})
	_ = env.chatRepo.UpsertMessage(ctx, &models.ChatMessage{ID: "m1", ThreadID: "t1", Role: "user", Parts: []byte(`[]`)})

	rec := env.do(t, http.MethodDelete, "/api/thread/t1", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	remaining, err := env.chatRepo.SelectThread(ctx, "t1")
	if err != nil || remaining != nil {
		t.Fatalf("thread still present: %+v", remaining)
	}
	msgs, _ := env.chatRepo.SelectMessagesByThreadID(ctx, "t1")
	if len(msgs) != 0 {
		t.Fatalf("messages not cascaded: %+v", msgs)
	}
}

func TestRouter_ThreadDeleteAllDeletesEveryThreadForTheUser(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	otherUserID := env.registerOtherUser(t)
	ctx := context.Background()
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "t1", UserID: env.userID})
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "t2", UserID: env.userID})
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "t3", UserID: otherUserID})

	rec := env.do(t, http.MethodDelete, "/api/thread", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rows, err := env.chatRepo.SelectThreadsByUserID(ctx, env.userID)
	if err != nil || len(rows) != 0 {
		t.Fatalf("expected no threads left, got %+v", rows)
	}
	other, err := env.chatRepo.SelectThread(ctx, "t3")
	if err != nil || other == nil {
		t.Fatalf("another user's thread was deleted: %v, %v", other, err)
	}
}

func TestRouter_ThreadDeleteAllUnarchivedScopeKeepsArchivedThreads(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	ctx := context.Background()
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "archived", UserID: env.userID})
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "not-archived", UserID: env.userID})
	archiveRepo := repository.NewArchiveRepository(env.db)
	archive := &models.Archive{Name: "Keep", UserID: env.userID}
	if err := archiveRepo.Create(ctx, archive); err != nil {
		t.Fatalf("Create archive: %v", err)
	}
	if _, err := archiveRepo.AddItem(ctx, archive.ID, "archived", env.userID); err != nil {
		t.Fatalf("AddItem: %v", err)
	}

	rec := env.do(t, http.MethodDelete, "/api/thread?scope=unarchived", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	kept, err := env.chatRepo.SelectThread(ctx, "archived")
	if err != nil || kept == nil {
		t.Fatalf("archived thread was deleted: %v, err=%v", kept, err)
	}
	gone, err := env.chatRepo.SelectThread(ctx, "not-archived")
	if err != nil || gone != nil {
		t.Fatalf("unarchived thread survived: %+v", gone)
	}
}

func TestRouter_DeleteMessageRemovesIt(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	ctx := context.Background()
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "t1", UserID: env.userID})
	_ = env.chatRepo.UpsertMessage(ctx, &models.ChatMessage{ID: "m1", ThreadID: "t1", Role: "user", Parts: []byte(`[]`)})

	rec := env.do(t, http.MethodDelete, "/api/thread/messages/m1", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	msgs, _ := env.chatRepo.SelectMessagesByThreadID(ctx, "t1")
	if len(msgs) != 0 {
		t.Fatalf("message not deleted: %+v", msgs)
	}
}

func TestRouter_TruncateAfterDeletesTheMessageAndEverythingAfterIt(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	ctx := context.Background()
	_ = env.chatRepo.InsertThread(ctx, &models.ChatThread{ID: "t1", UserID: env.userID})
	_ = env.chatRepo.UpsertMessage(ctx, &models.ChatMessage{ID: "m1", ThreadID: "t1", Role: "user", Parts: []byte(`[]`)})

	rec := env.do(t, http.MethodPost, "/api/thread/messages/m1/truncate", nil, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	msgs, _ := env.chatRepo.SelectMessagesByThreadID(ctx, "t1")
	if len(msgs) != 0 {
		t.Fatalf("message not truncated: %+v", msgs)
	}
}

func TestRouter_ThreadRoutesRequireASession(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodGet, "/api/thread/t1"},
		{http.MethodPut, "/api/thread/t1"},
		{http.MethodDelete, "/api/thread/t1"},
		{http.MethodDelete, "/api/thread"},
		{http.MethodDelete, "/api/thread/messages/m1"},
		{http.MethodPost, "/api/thread/messages/m1/truncate"},
	} {
		rec := env.do(t, tc.method, tc.path, nil, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: status = %d, want 401", tc.method, tc.path, rec.Code)
		}
	}
}

func TestRouter_GenerateObjectReturnsTheEngineObject(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{object: json.RawMessage(`{"name":"Ada"}`)})
	rec := env.do(t, http.MethodPost, "/api/ai/generate-object", map[string]any{
		"prompt": map[string]string{"user": "make a person"},
		"schema": map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}}},
	}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != `{"name":"Ada"}` {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestRouter_GenerateObjectRequiresASession(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{})
	rec := env.do(t, http.MethodPost, "/api/ai/generate-object", map[string]any{"schema": map[string]any{"type": "object"}}, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRouter_GenerateExampleToolSchemaReturnsTheEngineObject(t *testing.T) {
	env := newPhase7TestEnv(t, fakeGenerateObjectEngine{object: json.RawMessage(`{"query":"weather in Paris"}`)})
	rec := env.do(t, http.MethodPost, "/api/ai/generate-example-tool-schema", map[string]any{
		"toolInfo": map[string]any{
			"name":        "search",
			"description": "search the web",
			"inputSchema": map[string]any{"properties": map[string]any{"query": map[string]any{"type": "string"}}},
		},
	}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != `{"query":"weather in Paris"}` {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
