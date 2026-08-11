package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestRequireToken_RejectsMissingHeader(t *testing.T) {
	handler := RequireToken("secret")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireToken_RejectsWrongToken(t *testing.T) {
	handler := RequireToken("secret")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set(AuthHeader, "wrong-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireToken_RejectsTokenThatIsAPrefixOfTheRealOne(t *testing.T) {
	// Guards against a naive strings.HasPrefix-style check creeping back in.
	handler := RequireToken("secret-token")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set(AuthHeader, "secret")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireToken_AllowsCorrectToken(t *testing.T) {
	handler := RequireToken("secret")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set(AuthHeader, "secret")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestRequireToken_LetsPreflightThroughWithoutToken(t *testing.T) {
	// Browsers never attach custom headers to an OPTIONS preflight, so this
	// middleware must not 401 it -- CORS middleware answers preflights instead.
	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	})
	handler := RequireToken("secret")(next)

	req := httptest.NewRequest(http.MethodOptions, "/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Fatal("expected OPTIONS request to reach the next handler without a token")
	}
}

func TestRequireToken_LetsAnExemptPrefixThroughWithoutTheHeader(t *testing.T) {
	handler := RequireToken("secret", "/storage/")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/storage/some-signed-token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 -- an <img src> cannot send the shared-secret header", rec.Code)
	}
}

func TestRequireToken_StillGuardsEverythingOutsideTheExemptPrefix(t *testing.T) {
	handler := RequireToken("secret", "/storage/")(okHandler())

	for _, path := range []string{"/api/chat", "/storage", "/health"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: status = %d, want 401", path, rec.Code)
		}
	}
}

// A path that merely *contains* the exempt prefix later on must not slip
// through -- the check is a prefix match, and this pins that it stays one.
func TestRequireToken_ExemptPrefixIsNotASubstringMatch(t *testing.T) {
	handler := RequireToken("secret", "/storage/")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/api/storage/upload", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestRequireToken_WithNoExemptPrefixesGuardsEveryPath(t *testing.T) {
	handler := RequireToken("secret")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/storage/some-signed-token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
