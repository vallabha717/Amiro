package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/agent/memory"
	"amiro/backend/internal/agent/workspace"
)

func repoWorkspace(t *testing.T, files map[string]string) *workspace.Workspace {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	ws, err := workspace.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	return ws
}

func call(t *testing.T, def Definition, input any) any {
	t.Helper()
	raw, _ := json.Marshal(input)
	out, err := def.Execute(context.Background(), raw)
	if err != nil {
		t.Fatalf("%s: %v", def.Name, err)
	}
	return out
}

/* ------------------------------------------------------------------ */
/* repo_map                                                            */
/* ------------------------------------------------------------------ */

func TestRepoMap_ReturnsBothARenderedMapAndStructuredFiles(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{
		"go.mod":       "module x\n",
		"auth/user.go": "package auth\nfunc Login() {}\ntype Session struct{}\n",
	})
	out := call(t, repoMapTool(ws), map[string]any{}).(RepoMapOutput)

	if !strings.Contains(out.Text, "auth/user.go") || !strings.Contains(out.Text, "Login") {
		t.Fatalf("rendered text does not describe the file:\n%s", out.Text)
	}
	if len(out.Files) == 0 {
		t.Fatal("Files is empty; the presenter has nothing to render")
	}
	// The two shapes exist for two different readers and must agree.
	if out.Files[0].Path != "auth/user.go" {
		t.Fatalf("Files[0].Path = %q", out.Files[0].Path)
	}
}

// The map and list_dir must describe the same repository, or the map
// includes build output the user does not think they have.
func TestRepoMap_HonoursGitignore(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{
		".gitignore":     "generated/\n",
		"keep.go":        "package p\nfunc Keep() {}\n",
		"generated/x.go": "package p\nfunc Generated() {}\n",
	})
	out := call(t, repoMapTool(ws), map[string]any{}).(RepoMapOutput)

	if strings.Contains(out.Text, "Generated") {
		t.Fatalf("mapped a gitignored file:\n%s", out.Text)
	}
}

func TestRepoMap_ScopesToASubdirectoryAndRefusesToEscape(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{
		"a/one.go": "package a\nfunc One() {}\n",
		"b/two.go": "package b\nfunc Two() {}\n",
	})
	out := call(t, repoMapTool(ws), map[string]any{"path": "a"}).(RepoMapOutput)
	if strings.Contains(out.Text, "Two") {
		t.Fatalf("path=a mapped outside a:\n%s", out.Text)
	}

	raw, _ := json.Marshal(map[string]any{"path": "../.."})
	if _, err := repoMapTool(ws).Execute(context.Background(), raw); err == nil {
		t.Fatal("repo_map escaped the workspace root")
	}
}

func TestRepoMap_IsAReadAndThereforeParallelSafe(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{"a.go": "package p\n"})
	def := repoMapTool(ws)
	if def.Risk != RiskRead {
		t.Fatalf("Risk = %s, want read", def.Risk)
	}
	if def.Concurrency() != Parallel {
		t.Fatal("repo_map does not run in parallel despite having no side effects")
	}
}

/* ------------------------------------------------------------------ */
/* memory                                                              */
/* ------------------------------------------------------------------ */

func memoryToolset(t *testing.T) (map[string]Definition, *memory.Store) {
	t.Helper()
	store, err := memory.Open(t.TempDir(), "/w")
	if err != nil {
		t.Fatal(err)
	}
	defs := map[string]Definition{}
	for _, d := range memoryTools(store, "thread-1") {
		defs[d.Name] = d
	}
	return defs, store
}

func TestMemoryTools_WriteThenReadRoundTrip(t *testing.T) {
	defs, _ := memoryToolset(t)

	w := call(t, defs[NameMemoryWrite], map[string]any{
		"text": "the backend lives under backend-go", "tags": []string{"layout"},
	}).(MemoryWriteOutput)
	if w.ID == "" || w.Total != 1 {
		t.Fatalf("write output = %+v", w)
	}

	r := call(t, defs[NameMemoryRead], map[string]any{"query": "backend-go"}).(MemoryReadOutput)
	if len(r.Entries) != 1 {
		t.Fatalf("read returned %d entries", len(r.Entries))
	}

	f := call(t, defs[NameMemoryForget], map[string]any{"id": w.ID}).(MemoryForgetOutput)
	if !f.Removed || f.Total != 0 {
		t.Fatalf("forget output = %+v", f)
	}
}

