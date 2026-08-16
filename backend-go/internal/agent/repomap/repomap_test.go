package repomap

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	abs := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func build(t *testing.T, root string, opts ...func(*Options)) *Map {
	t.Helper()
	o := Options{Root: root}
	for _, f := range opts {
		f(&o)
	}
	m, err := Build(context.Background(), o)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return m
}

func TestBuild_ExtractsGoDeclarationsWithReceivers(t *testing.T) {
	root := t.TempDir()
	write(t, root, "store.go", `package store

type Store struct{ n int }

const MaxItems = 10

var ErrMissing = errors.New("missing")

func New() *Store { return &Store{} }

func (s *Store) Put(k string) error { return nil }
`)

	m := build(t, root)
	if len(m.Files) != 1 {
		t.Fatalf("Files = %d, want 1", len(m.Files))
	}

	got := map[string]string{}
	for _, s := range m.Files[0].Symbols {
		got[s.Name] = s.Kind
	}
	want := map[string]string{
		"Store": "type", "MaxItems": "const", "ErrMissing": "var",
		"New": "func", "Store.Put": "method",
	}
	for name, kind := range want {
		if got[name] != kind {
			t.Errorf("symbol %q: kind %q, want %q (got all: %v)", name, got[name], kind, got)
		}
	}
}

// A qualified method name is the point: forty unqualified `Get`s in a map
// say nothing about what they are on.
func TestBuild_QualifiesMethodsByReceiver(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.go", "package a\ntype Writer struct{}\nfunc (w *Writer) Flush() {}\n")
	m := build(t, root)
	for _, s := range m.Files[0].Symbols {
		if s.Kind == "method" && s.Name != "Writer.Flush" {
			t.Fatalf("method name = %q, want Writer.Flush", s.Name)
		}
	}
}

// A file mid-edit is exactly when a map is most useful, so a parse failure
// must degrade to the pattern extractor rather than to nothing.
func TestBuild_FallsBackToPatternsWhenGoDoesNotParse(t *testing.T) {
	root := t.TempDir()
	write(t, root, "broken.go", "package broken\n\nfunc Alpha() {\n\nfunc Beta() {}\n")

	m := build(t, root)
	if len(m.Files) == 0 {
		t.Fatal("an unparseable Go file produced no map entry at all")
	}
	var names []string
	for _, s := range m.Files[0].Symbols {
		names = append(names, s.Name)
	}
	joined := strings.Join(names, ",")
	if !strings.Contains(joined, "Alpha") {
		t.Fatalf("symbols = %v, want the pattern extractor to still find Alpha", names)
	}
}

func TestBuild_ExtractsTypeScriptAndPython(t *testing.T) {
	root := t.TempDir()
	write(t, root, "api.ts", `export interface User { id: string }
export type Role = "admin" | "user";
export class Client {}
export function login(u: User) {}
export const useAuth = () => {};
`)
	write(t, root, "svc.py", `class Service:
    def handle(self):
        pass

async def main():
    pass
`)

	m := build(t, root)
	found := map[string]bool{}
	for _, f := range m.Files {
		for _, s := range f.Symbols {
			found[s.Name] = true
		}
	}
	for _, want := range []string{"User", "Role", "Client", "login", "useAuth", "Service", "handle", "main"} {
		if !found[want] {
			t.Errorf("missing symbol %q; found %v", want, keys(found))
		}
	}
}

// Anchoring is what keeps the map trustworthy. A phantom symbol sends the
// reader to a file that does not contain what they were promised, which is
// worse than a missing one.
func TestExtract_IgnoresDeclarationKeywordsInsideComments(t *testing.T) {
	syms := extractByPattern("python", []byte("# def not_a_function():\nx = 1  # class NotAClass:\n"))
	for _, s := range syms {
		if s.Name == "not_a_function" || s.Name == "NotAClass" {
			t.Fatalf("matched a keyword inside a comment: %v", syms)
		}
	}
}

// PageRank, not a reference count. `helper.go` is referenced by every file
// once; `core.go` is referenced by the file everything else depends on.
func TestBuild_RanksByDependenceNotJustMentionCount(t *testing.T) {
	root := t.TempDir()
	write(t, root, "core.go", "package p\nfunc CoreEngine() {}\n")
	write(t, root, "hub.go", "package p\nfunc HubDispatch() { CoreEngine(); CoreEngine(); CoreEngine() }\n")
	for _, name := range []string{"a.go", "b.go", "c.go", "d.go"} {
		write(t, root, name, "package p\nfunc "+strings.ToUpper(name[:1])+"Leaf() { HubDispatch() }\n")
	}

	m := build(t, root)
	rank := map[string]float64{}
	for _, f := range m.Files {
		rank[f.Path] = f.Rank
	}
	if rank["core.go"] <= rank["a.go"] {
		t.Fatalf("core.go rank %.4f should beat a leaf's %.4f", rank["core.go"], rank["a.go"])
	}
	if m.Files[0].Path != "core.go" && m.Files[0].Path != "hub.go" {
		t.Fatalf("top-ranked file is %q, want core.go or hub.go", m.Files[0].Path)
	}
}

// An unfocused map of a big repo is dominated by whatever everything
// imports, which is true and useless when the question was about auth.
func TestBuild_FocusBiasesRankingTowardTheAskedAboutArea(t *testing.T) {
	root := t.TempDir()
	write(t, root, "util/strings.go", "package util\nfunc Trim() {}\n")
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		write(t, root, n+".go", "package p\nimport \"util\"\nfunc "+strings.ToUpper(n)+"() { util.Trim() }\n")
	}
	write(t, root, "auth/login.go", "package auth\nfunc Login() {}\n")

	plain := build(t, root)
	focused := build(t, root, func(o *Options) { o.Focus = []string{"auth"} })

	rankIn := func(m *Map, path string) int {
		for i, f := range m.Files {
			if f.Path == path {
				return i
			}
		}
		return -1
	}
	before, after := rankIn(plain, "auth/login.go"), rankIn(focused, "auth/login.go")
	if after >= before {
		t.Fatalf("auth/login.go ranked %d unfocused and %d with focus=auth; focus did not move it up", before, after)
	}
}

