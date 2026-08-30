package githubapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	githubapi "amiro/backend/internal/api/github"
	"amiro/backend/internal/auth"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/secrets"
)

// memStore is a minimal in-memory secrets.KeyStore, standing in for
// KeyringStore/EnvStore the way this package's own tests need no real OS
// keychain.
type memStore struct{ m map[string]string }

func newMemStore() *memStore { return &memStore{m: map[string]string{}} }

func (s *memStore) Get(_ context.Context, provider string) (string, bool, error) {
	v, ok := s.m[provider]
	return v, ok, nil
}
func (s *memStore) Set(_ context.Context, provider, key string) error {
	s.m[provider] = key
	return nil
}
func (s *memStore) Delete(_ context.Context, provider string) error {
	delete(s.m, provider)
	return nil
}

var _ secrets.KeyStore = (*memStore)(nil)

func authedContext() context.Context {
	return auth.ContextWithUser(context.Background(), &models.User{Name: "Ada", Email: "ada@example.com"})
}

func TestHandler_StatusUnauthorized(t *testing.T) {
	h := githubapi.NewHandler(newMemStore())
	req := httptest.NewRequest(http.MethodGet, "/api/github/status", nil)
	rec := httptest.NewRecorder()
	h.Status(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestHandler_StatusConnectStatusDisconnectStatusRoundTrips(t *testing.T) {
	store := newMemStore()
	h := githubapi.NewHandler(store)

	get := func() (connected bool) {
		req := httptest.NewRequest(http.MethodGet, "/api/github/status", nil).WithContext(authedContext())
		rec := httptest.NewRecorder()
		h.Status(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status: code = %d, body = %s", rec.Code, rec.Body)
		}
		var body struct {
			Connected bool `json:"connected"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return body.Connected
	}

	if get() {
		t.Fatal("Connected = true before any token was ever set")
	}

	connBody, _ := json.Marshal(map[string]string{"token": "ghp_test_token"})
	connReq := httptest.NewRequest(http.MethodPost, "/api/github/connect", strings.NewReader(string(connBody))).WithContext(authedContext())
	connRec := httptest.NewRecorder()
	h.Connect(connRec, connReq)
	if connRec.Code != http.StatusOK {
		t.Fatalf("connect: code = %d, body = %s", connRec.Code, connRec.Body)
	}
	if !strings.Contains(connRec.Body.String(), `"connected":true`) {
		t.Errorf("connect response = %q, want connected:true", connRec.Body.String())
	}
	// The token itself must never appear in a response body.
	if strings.Contains(connRec.Body.String(), "ghp_test_token") {
		t.Fatal("the raw token leaked into the /connect response body")
	}

	if !get() {
		t.Fatal("Connected = false right after a successful /connect")
	}
	if tok, _, _ := store.Get(context.Background(), secrets.GitHubTokenKey); tok != "ghp_test_token" {
		t.Fatalf("stored token = %q, want ghp_test_token", tok)
	}

	discReq := httptest.NewRequest(http.MethodPost, "/api/github/disconnect", nil).WithContext(authedContext())
	discRec := httptest.NewRecorder()
	h.Disconnect(discRec, discReq)
	if discRec.Code != http.StatusOK {
		t.Fatalf("disconnect: code = %d, body = %s", discRec.Code, discRec.Body)
	}
	if get() {
		t.Fatal("Connected = true after /disconnect")
	}
}

func TestHandler_ConnectRejectsEmptyToken(t *testing.T) {
	h := githubapi.NewHandler(newMemStore())
	body, _ := json.Marshal(map[string]string{"token": "   "})
	req := httptest.NewRequest(http.MethodPost, "/api/github/connect", strings.NewReader(string(body))).WithContext(authedContext())
	rec := httptest.NewRecorder()
	h.Connect(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a blank token", rec.Code)
	}
}

func TestTokenLookup_ReadsTheSameKeyConnectWrote(t *testing.T) {
	store := newMemStore()
	if err := store.Set(context.Background(), secrets.GitHubTokenKey, "gh-abc"); err != nil {
		t.Fatal(err)
	}
	lookup := githubapi.TokenLookup(store)
	tok, ok, err := lookup(context.Background())
	if err != nil || !ok || tok != "gh-abc" {
		t.Fatalf("TokenLookup = (%q, %v, %v), want (\"gh-abc\", true, nil)", tok, ok, err)
	}
}

func TestTokenLookup_NilStoreReportsNotConfigured(t *testing.T) {
	lookup := githubapi.TokenLookup(nil)
	_, ok, err := lookup(context.Background())
	if err != nil || ok {
		t.Fatalf("TokenLookup(nil) = (_, %v, %v), want (_, false, nil)", ok, err)
	}
}
