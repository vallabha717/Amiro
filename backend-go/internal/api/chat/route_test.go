package chat

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/agent/lsp"
	"amiro/backend/internal/agent/memory"
	"amiro/backend/internal/agent/workspace"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/db"
	"amiro/backend/internal/db/repository"
)

// TestToolDepsCarriesEveryHandlerDependency is the regression test for a bug
// that shipped silently: SearchRepo was added to tools.Deps and threaded all
// the way from main.go into Handler, and then never actually reached the
// inline `tools.Deps{...}` literal inside Chat -- so every live request
// built the web-search tools with a nil repository, no matter what was
// configured in the database. The tool's error for "nothing is wired" and
// its error for "no provider is active" read identically, so from outside
// the process this looked like a data problem, and it passed every test
// that called the tool directly with a repo supplied by hand (which is
// exactly what web_search_test.go and internal/search's own tests do).
//
// route.go's toolDeps exists so this has something to call: a Handler built
// with distinguishable dependencies, its Deps compared field by field. Any
// dependency added to Handler that toolDeps forgets to carry into Deps
// fails this test the same way, not just SearchRepo specifically.
func TestToolDepsCarriesEveryHandlerDependency(t *testing.T) {
	dir := t.TempDir()

	ws, err := workspace.New(dir)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}

	notes, err := memory.Open(dir, dir)
	if err != nil {
		t.Fatalf("memory.Open: %v", err)
	}

	lspPool := lsp.NewPool(dir)
	t.Cleanup(lspPool.Close)

	todos := tools.NewTodoStore()

	gdb, err := db.Open(db.DialectSQLite, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	searchRepo := repository.NewSearchProviderRepository(gdb)

	h := &Handler{
		todos:      todos,
		notes:      notes,
		lsp:        lspPool,
		searchRepo: searchRepo,
	}

	deps := h.toolDeps(ws, "session-123")

	if deps.Workspace != ws {
		t.Error("toolDeps did not carry the workspace passed to it")
	}
	if deps.SessionID != "session-123" {
		t.Errorf("SessionID = %q, want %q", deps.SessionID, "session-123")
	}
	if deps.Todos != todos {
		t.Error("toolDeps did not carry h.todos")
	}
	if deps.Memory != notes {
		t.Error("toolDeps did not carry h.notes")
	}
	if deps.LSP != lspPool {
		t.Error("toolDeps did not carry h.lsp")
	}
	// The field that was actually missing in production.
	if deps.SearchRepo != searchRepo {
		t.Error("toolDeps did not carry h.searchRepo -- this is the exact bug that shipped: " +
			"web_search reported \"no provider configured\" on every live request " +
			"regardless of what was active in the database")
	}
}

// TestToolDepsSearchRepoActuallyAnswersASearch goes one level further than
// field equality: it builds the tool the way a real request does and calls
// it, so a future change that threads the *wrong* repository through (one
// that resolves but never sees the active provider) still fails loudly
// rather than passing a pointer-equality check against itself.
//
// The active config here names a retired provider ("duckduckgo", removed
// along with its scraper -- see internal/search's package comment) rather
// than a real one. That is deliberate, not an oversight: it is the one
// active-row state that reports an error *without making a network call*
// (search.New rejects an unknown kind before anything is dialed), and its
// error text ("unknown search provider") is unmistakably different from
// what a nil SearchRepo produces ("no web search provider is active"). A
// real provider would work too, but would need a live network call and a
// valid key to tell "wired correctly" apart from "key was rejected" --
// this gets the same proof for free.
func TestToolDepsSearchRepoActuallyAnswersASearch(t *testing.T) {
	dir := t.TempDir()
	gdb, err := db.Open(db.DialectSQLite, filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	searchRepo := repository.NewSearchProviderRepository(gdb)

	ctx := t.Context()
	id, err := searchRepo.Set(ctx, "", "duckduckgo", "Retired", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := searchRepo.SetActive(ctx, id); err != nil {
		t.Fatal(err)
	}

	h := &Handler{searchRepo: searchRepo, todos: tools.NewTodoStore()}
	deps := h.toolDeps(nil, "session-123")

	defs := tools.Defaults(deps)
	def, ok := tools.FindByName(defs, tools.NameWebSearch)
	if !ok {
		t.Fatal("web_search is not in the tools Defaults built")
	}

	out, err := def.Execute(ctx, []byte(`{"query":"test"}`))
	if err != nil {
		t.Fatal(err)
	}
	// The tool's error payload (webToolError) is unexported, so it is read
	// back the way the browser would: as JSON.
	raw, jsonErr := json.Marshal(out)
	if jsonErr != nil {
		t.Fatal(jsonErr)
	}
	var payload struct {
		IsError bool   `json:"isError"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.IsError {
		t.Fatalf("got a non-error output %s, want the unknown-provider error", raw)
	}
	if strings.Contains(payload.Error, "no web search provider is active") {
		t.Fatalf("got the nil-SearchRepo error (%q) even though an active row exists -- "+
			"toolDeps did not carry h.searchRepo to the tool", payload.Error)
	}
	if !strings.Contains(payload.Error, "unknown search provider") {
		t.Fatalf("got %q, want the unknown-provider error confirming SearchRepo saw the active row", payload.Error)
	}
}