// The one place the RiskSession argument deliberately does not carry over:
// a memory changes every future conversation and appears in no transcript.
func TestMemoryTools_WritesAreGatedButReadsAreNot(t *testing.T) {
	defs, _ := memoryToolset(t)

	if got := defs[NameMemoryWrite].Risk; got != RiskWrite {
		t.Fatalf("memory_write Risk = %s, want write -- a durable note is not session bookkeeping", got)
	}
	if !defs[NameMemoryWrite].Risk.Consequential() {
		t.Fatal("memory_write is not consequential; a wrong note is an invisible persistent bug")
	}
	if got := defs[NameMemoryForget].Risk; got != RiskWrite {
		t.Fatalf("memory_forget Risk = %s, want write", got)
	}
	if got := defs[NameMemoryRead].Risk; got != RiskRead {
		t.Fatalf("memory_read Risk = %s, want read", got)
	}
}

func TestMemoryTools_AreNotOfferedWithoutAStore(t *testing.T) {
	if got := memoryTools(nil, "thread"); got != nil {
		t.Fatalf("memoryTools(nil) returned %d tools", len(got))
	}
}

// The model must not be able to name a conversation: a tool that takes one
// can read another conversation's state by guessing an id.
func TestMemoryTools_DoNotExposeTheSessionAsAParameter(t *testing.T) {
	defs, _ := memoryToolset(t)
	for name, def := range defs {
		schema := string(def.ParametersSchema)
		for _, forbidden := range []string{"session", "thread", "conversation"} {
			if strings.Contains(strings.ToLower(schema), `"`+forbidden) {
				t.Errorf("%s exposes %q in its parameters: %s", name, forbidden, schema)
			}
		}
	}
}

func TestMemoryRead_DistinguishesNoNotesFromNoMatches(t *testing.T) {
	defs, _ := memoryToolset(t)
	empty := call(t, defs[NameMemoryRead], map[string]any{"query": "anything"}).(MemoryReadOutput)
	if empty.Notice != "" {
		t.Fatalf("an empty store produced a 'no match' notice: %q", empty.Notice)
	}

	_ = call(t, defs[NameMemoryWrite], map[string]any{"text": "we deploy on fridays"})
	missed := call(t, defs[NameMemoryRead], map[string]any{"query": "kubernetes"}).(MemoryReadOutput)
	if !strings.Contains(missed.Notice, "none about this") {
		t.Fatalf("Notice = %q, want it to say notes exist but none matched", missed.Notice)
	}
}

/* ------------------------------------------------------------------ */
/* Defaults wiring                                                     */
/* ------------------------------------------------------------------ */

func TestDefaults_OffersRepoMapWithAWorkspaceAndNotWithout(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{"a.go": "package p\n"})

	with := Defaults(Deps{Workspace: ws})
	if _, ok := FindByName(with, NameRepoMap); !ok {
		t.Fatal("repo_map missing with a workspace configured")
	}

	without := Defaults(Deps{})
	if _, ok := FindByName(without, NameRepoMap); ok {
		t.Fatal("repo_map offered with no workspace -- it would map the process working directory")
	}
}

func TestDefaults_OffersMemoryToolsOnlyWithAStore(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{"a.go": "package p\n"})
	store, _ := memory.Open(t.TempDir(), ws.Root())

	with := Defaults(Deps{Workspace: ws, Memory: store, SessionID: "t"})
	for _, name := range []string{NameMemoryWrite, NameMemoryRead, NameMemoryForget} {
		if _, ok := FindByName(with, name); !ok {
			t.Errorf("%s missing with a memory store configured", name)
		}
	}

	without := Defaults(Deps{Workspace: ws, SessionID: "t"})
	if _, ok := FindByName(without, NameMemoryWrite); ok {
		t.Fatal("memory_write offered with no store")
	}
}

// The whole point of the nil pool: a machine with no language server never
// hears about a tool that would fail on its first call.
func TestDefaults_DoesNotOfferLSPWithoutAPool(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{"a.go": "package p\n"})
	if _, ok := FindByName(Defaults(Deps{Workspace: ws}), NameLSP); ok {
		t.Fatal("lsp offered with a nil pool")
	}
}

