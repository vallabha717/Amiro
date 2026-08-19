package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/auth"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/models"
	"amiro/backend/internal/db/repository"
)

func newHandler(t *testing.T) (*Handler, *repository.SearchProviderRepository) {
	t.Helper()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	repo := repository.NewSearchProviderRepository(gdb)
	return NewHandler(repo), repo
}

// as builds a request carrying an authenticated user of the given role, the
// way auth.RequireSession would have left it.
func as(t *testing.T, role, method, target string, body string) *http.Request {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	if role == "" {
		return r
	}
	user := &models.User{ID: "u1", Name: "Ada", Email: "ada@example.com", Role: role}
	return r.WithContext(auth.ContextWithUser(r.Context(), user))
}

/* ---------------------------------------------------------------- */
/* The gate                                                          */
/* ---------------------------------------------------------------- */

// These endpoints read and write third-party API keys behind an /admin
// screen. Gating on a session alone -- which is what shipped -- let any
// registered user list, rewrite or delete every provider.
func TestEveryEndpointRefusesNonAdmins(t *testing.T) {
	h, repo := newHandler(t)
	id, err := repo.Set(context.Background(), "", "brave", "Brave", "secret-key")
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
		method  string
		target  string
		body    string
	}{
		{"list", h.GetStatuses, http.MethodGet, "/api/search/providers", ""},
		{"catalog", h.GetCatalog, http.MethodGet, "/api/search/catalog", ""},
		{"create", h.SetConfig, http.MethodPost, "/api/search/providers", `{"name":"x","provider":"brave","apiKey":"k"}`},
		{"delete", h.DeleteConfig, http.MethodDelete, "/api/search/providers/" + id, ""},
		{"activate", h.Activate, http.MethodPost, "/api/search/providers/" + id + "/activate", ""},
		{"test", h.TestProvider, http.MethodPost, "/api/search/providers/" + id + "/test", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r := as(t, "user", tc.method, tc.target, tc.body)
			r.SetPathValue("id", id)
			tc.handler(w, r)
			if w.Code != http.StatusForbidden {
				t.Fatalf("%s as a non-admin: status %d, want 403", tc.name, w.Code)
			}
			if strings.Contains(w.Body.String(), "secret-key") {
				t.Fatalf("%s leaked the stored key to a non-admin", tc.name)
			}
		})
	}
}

/* ---------------------------------------------------------------- */
/* GetActive: the one deliberately non-admin endpoint                */
/* ---------------------------------------------------------------- */

// This is the endpoint the chat UI polls to label a search ("via Brave
// Search") and to show the composer's toolbar which engine is live. Every
// signed-in user needs it, not just an admin -- unlike every other handler
// in this file, which is why it is tested separately from
// TestEveryEndpointRefusesNonAdmins rather than added to that table.
func TestGetActiveWorksForAnyAuthenticatedUser(t *testing.T) {
	h, repo := newHandler(t)
	id, err := repo.Set(context.Background(), "", "brave", "Brave", "secret-key")
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetActive(context.Background(), id); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	h.GetActive(w, as(t, "user", http.MethodGet, "/api/search/active", ""))
	if w.Code != http.StatusOK {
		t.Fatalf("a non-admin must be able to see the active provider: status %d", w.Code)
	}

	var got ActiveProviderDTO
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Configured || got.Provider != "brave" || got.Label != "Brave Search" {
		t.Fatalf("got %+v, want the active provider's kind and label", got)
	}
	// The one thing this response must never carry.
	if strings.Contains(w.Body.String(), "secret-key") {
		t.Fatalf("GetActive leaked the API key: %s", w.Body.String())
	}
}

func TestGetActiveRequiresASession(t *testing.T) {
	h, _ := newHandler(t)
	w := httptest.NewRecorder()
	h.GetActive(w, as(t, "", http.MethodGet, "/api/search/active", ""))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401 for no session at all", w.Code)
	}
}

func TestGetActiveReportsUnconfiguredCleanly(t *testing.T) {
	h, _ := newHandler(t)
	w := httptest.NewRecorder()
	h.GetActive(w, as(t, "user", http.MethodGet, "/api/search/active", ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 -- unconfigured is a normal state, not an error", w.Code)
	}
	var got ActiveProviderDTO
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Configured {
		t.Fatalf("got %+v, want Configured=false with nothing else set", got)
	}
}

func TestUnauthenticatedIsRejected(t *testing.T) {
	h, _ := newHandler(t)
	w := httptest.NewRecorder()
	h.GetStatuses(w, as(t, "", http.MethodGet, "/api/search/providers", ""))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", w.Code)
	}
}

/* ---------------------------------------------------------------- */
/* Keys never leave the server                                       */
/* ---------------------------------------------------------------- */

