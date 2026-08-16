package lsp

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests need a real language server and skip without one.
//
// They are a supplement, never the coverage. client_test.go's fake server
// is what actually proves the protocol layer works, precisely so that a
// machine (or a CI runner) without gopls still tests it. What a skipping
// test can honestly add is the half a fake cannot: that the handshake this
// code sends is one a real server accepts, and that its replies decode.
// Those are exactly the things a fake written from the same understanding
// as the implementation would confirm whether or not they were true.
func goplsWorkspace(t *testing.T) (*Server, string) {
	t.Helper()
	if _, ok := lookPath("gopls"); !ok {
		t.Skip("gopls not installed; the fake-server tests cover the protocol")
	}

	root := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("go.mod", "module example.com/probe\n\ngo 1.22\n")
	write("lib.go", `package probe

// Target is what the tests ask about.
func Target() int { return 1 }

func callerOne() int { return Target() }
`)
	write("other.go", `package probe

func callerTwo() int { return Target() + Target() }
`)

	bin, _ := lookPath("gopls")
	server, err := Start(context.Background(), "go", root, []string{bin})
	if err != nil {
		t.Skipf("gopls did not start: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server, root
}

// The operation grep genuinely cannot do: distinguish a reference to this
// symbol from an unrelated identifier that happens to share its name.
func TestGopls_FindsReferencesAcrossFiles(t *testing.T) {
	server, root := goplsWorkspace(t)

	locs, err := server.References(context.Background(),
		filepath.Join(root, "lib.go"), Position{Line: 3, Character: 5}, false)
	if err != nil {
		t.Fatalf("References: %v", err)
	}
	if len(locs) < 3 {
		t.Fatalf("found %d references to Target, want at least 3 (one in lib.go, two in other.go): %+v", len(locs), locs)
	}

	sawOther := false
	for _, l := range locs {
		if filepath.Base(URIToPath(l.URI)) == "other.go" {
			sawOther = true
		}
	}
	if !sawOther {
		t.Fatal("no reference found in other.go; cross-file references are the point")
	}
}

func TestGopls_ResolvesADefinition(t *testing.T) {
	server, root := goplsWorkspace(t)

	// The call site in other.go, pointing at Target. The column is computed
	// rather than counted by hand: a hand-counted one that lands inside
	// `return` produces a plausible-looking wrong answer instead of a
	// failure, which is the worst way for a test like this to be wrong.
	src, err := os.ReadFile(filepath.Join(root, "other.go"))
	if err != nil {
		t.Fatal(err)
	}
	callSite := strings.Split(string(src), "\n")[2]
	locs, err := server.Definition(context.Background(),
		filepath.Join(root, "other.go"),
		Position{Line: 2, Character: strings.Index(callSite, "Target")})
	if err != nil {
		t.Fatalf("Definition: %v", err)
	}
	if len(locs) == 0 {
		t.Fatal("no definition found")
	}
	if got := filepath.Base(URIToPath(locs[0].URI)); got != "lib.go" {
		t.Fatalf("definition is in %s, want lib.go", got)
	}
	if locs[0].Range.Start.Line != 3 {
		t.Fatalf("definition at line %d (0-based), want 3", locs[0].Range.Start.Line)
	}
}

func TestGopls_ListsDocumentSymbols(t *testing.T) {
	server, root := goplsWorkspace(t)

	syms, err := server.Symbols(context.Background(), filepath.Join(root, "lib.go"))
	if err != nil {
		t.Fatalf("Symbols: %v", err)
	}
	found := false
	for _, s := range syms {
		if s.Name == "Target" {
			found = true
		}
	}
	if !found {
		t.Fatalf("Target missing from document symbols: %+v", syms)
	}
}

// The distinction the whole diagnostics operation rests on: an empty list
// with received=false is "not analysed yet", not "clean".
func TestGopls_ReportsRealDiagnostics(t *testing.T) {
	server, root := goplsWorkspace(t)

	broken := filepath.Join(root, "broken.go")
	if err := os.WriteFile(broken, []byte("package probe\n\nfunc Bad() int { return \"not an int\" }\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	diags, received, err := server.Diagnostics(context.Background(), broken)
	if err != nil {
		t.Fatalf("Diagnostics: %v", err)
	}
	if !received {
		t.Skip("gopls did not report within the wait window; timing-dependent, not a failure of the code")
	}
	if len(diags) == 0 {
		t.Fatal("no diagnostics for a file that does not type-check")
	}
	if diags[0].Severity != 1 {
		t.Errorf("severity = %d, want 1 (error)", diags[0].Severity)
	}
}

func TestPool_OffersNothingForALanguageWithNoMarker(t *testing.T) {
	// An empty directory: no go.mod, no package.json, nothing. Even with
	// every language server on the machine installed, the pool must be nil
	// -- otherwise a stray file spawns a server for a language the
	// repository does not use.
	if pool := NewPool(t.TempDir()); pool != nil {
		t.Fatalf("NewPool on a directory with no root markers returned %v", pool.Languages())
	}
}

func TestPool_ReturnsNilForAnUnhandledExtension(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pool := NewPool(root)
	if pool == nil {
		t.Skip("no language server installed for Go")
	}
	server, err := pool.For(context.Background(), filepath.Join(root, "notes.md"))
	if err != nil {
		t.Fatalf("For: %v", err)
	}
	if server != nil {
		t.Fatal("got a server for a .md file")
	}
	pool.Close()
}

// The layout this repository actually has: package.json at the top,
// go.mod one level down. A root-only marker check found no Go project and
// the tool silently never appeared -- the "not offered rather than broken"
// design failing by accident rather than by choice.
func TestFindMarker_ReachesAMonorepoSubdirectory(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "backend-go")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	at, ok := findMarker(root, []string{"go.mod", "go.work"})
	if !ok {
		t.Fatal("go.mod in a subdirectory was not found")
	}
	// The directory, not the workspace root: gopls rooted at a repo whose
	// module is one level down answers nothing useful.
	if at != sub {
		t.Fatalf("findMarker = %q, want %q", at, sub)
	}
}

func TestFindMarker_IgnoresDependencyTrees(t *testing.T) {
	root := t.TempDir()
	dep := filepath.Join(root, "node_modules", "some-pkg")
	if err := os.MkdirAll(dep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dep, "package.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if at, ok := findMarker(root, []string{"package.json"}); ok {
		t.Fatalf("found a marker inside node_modules: %s", at)
	}
}

func TestFindMarker_StopsAtItsDepthLimit(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, "go.mod"), []byte("module x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if at, ok := findMarker(root, []string{"go.mod"}); ok {
		t.Fatalf("searched past the depth limit and found %s", at)
	}
}
