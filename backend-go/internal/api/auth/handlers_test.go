package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	authsvc "betterchatbot/backend/internal/auth"
	"betterchatbot/backend/internal/db"
)

func newTestService(t *testing.T) *authsvc.Service {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	return authsvc.NewService(gdb)
}

func jsonBody(t *testing.T, v any) *bytes.Reader {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return bytes.NewReader(b)
}

func TestRegister_ReturnsCreatedWithUserAndToken(t *testing.T) {
	service := newTestService(t)
	handler := Register(service)

	body := jsonBody(t, map[string]string{"name": "Ada", "email": "ada@example.com", "password": "hunter2"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	var resp sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.User.Email != "ada@example.com" || resp.Token == "" {
		t.Fatalf("resp = %+v, want a populated user+token", resp)
	}
}

func TestRegister_RejectsMissingFields(t *testing.T) {
	service := newTestService(t)
	handler := Register(service)

	body := jsonBody(t, map[string]string{"email": "ada@example.com"})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestRegister_RejectsDuplicateEmailWithConflict(t *testing.T) {
	service := newTestService(t)
	handler := Register(service)

	first := jsonBody(t, map[string]string{"name": "Ada", "email": "ada@example.com", "password": "hunter2"})
	handler(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/auth/register", first))

	second := jsonBody(t, map[string]string{"name": "Ada Again", "email": "ada@example.com", "password": "other"})
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, "/api/auth/register", second))

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
}

func TestLogin_ReturnsTokenForValidCredentials(t *testing.T) {
	service := newTestService(t)
	if _, err := service.Register(context.Background(), "Ada", "ada@example.com", "hunter2"); err != nil {
		t.Fatalf("Register: %v", err)
	}

	handler := Login(service)
	body := jsonBody(t, map[string]string{"email": "ada@example.com", "password": "hunter2"})
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", body))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var resp sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Token == "" {
		t.Fatal("expected a non-empty token")
	}
}

func TestLogin_RejectsWrongPasswordWithUnauthorized(t *testing.T) {
	service := newTestService(t)
	if _, err := service.Register(context.Background(), "Ada", "ada@example.com", "hunter2"); err != nil {
		t.Fatalf("Register: %v", err)
	}

	handler := Login(service)
	body := jsonBody(t, map[string]string{"email": "ada@example.com", "password": "wrong"})
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, "/api/auth/login", body))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestLogout_ClearsSessionSoItNoLongerValidates(t *testing.T) {
	service := newTestService(t)
	user, err := service.Register(context.Background(), "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	session, err := service.CreateSession(context.Background(), user.ID, "", "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	handler := Logout(service)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+session.Token)
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if _, _, err := service.ValidateSession(context.Background(), session.Token); err != authsvc.ErrSessionNotFound {
		t.Fatalf("err = %v, want ErrSessionNotFound after logout", err)
	}
}

func TestMe_RequiresUserOnContext(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	rec := httptest.NewRecorder()
	Me(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d (Me called without RequireSession having run)", rec.Code, http.StatusUnauthorized)
	}
}
