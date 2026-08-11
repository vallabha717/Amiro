package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"betterchatbot/backend/internal/db/models"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := UserFromContext(r.Context())
		if !ok {
			http.Error(w, "no user on context", http.StatusInternalServerError)
			return
		}
		w.Write([]byte(user.Email))
	})
}

func TestRequireSession_RejectsMissingHeader(t *testing.T) {
	service := newTestService(t)
	handler := RequireSession(service)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireSession_RejectsMalformedHeader(t *testing.T) {
	service := newTestService(t)
	handler := RequireSession(service)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	req.Header.Set("Authorization", "not-a-bearer-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireSession_RejectsUnknownToken(t *testing.T) {
	service := newTestService(t)
	handler := RequireSession(service)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	req.Header.Set("Authorization", "Bearer does-not-exist")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireSession_AllowsValidTokenAndSetsUserOnContext(t *testing.T) {
	service := newTestService(t)
	user, err := service.Register(context.Background(), "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	session, err := service.CreateSession(context.Background(), user.ID, "", "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	handler := RequireSession(service)(okHandler())
	req := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	req.Header.Set("Authorization", "Bearer "+session.Token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if rec.Body.String() != "ada@example.com" {
		t.Fatalf("body = %q, want the authenticated user's email", rec.Body.String())
	}
}

func TestRequireSession_LetsPreflightThroughWithoutToken(t *testing.T) {
	service := newTestService(t)
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	})
	handler := RequireSession(service)(next)

	req := httptest.NewRequest(http.MethodOptions, "/api/auth/session", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("expected OPTIONS request to reach the next handler without a token")
	}
}

func TestBearerToken_ParsesWellFormedHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer abc123")
	token, ok := BearerToken(req)
	if !ok || token != "abc123" {
		t.Fatalf("token = %q, ok = %v, want %q, true", token, ok, "abc123")
	}
}

func TestBearerToken_RejectsMissingHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, ok := BearerToken(req); ok {
		t.Fatal("expected ok=false for a request with no Authorization header")
	}
}

func TestBearerToken_RejectsEmptyToken(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer ")
	if _, ok := BearerToken(req); ok {
		t.Fatal("expected ok=false for a Bearer header with no token")
	}
}

func TestOptionalSession_AttachesTheUserWhenAValidTokenIsPresent(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	user, err := service.Register(ctx, "Ada", "ada@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	session, err := service.CreateSession(ctx, user.ID, "", "")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	var seen *models.User
	handler := OptionalSession(service)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		seen, _ = UserFromContext(r.Context())
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/export/x/comments", nil)
	req.Header.Set("Authorization", "Bearer "+session.Token)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if seen == nil || seen.ID != user.ID {
		t.Fatalf("got %+v, want the signed-in user", seen)
	}
}

func TestOptionalSession_AllowsARequestWithNoTokenThrough(t *testing.T) {
	service := newTestService(t)

	called := false
	handler := OptionalSession(service)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if _, ok := UserFromContext(r.Context()); ok {
			t.Error("a user was attached to an unauthenticated request")
		}
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/export/x/comments", nil))

	if !called || rec.Code != http.StatusOK {
		t.Fatalf("called = %v, status = %d -- the handler must still run", called, rec.Code)
	}
}

func TestOptionalSession_AllowsAnInvalidTokenThroughAsAnonymous(t *testing.T) {
	service := newTestService(t)

	called := false
	handler := OptionalSession(service)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if _, ok := UserFromContext(r.Context()); ok {
			t.Error("an invalid token produced an authenticated request")
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/export/x/comments", nil)
	req.Header.Set("Authorization", "Bearer not-a-real-token")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if !called {
		t.Fatal("the handler did not run -- OptionalSession must never reject")
	}
}
