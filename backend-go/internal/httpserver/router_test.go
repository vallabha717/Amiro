package httpserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"amiro/backend/internal/auth"
	"amiro/backend/internal/config"
	"amiro/backend/internal/db"
	"amiro/backend/internal/middleware"
)

func testConfig() config.Config {
	return config.Config{
		AuthToken:     "test-token",
		AllowedOrigin: "tauri://localhost",
		AppDataDir:    "/tmp",
	}
}

// TestRouter_HealthRejectsRequestWithoutToken exercises auth+CORS+routing
// together through New(cfg), the same way the real webview->sidecar request
// path does -- not just the auth middleware in isolation.
func TestRouter_HealthRejectsRequestWithoutToken(t *testing.T) {
	handler := New(testConfig(), Handlers{})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRouter_HealthReturnsOkWithValidTokenAndMatchingOrigin(t *testing.T) {
	handler := New(testConfig(), Handlers{})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set(middleware.AuthHeader, "test-token")
	req.Header.Set("Origin", "tauri://localhost")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "tauri://localhost" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want %q", got, "tauri://localhost")
	}
	if got, want := rec.Body.String(), `{"status":"ok"}`; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
}

// TestRouter_HealthSucceedsWithValidTokenEvenWithMismatchedOrigin proves the
// two guards are independent: CORS only controls whether a *browser* can read
// the response, it must never gate whether the handler runs at all.
func TestRouter_HealthSucceedsWithValidTokenEvenWithMismatchedOrigin(t *testing.T) {
	handler := New(testConfig(), Handlers{})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set(middleware.AuthHeader, "test-token")
	req.Header.Set("Origin", "http://evil.example")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty for a mismatched origin", got)
	}
}

func TestRouter_UnknownRouteReturnsNotFoundNotServerError(t *testing.T) {
	handler := New(testConfig(), Handlers{})

	req := httptest.NewRequest(http.MethodGet, "/does-not-exist", nil)
	req.Header.Set(middleware.AuthHeader, "test-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

// TestRouter_AuthRegisterLoginSessionLogout drives the full
// register->login->session->logout cycle through New(cfg, authService), the
// same way a real webview request does: sidecar token + CORS + routing +
// per-user session all together, not each guard in isolation.
func TestRouter_AuthRegisterLoginSessionLogout(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	handler := New(testConfig(), Handlers{Auth: authService})

	do := func(method, path string, body any, bearer string) *httptest.ResponseRecorder {
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
		handler.ServeHTTP(rec, req)
		return rec
	}

	registerRec := do(http.MethodPost, "/api/auth/register",
		map[string]string{"name": "Ada", "email": "ada@example.com", "password": "hunter2"}, "")
	if registerRec.Code != http.StatusCreated {
		t.Fatalf("register status = %d, want %d, body = %s", registerRec.Code, http.StatusCreated, registerRec.Body.String())
	}

	loginRec := do(http.MethodPost, "/api/auth/login",
		map[string]string{"email": "ada@example.com", "password": "hunter2"}, "")
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login status = %d, want %d, body = %s", loginRec.Code, http.StatusOK, loginRec.Body.String())
	}
	var loginResp struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(loginRec.Body.Bytes(), &loginResp); err != nil {
		t.Fatalf("unmarshal login response: %v", err)
	}
	if loginResp.Token == "" {
		t.Fatal("expected a non-empty token from login")
	}

	sessionRec := do(http.MethodGet, "/api/auth/session", nil, loginResp.Token)
	if sessionRec.Code != http.StatusOK {
		t.Fatalf("session status = %d, want %d, body = %s", sessionRec.Code, http.StatusOK, sessionRec.Body.String())
	}

	logoutRec := do(http.MethodPost, "/api/auth/logout", nil, loginResp.Token)
	if logoutRec.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, want %d", logoutRec.Code, http.StatusNoContent)
	}

	sessionAfterLogoutRec := do(http.MethodGet, "/api/auth/session", nil, loginResp.Token)
	if sessionAfterLogoutRec.Code != http.StatusUnauthorized {
		t.Fatalf("session-after-logout status = %d, want %d", sessionAfterLogoutRec.Code, http.StatusUnauthorized)
	}
}

// TestRouter_AuthRoutesRejectRequestWithoutSidecarToken proves the
// shared-secret guard still gates the new auth routes exactly like /health
// -- a per-user session token must never be usable without the sidecar's
// own token too.
func TestRouter_AuthRoutesRejectRequestWithoutSidecarToken(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "test.db")
	gdb, err := db.Open(db.DialectSQLite, dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	authService := auth.NewService(gdb)
	handler := New(testConfig(), Handlers{Auth: authService})

	req := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	req.Header.Set("Authorization", "Bearer irrelevant")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}
