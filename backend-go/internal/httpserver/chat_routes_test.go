package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	bifrostai "betterchatbot/backend/internal/ai/bifrost"
	chatapi "betterchatbot/backend/internal/api/chat"
	"betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db"
	"betterchatbot/backend/internal/db/repository"
	"betterchatbot/backend/internal/middleware"
	"betterchatbot/backend/internal/secrets"
)

// fakeEngine is a canned chatapi.Engine, so these tests exercise real
// routing/auth/persistence without a real Bifrost client or provider keys
// -- the same substitution chatapi.Engine's doc comment exists for.
type fakeEngine struct {
	deltas    []string
	usage     *bifrostai.Usage
	err       error // mid-stream error: a Chunk carrying Err after some deltas already flowed
	streamErr error // Stream() itself fails outright, before any chunk -- e.g. a missing provider key
}

func (f fakeEngine) Stream(_ context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message) (<-chan bifrostai.Chunk, error) {
	if f.streamErr != nil {
		return nil, f.streamErr
	}
	ch := make(chan bifrostai.Chunk, len(f.deltas)+2)
	for _, d := range f.deltas {
		ch <- bifrostai.Chunk{TextDelta: d}
	}
	if f.usage != nil {
		ch <- bifrostai.Chunk{Usage: f.usage}
	}
	if f.err != nil {
		ch <- bifrostai.Chunk{Err: f.err}
	}
	close(ch)
	return ch, nil
}

// StreamStep backs chatapi's tool-calling loop (Chat, not title/temporary,
// which still use Stream above). It has no tool calls to report -- each of
// f.deltas is delivered to onTextDelta individually (same real-streaming
// contract StreamStep's real implementation has), so tests asserting on
// delta content still see the same words, just via the callback instead of
// a channel.
func (f fakeEngine) StreamStep(_ context.Context, _ bifrostai.ResolvedModel, _ string, _ []bifrostai.Message, _ []bifrostai.ToolSpec, onTextDelta func(string)) (*bifrostai.StepResult, error) {
	if f.err != nil {
		return nil, f.err
	}
	text := ""
	for _, d := range f.deltas {
		if onTextDelta != nil {
			onTextDelta(d)
		}
		text += d
	}
	return &bifrostai.StepResult{Text: text, Usage: f.usage}, nil
}

type chatTestEnv struct {
	handler  http.Handler
	chatRepo *repository.ChatRepository
	token    string // bearer session token for a registered test user
}

func newChatTestEnv(t *testing.T, engine chatapi.Engine) chatTestEnv {
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
	handler := New(testConfig(), Handlers{Auth: authService, Chat: chatHandler})

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
	loginRec := do(http.MethodPost, "/api/auth/login", map[string]string{"email": "ada@example.com", "password": "hunter2"})
	var loginResp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(loginRec.Body.Bytes(), &loginResp); err != nil {
		t.Fatalf("unmarshal login response: %v", err)
	}

	return chatTestEnv{handler: handler, chatRepo: chatRepo, token: loginResp.Token}
}

