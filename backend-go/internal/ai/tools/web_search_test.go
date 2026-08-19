package tools

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/db"
	"amiro/backend/internal/db/repository"
)

func newSearchRepo(t *testing.T) *repository.SearchProviderRepository {
	t.Helper()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	return repository.NewSearchProviderRepository(gdb)
}

func activate(t *testing.T, repo *repository.SearchProviderRepository, kind, key string) {
	t.Helper()
	ctx := context.Background()
	id, err := repo.Set(ctx, "", kind, kind, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetActive(ctx, id); err != nil {
		t.Fatal(err)
	}
}

// asToolError re-decodes a tool result into the error payload shape. Tool
// failures are returned as successful calls carrying isError, so the model
// can explain them; nil errors here are expected.
func asToolError(t *testing.T, out any) webToolError {
	t.Helper()
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	var e webToolError
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatal(err)
	}
	if !e.IsError {
		t.Fatalf("expected an error payload, got %s", raw)
	}
	return e
}

/* ---------------------------------------------------------------- */
/* The headline bug                                                  */
/* ---------------------------------------------------------------- */

// web_content used to call Exa unconditionally, handing it whatever key the
// active provider happened to hold. With a link-only provider active it
// reported "EXA_API_KEY is not configured" -- so on any setup not using Exa,
// this tool was simply dead, and the error named an environment variable the
// user had never heard of.
func TestWebContentExplainsProvidersThatCannotExtract(t *testing.T) {
	repo := newSearchRepo(t)
	activate(t, repo, "brave", "brv-key")

	out, err := executeWebContent(context.Background(),
		json.RawMessage(`{"urls":["https://example.com"]}`), repo)
	if err != nil {
		t.Fatal(err)
	}
	e := asToolError(t, out)

	if strings.Contains(e.Error, "EXA_API_KEY") {
		t.Fatalf("error still blames Exa for a Brave setup: %s", e.Error)
	}
	if !strings.Contains(e.Error, "brave") {
		t.Errorf("error should name the active provider, got: %s", e.Error)
	}
	// A dead end is not an answer. The remedy has to name something the
	// model can actually do next.
	if !strings.Contains(e.Solution, "http_fetch") {
		t.Errorf("solution should point at http_fetch, got: %s", e.Solution)
	}
	if !strings.Contains(e.Solution, "Tavily") {
		t.Errorf("solution should name a provider that can extract, got: %s", e.Solution)
	}
}

func TestWebContentAcceptsProvidersThatCanExtract(t *testing.T) {
	// The only test here that leaves the machine: the capability check it
	// asserts happens *before* the request, so the request itself is
	// incidental and its failure (no real key) is fine -- but a sandboxed
	// run should not pay for the dial.
	if testing.Short() {
		t.Skip("makes an outbound request")
	}
	repo := newSearchRepo(t)
	activate(t, repo, "tavily", "tvly-key")

	out, err := executeWebContent(context.Background(),
		json.RawMessage(`{"urls":["https://example.com"]}`), repo)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(out)
	// The call reaches the network and fails there (no real key), which is
	// fine -- what matters is that it was not refused on capability
	// grounds before it started.
	if strings.Contains(string(raw), "cannot extract page content") {
		t.Fatalf("tavily extracts content and must not be refused: %s", raw)
	}
}

/* ---------------------------------------------------------------- */
/* No provider, and no silent fallback                               */
/* ---------------------------------------------------------------- */

func TestNoActiveProviderIsExplainedNotGuessed(t *testing.T) {
	repo := newSearchRepo(t)

	for name, run := range map[string]func() (any, error){
		"search":  func() (any, error) { return executeWebSearch(context.Background(), json.RawMessage(`{"query":"x"}`), repo) },
		"content": func() (any, error) { return executeWebContent(context.Background(), json.RawMessage(`{"urls":["https://x.com"]}`), repo) },
	} {
		out, err := run()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		e := asToolError(t, out)
		// The old code fell through to a scraper here, so an unconfigured
		// install looked like a working one that returned nothing.
		if !strings.Contains(e.Error, "Search Providers") {
			t.Errorf("%s: error should name the screen that fixes it, got: %s", name, e.Error)
		}
	}
}

func TestNilRepositoryDoesNotPanic(t *testing.T) {
	out, err := executeWebSearch(context.Background(), json.RawMessage(`{"query":"x"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	asToolError(t, out)
}

// A row naming a provider this build no longer has must not resolve to
// something else. Before, the switch ended in a default case, so a stale
// duckduckgo row searched with a scraper while the UI named DuckDuckGo and
// the tool reported neither.
func TestRetiredProviderRowIsAnError(t *testing.T) {
	repo := newSearchRepo(t)
	activate(t, repo, "duckduckgo", "")

	out, err := executeWebSearch(context.Background(), json.RawMessage(`{"query":"x"}`), repo)
	if err != nil {
		t.Fatal(err)
	}
	e := asToolError(t, out)
	if !strings.Contains(e.Error, "unknown search provider") {
		t.Fatalf("got %q, want an explicit unknown-provider error", e.Error)
	}
}

func TestMissingKeyNamesTheProviderAndTheScreen(t *testing.T) {
	repo := newSearchRepo(t)
	activate(t, repo, "brave", "")

	out, err := executeWebSearch(context.Background(), json.RawMessage(`{"query":"x"}`), repo)
	if err != nil {
		t.Fatal(err)
	}
	e := asToolError(t, out)
	if !strings.Contains(e.Error, "brave") || !strings.Contains(e.Error, "Search Providers") {
		t.Fatalf("got %q, want the provider and the settings screen named", e.Error)
	}
}

func TestBadArgumentsAreReportedAsToolErrors(t *testing.T) {
	repo := newSearchRepo(t)
	activate(t, repo, "brave", "k")

	out, err := executeWebSearch(context.Background(), json.RawMessage(`{"query":`), repo)
	if err != nil {
		t.Fatalf("a malformed argument must not fail the turn: %v", err)
	}
	asToolError(t, out)

	out, err = executeWebContent(context.Background(), json.RawMessage(`{"urls":[]}`), repo)
	if err != nil {
		t.Fatal(err)
	}
	if e := asToolError(t, out); !strings.Contains(e.Error, "no urls") {
		t.Fatalf("got %q, want a message about the empty url list", e.Error)
	}
}

func TestToolsAreRegisteredWithSchemas(t *testing.T) {
	defs := webSearchTools(nil)
	if len(defs) != 2 {
		t.Fatalf("got %d tools, want web_search and web_content", len(defs))
	}
	for _, d := range defs {
		if d.Execute == nil {
			t.Errorf("%s has no executor", d.Name)
		}
		if !json.Valid(d.ParametersSchema) {
			t.Errorf("%s has an invalid parameters schema", d.Name)
		}
		// Read risk: these tools fetch public pages and change nothing, so
		// gating them behind an approval prompt would put a dialog in front
		// of every search.
		if d.Risk != RiskRead {
			t.Errorf("%s risk = %v, want RiskRead", d.Name, d.Risk)
		}
	}
}