func TestListMasksTheStoredKey(t *testing.T) {
	h, repo := newHandler(t)
	const key = "brv-1234567890abcdef"
	if _, err := repo.Set(context.Background(), "", "brave", "Brave", key); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	h.GetStatuses(w, as(t, "admin", http.MethodGet, "/api/search/providers", ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", w.Code)
	}
	// Even to an admin: the full key has no use in the browser, and one that
	// is never sent cannot be read off a shared screen or an XSS payload.
	if strings.Contains(w.Body.String(), key) {
		t.Fatalf("response carried the full API key: %s", w.Body.String())
	}

	var got []ProviderStatusDTO
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d providers, want 1", len(got))
	}
	if !got[0].Configured {
		t.Error("a provider with a key must report configured")
	}
	// The hint exists so an admin holding several keys can tell them apart.
	if got[0].APIKeyHint == "" || !strings.HasSuffix(got[0].APIKeyHint, "cdef") {
		t.Errorf("APIKeyHint = %q, want a recognisable tail", got[0].APIKeyHint)
	}
}

func TestListReportsExtractionCapability(t *testing.T) {
	h, repo := newHandler(t)
	ctx := context.Background()
	_, _ = repo.Set(ctx, "", "brave", "Brave", "k")
	_, _ = repo.Set(ctx, "", "tavily", "Tavily", "k")

	w := httptest.NewRecorder()
	h.GetStatuses(w, as(t, "admin", http.MethodGet, "/api/search/providers", ""))

	var got []ProviderStatusDTO
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	byKind := map[string]bool{}
	for _, g := range got {
		byKind[g.Provider] = g.Extracts
	}
	// The badge tells an admin whether picking this provider keeps
	// web_content working. Wrong here, it is advice that breaks a tool.
	if byKind["brave"] {
		t.Error("brave returns links only and must not claim extraction")
	}
	if !byKind["tavily"] {
		t.Error("tavily extracts content and must say so")
	}
}

/* ---------------------------------------------------------------- */
/* Validation                                                        */
/* ---------------------------------------------------------------- */

func TestUnknownProviderIsRejectedOnSave(t *testing.T) {
	h, _ := newHandler(t)
	for _, kind := range []string{"duckduckgo", "searxng", "nonsense"} {
		w := httptest.NewRecorder()
		body := `{"name":"X","provider":"` + kind + `","apiKey":"k"}`
		h.SetConfig(w, as(t, "admin", http.MethodPost, "/api/search/providers", body))
		// Storable before, then silently resolved to a default engine at
		// search time. The save is the last moment the user is on screen
		// to be told.
		if w.Code != http.StatusBadRequest {
			t.Errorf("provider %q: status %d, want 400", kind, w.Code)
		}
	}
}

func TestCreateWithoutAKeyIsRejected(t *testing.T) {
	h, _ := newHandler(t)
	w := httptest.NewRecorder()
	h.SetConfig(w, as(t, "admin", http.MethodPost, "/api/search/providers", `{"name":"X","provider":"brave","apiKey":""}`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400 -- a keyless config is saved-but-broken", w.Code)
	}
}

func TestUpdateWithoutAKeyIsAllowedAndKeepsTheStoredOne(t *testing.T) {
	h, repo := newHandler(t)
	ctx := context.Background()
	id, _ := repo.Set(ctx, "", "brave", "Brave", "original")

	w := httptest.NewRecorder()
	body := `{"id":"` + id + `","name":"Renamed","provider":"brave","apiKey":""}`
	h.SetConfig(w, as(t, "admin", http.MethodPost, "/api/search/providers", body))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200: %s", w.Code, w.Body.String())
	}

	// This is what makes masking workable: the editor can round-trip a
	// config it never received the key for.
	got, _ := repo.Get(ctx, id)
	if got.Name != "Renamed" || got.APIKey != "original" {
		t.Fatalf("got %+v, want renamed with the key preserved", got)
	}
}

func TestMissingProviderIsNotFound(t *testing.T) {
	h, _ := newHandler(t)
	for name, handler := range map[string]http.HandlerFunc{
		"delete":   h.DeleteConfig,
		"activate": h.Activate,
		"test":     h.TestProvider,
	} {
		w := httptest.NewRecorder()
		r := as(t, "admin", http.MethodPost, "/api/search/providers/ghost", "")
		r.SetPathValue("id", "ghost")
		handler(w, r)
		if w.Code != http.StatusNotFound {
			t.Errorf("%s on a missing id: status %d, want 404", name, w.Code)
		}
	}
}

func TestCatalogListsEverySupportedProvider(t *testing.T) {
	h, _ := newHandler(t)
	w := httptest.NewRecorder()
	h.GetCatalog(w, as(t, "admin", http.MethodGet, "/api/search/catalog", ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", w.Code)
	}
	body := w.Body.String()
	for _, kind := range []string{"brave", "tavily", "exa", "serper"} {
		if !strings.Contains(body, `"`+kind+`"`) {
			t.Errorf("catalog is missing %q: %s", kind, body)
		}
	}
	// The removed scrapers must not come back through the picker.
	for _, gone := range []string{"duckduckgo", "searxng"} {
		if strings.Contains(body, gone) {
			t.Errorf("catalog still offers the removed provider %q", gone)
		}
	}
}

func TestMaskKey(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", ""},
		{"short", "•••••"},
		{"brv-1234567890abcdef", "brv…cdef"},
	} {
		if got := maskKey(tc.in); got != tc.want {
			t.Errorf("maskKey(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