func (e chatTestEnv) do(t *testing.T, method, path string, body any, bearer string) *httptest.ResponseRecorder {
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

func TestRouter_ChatModelsIsReachableWithoutASession(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{})
	rec := env.do(t, http.MethodGet, "/api/chat/models", nil, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var info []bifrostai.ProviderModelsInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(info) == 0 {
		t.Fatal("expected at least one provider")
	}
}

func TestRouter_ChatRequiresASessionBearerToken(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{})
	rec := env.do(t, http.MethodPost, "/api/chat", map[string]any{
		"id":      "thread-1",
		"message": map[string]any{"id": "msg-1", "role": "user", "parts": []map[string]any{{"type": "text", "text": "hi"}}},
	}, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRouter_ChatStreamsReplyAndPersistsBothMessages(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{deltas: []string{"Hello", " world"}, usage: &bifrostai.Usage{TotalTokens: 7}})

	rec := env.do(t, http.MethodPost, "/api/chat", map[string]any{
		"id":         "thread-1",
		"message":    map[string]any{"id": "msg-1", "role": "user", "parts": []map[string]any{{"type": "text", "text": "hi"}}},
		"toolChoice": "auto",
	}, env.token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"delta":"Hello"`) || !strings.Contains(body, `"delta":" world"`) {
		t.Fatalf("body missing expected text deltas: %s", body)
	}
	if !strings.Contains(body, "data: [DONE]") {
		t.Fatalf("body missing terminal [DONE] frame: %s", body)
	}

	messages, err := env.chatRepo.SelectMessagesByThreadID(context.Background(), "thread-1")
	if err != nil {
		t.Fatalf("SelectMessagesByThreadID: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("got %d persisted messages, want 2 (user + assistant): %+v", len(messages), messages)
	}
	roles := map[string]bool{messages[0].Role: true, messages[1].Role: true}
	if !roles["user"] || !roles["assistant"] {
		t.Fatalf("got roles %v, want user and assistant", roles)
	}
}

func TestRouter_ChatForbidsAccessToAnotherUsersThread(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{deltas: []string{"hi"}})

	// Owner creates the thread.
	rec := env.do(t, http.MethodPost, "/api/chat", map[string]any{
		"id":      "thread-1",
		"message": map[string]any{"id": "msg-1", "role": "user", "parts": []map[string]any{{"type": "text", "text": "hi"}}},
	}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("owner's first message status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// A second user registers and tries to post into the same thread id.
	registerRec := env.do(t, http.MethodPost, "/api/auth/register", map[string]string{"name": "Bob", "email": "bob@example.com", "password": "hunter2"}, "")
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("second register status = %d, body = %s", registerRec.Code, registerRec.Body.String())
	}
	loginRec := env.do(t, http.MethodPost, "/api/auth/login", map[string]string{"email": "bob@example.com", "password": "hunter2"}, "")
	var loginResp struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &loginResp)

	rec = env.do(t, http.MethodPost, "/api/chat", map[string]any{
		"id":      "thread-1",
		"message": map[string]any{"id": "msg-2", "role": "user", "parts": []map[string]any{{"type": "text", "text": "intrude"}}},
	}, loginResp.Token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestRouter_ChatTitleUpsertsThreadTitleOnFinish(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{deltas: []string{"Generated ", "Title"}})

	rec := env.do(t, http.MethodPost, "/api/chat/title", map[string]any{
		"message":  "hello there",
		"threadId": "thread-1",
	}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	thread, err := env.chatRepo.SelectThread(context.Background(), "thread-1")
	if err != nil {
		t.Fatalf("SelectThread: %v", err)
	}
	if thread == nil || thread.Title != "Generated Title" {
		t.Fatalf("got %+v, want title %q", thread, "Generated Title")
	}
}

// TestRouter_ChatTitleStreamFailureStaysInsideSSEFraming is a regression
// test for a real bug found live (not assumed) while final-pass browser
// testing: an immediate Stream() failure (reproduced there by an
// unavailable OS keychain in a headless dev environment; in general,
// anything that fails before the first chunk -- e.g. a missing provider
// key) used to write a raw http.Error 500, which broke the AI SDK
// client's (useCompletion, use-generate-thread-title.ts) stream parser
// with an opaque "Cannot read properties of undefined" page crash instead
// of the intended silent no-op-on-failure UX.
func TestRouter_ChatTitleStreamFailureStaysInsideSSEFraming(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{streamErr: errors.New("keychain unavailable")})

	rec := env.do(t, http.MethodPost, "/api/chat/title", map[string]any{
		"message":  "hello there",
		"threadId": "thread-1",
	}, env.token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (the failure must be framed inside the SSE body, not a raw 500), body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"type":"error"`) {
		t.Fatalf("expected a properly-framed SSE error event, got body: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "keychain unavailable") {
		t.Fatalf("expected the underlying error message in the SSE body, got: %s", rec.Body.String())
	}

	thread, err := env.chatRepo.SelectThread(context.Background(), "thread-1")
	if err != nil {
		t.Fatalf("SelectThread: %v", err)
	}
	if thread != nil {
		t.Fatal("a failed title generation must not persist an empty/partial title")
	}
}

// TestRouter_ChatTemporaryStreamFailureStaysInsideSSEFraming is temporary
// chat's twin of the title regression test above -- same bug, same fix,
// same handler shape.
func TestRouter_ChatTemporaryStreamFailureStaysInsideSSEFraming(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{streamErr: errors.New("keychain unavailable")})

	rec := env.do(t, http.MethodPost, "/api/chat/temporary", map[string]any{
		"messages": []map[string]any{{"id": "m1", "role": "user", "parts": []map[string]any{{"type": "text", "text": "hi"}}}},
	}, env.token)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (the failure must be framed inside the SSE body, not a raw 500), body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"type":"error"`) {
		t.Fatalf("expected a properly-framed SSE error event, got body: %s", rec.Body.String())
	}
}

func TestRouter_ChatTemporaryDoesNotPersistAnyThreadOrMessages(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{deltas: []string{"ephemeral"}})

	rec := env.do(t, http.MethodPost, "/api/chat/temporary", map[string]any{
		"messages": []map[string]any{{"id": "m1", "role": "user", "parts": []map[string]any{{"type": "text", "text": "hi"}}}},
	}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ephemeral") {
		t.Fatalf("body missing streamed text: %s", rec.Body.String())
	}

	thread, err := env.chatRepo.SelectThread(context.Background(), "thread-1")
	if err != nil {
		t.Fatalf("SelectThread: %v", err)
	}
	if thread != nil {
		t.Fatal("temporary chat must not create a persisted thread")
	}
}

func TestRouter_ChatExportRejectsNonOwner(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{deltas: []string{"hi"}})
	rec := env.do(t, http.MethodPost, "/api/chat", map[string]any{
		"id":      "thread-1",
		"message": map[string]any{"id": "msg-1", "role": "user", "parts": []map[string]any{{"type": "text", "text": "hi"}}},
	}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("setup message status = %d", rec.Code)
	}

	registerRec := env.do(t, http.MethodPost, "/api/auth/register", map[string]string{"name": "Bob", "email": "bob@example.com", "password": "hunter2"}, "")
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d", registerRec.Code)
	}
	loginRec := env.do(t, http.MethodPost, "/api/auth/login", map[string]string{"email": "bob@example.com", "password": "hunter2"}, "")
	var loginResp struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &loginResp)

	rec = env.do(t, http.MethodPost, "/api/chat/export", map[string]any{"threadId": "thread-1"}, loginResp.Token)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
}

func TestRouter_ChatExportSucceedsForOwner(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{deltas: []string{"hi"}})
	rec := env.do(t, http.MethodPost, "/api/chat", map[string]any{
		"id":      "thread-1",
		"message": map[string]any{"id": "msg-1", "role": "user", "parts": []map[string]any{{"type": "text", "text": "hi"}}},
	}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("setup message status = %d", rec.Code)
	}

	rec = env.do(t, http.MethodPost, "/api/chat/export", map[string]any{"threadId": "thread-1"}, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestRouter_OpenAIRealtimeFailsCleanlyWithoutAnAPIKey(t *testing.T) {
	env := newChatTestEnv(t, fakeEngine{})
	rec := env.do(t, http.MethodPost, "/api/chat/openai-realtime", map[string]any{"voice": "alloy"}, env.token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusInternalServerError, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "OPENAI_API_KEY") {
		t.Fatalf("body = %s, want it to mention the missing key", rec.Body.String())
	}
}