// Every built-in must declare a risk; the zero value is restrictive but a
// tool sitting in it is an oversight, not a decision.
func TestDefaults_EveryNewToolDeclaresRisk(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{"a.go": "package p\n"})
	store, _ := memory.Open(t.TempDir(), ws.Root())
	for _, d := range Defaults(Deps{Workspace: ws, Todos: NewTodoStore(), SessionID: "t", Memory: store}) {
		if d.Risk == RiskUnclassified {
			t.Errorf("%s ships unclassified", d.Name)
		}
	}
}

/* ------------------------------------------------------------------ */
/* lsp position resolution (no server needed)                          */
/* ------------------------------------------------------------------ */

// The model gives a name because a name is what it knows; a column is what
// it would have to count.
func TestLocate_FindsASymbolAsAWholeWord(t *testing.T) {
	src := "package p\n\nfunc NewHandler() {}\n\nfunc New() {}\n"
	pos, err := locate(src, "New", 0)
	if err != nil {
		t.Fatal(err)
	}
	if pos.Line != 4 {
		t.Fatalf("locate(New) = line %d, want 4 -- it matched inside NewHandler", pos.Line)
	}
}

func TestLocate_PrefersAnExplicitLineWhenTheNameRepeats(t *testing.T) {
	src := "a := Thing{}\nb := Thing{}\nc := Thing{}\n"
	pos, err := locate(src, "Thing", 3)
	if err != nil {
		t.Fatal(err)
	}
	if pos.Line != 2 {
		t.Fatalf("line = %d, want 2 (0-based for line 3)", pos.Line)
	}
	if pos.Character != 5 {
		t.Fatalf("character = %d, want the symbol's column", pos.Character)
	}
}

func TestLocate_SaysSoWhenTheSymbolIsNotThere(t *testing.T) {
	if _, err := locate("package p\n", "Missing", 0); err == nil {
		t.Fatal("locate found a symbol that is not in the file")
	}
	if _, err := locate("package p\n", "", 0); err == nil {
		t.Fatal("locate accepted neither a symbol nor a line")
	}
	if _, err := locate("one\ntwo\n", "", 99); err == nil {
		t.Fatal("locate accepted a line past the end of the file")
	}
}

/* ------------------------------------------------------------------ */
/* toolkit filtering                                                   */
/* ------------------------------------------------------------------ */

// The bug this guards: the frontend always sends an explicit
// allowedAppDefaultToolkit, no UI ever put "todo" on it, and Filter
// therefore dropped the plan tools from every real request. They existed,
// their unit tests passed, and the model was never offered them.
func TestFilter_KeepsThePlanToolsRegardlessOfTheAllowlist(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{"a.go": "package p\n"})
	defs := Defaults(Deps{Workspace: ws, Todos: NewTodoStore(), SessionID: "t"})

	// Exactly what the frontend's default state sends.
	allowed := []string{"terminal", "visualization"}
	got := Filter(defs, &allowed, nil)

	for _, name := range []string{NameTodoWrite, NameTodoRead} {
		if _, ok := FindByName(got, name); !ok {
			t.Errorf("%s was filtered out by an allowlist that does not mention it", name)
		}
	}
}

// Memory deliberately is not exempt: a durable note that changes future
// conversations is a capability a user should be able to switch off.
func TestFilter_LetsTheUserTurnMemoryOff(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{"a.go": "package p\n"})
	store, _ := memory.Open(t.TempDir(), ws.Root())
	defs := Defaults(Deps{Workspace: ws, Memory: store, SessionID: "t"})

	off := []string{"file"}
	if _, ok := FindByName(Filter(defs, &off, nil), NameMemoryWrite); ok {
		t.Fatal("memory_write survived an allowlist that omits its toolkit")
	}

	on := []string{"file", ToolkitMemory}
	if _, ok := FindByName(Filter(defs, &on, nil), NameMemoryWrite); !ok {
		t.Fatal("memory_write missing from an allowlist that includes memory")
	}
}

// repo_map and lsp ride the file toolkit, so enabling files enables them.
func TestFilter_RepoMapRidesTheFileToolkit(t *testing.T) {
	ws := repoWorkspace(t, map[string]string{"a.go": "package p\n"})
	defs := Defaults(Deps{Workspace: ws})

	on := []string{"file"}
	if _, ok := FindByName(Filter(defs, &on, nil), NameRepoMap); !ok {
		t.Fatal("repo_map missing when the file toolkit is enabled")
	}
	off := []string{"visualization"}
	if _, ok := FindByName(Filter(defs, &off, nil), NameRepoMap); ok {
		t.Fatal("repo_map survived with the file toolkit disabled")
	}
}