func TestBuild_SkipsDependencyAndBuildDirectories(t *testing.T) {
	root := t.TempDir()
	write(t, root, "main.go", "package main\nfunc main() {}\n")
	write(t, root, "node_modules/dep/index.js", "export function shouldNotAppear() {}\n")
	write(t, root, "vendor/x/y.go", "package x\nfunc AlsoNotThis() {}\n")

	m := build(t, root)
	for _, f := range m.Files {
		if strings.Contains(f.Path, "node_modules") || strings.Contains(f.Path, "vendor") {
			t.Fatalf("mapped a dependency directory: %s", f.Path)
		}
	}
}

func TestBuild_HonoursTheInjectedSkipFunction(t *testing.T) {
	root := t.TempDir()
	write(t, root, "keep.go", "package p\nfunc Keep() {}\n")
	write(t, root, "generated/api.go", "package p\nfunc Generated() {}\n")

	m := build(t, root, func(o *Options) {
		o.Skip = func(rel string, isDir bool) bool { return strings.HasPrefix(rel, "generated") }
	})
	for _, f := range m.Files {
		if strings.HasPrefix(f.Path, "generated") {
			t.Fatalf("Skip was ignored: %s is in the map", f.Path)
		}
	}
}

func TestRender_StaysWithinBudgetAndSaysWhatItCut(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 40; i++ {
		name := string(rune('a'+i%26)) + string(rune('a'+i/26)) + ".go"
		write(t, root, name, "package p\nfunc Fn"+name[:2]+"() {}\ntype T"+name[:2]+" struct{}\n")
	}

	m := build(t, root)
	const budget = 600
	out := m.Render(budget)
	if len(out) > budget+200 {
		t.Fatalf("rendered %d chars for a %d budget", len(out), budget)
	}
	if !strings.Contains(out, "omitted") {
		t.Fatalf("cut files without saying so:\n%s", out)
	}
}

// Cut by importance, display in source order: a list that jumps around the
// file is harder to scan than one that follows it.
func TestRender_ListsSymbolsInSourceOrder(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.go", "package p\nfunc First() {}\nfunc Second() {}\nfunc Third() {}\n")
	out := build(t, root).Render(0)

	iFirst := strings.Index(out, "First")
	iSecond := strings.Index(out, "Second")
	iThird := strings.Index(out, "Third")
	if !(iFirst < iSecond && iSecond < iThird) {
		t.Fatalf("symbols not in source order:\n%s", out)
	}
}

// "37 files" and "37 files, 1200 skipped" describe very different
// repositories, and the model must not read the first as the second.
func TestRender_ReportsSkippedFiles(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.go", "package p\nfunc A() {}\n")
	write(t, root, "notes.txt", "hello")
	write(t, root, "data.bin", "\x00\x01\x02")

	m := build(t, root)
	if m.Skipped == 0 {
		t.Fatal("Skipped = 0 with two unsupported files present")
	}
	if !strings.Contains(m.Render(0), "skipped") {
		t.Fatal("the rendered map does not mention skipped files")
	}
}

func TestRender_EmptyRepoSaysSoRatherThanReturningNothing(t *testing.T) {
	m := build(t, t.TempDir())
	if out := m.Render(0); !strings.Contains(out, "No source files") {
		t.Fatalf("Render on an empty repo = %q", out)
	}
}

func TestBuild_RespectsContextCancellation(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 50; i++ {
		write(t, root, filepath.Join("d", string(rune('a'+i%26))+".go"), "package p\nfunc F() {}\n")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Build(ctx, Options{Root: root}); err == nil {
		t.Fatal("Build ignored a cancelled context")
	}
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// A map that opens with four _test.go files has answered "what is this
// repo about" with "testing".
func TestBuild_DemotesTestFilesWithoutHidingThem(t *testing.T) {
	root := t.TempDir()
	write(t, root, "engine.go", "package p\nfunc Engine() {}\n")
	// The test file references Engine heavily, which is exactly what makes
	// it rank high on the raw graph.
	write(t, root, "engine_test.go", "package p\nfunc TestEngine(t *testing.T) { Engine(); Engine(); Engine() }\n")

	m := build(t, root)
	if m.Files[0].Path != "engine.go" {
		t.Fatalf("top file is %q, want engine.go", m.Files[0].Path)
	}

	// Still present: "where are the tests for X" is a real question.
	found := false
	for _, f := range m.Files {
		if f.Path == "engine_test.go" {
			found = true
		}
	}
	if !found {
		t.Fatal("engine_test.go was excluded; demoting is not the same as hiding")
	}
}

func TestIsTestFile_RecognisesTheUsualConventions(t *testing.T) {
	yes := []string{
		"internal/x/foo_test.go", "src/thing.test.ts", "src/thing.spec.tsx",
		"tests/helpers.py", "app/__tests__/render.js", "pkg/testdata/x.go",
		"api/test_client.py",
	}
	no := []string{"internal/x/foo.go", "src/latest.ts", "src/contest.go", "lib/protest/a.go"}

	for _, p := range yes {
		if !isTestFile(p) {
			t.Errorf("isTestFile(%q) = false", p)
		}
	}
	for _, p := range no {
		if isTestFile(p) {
			t.Errorf("isTestFile(%q) = true", p)
		}
	}
}
