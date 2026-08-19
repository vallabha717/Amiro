package meta_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/selector"
)

// TestNoTestImportsTheApplicationModule is the boundary guard.
//
// docs/testing/01-architecture.md planned a `replace amiro/backend =>
// ../backend-go` so the harness could reuse internal/ai/uimessage and
// internal/appwiring. That is impossible: Go forbids importing
// amiro/backend/internal/... from outside the tree rooted at backend-go.
// Both types are transcribed instead (harness/apiclient/stream.go,
// harness/backend/lock.go).
//
// The plan's Risks section anticipated the danger the `replace` created --
// "importing amiro/backend for two types is convenient and could become a
// habit of reaching into internals" -- and asked for exactly this guard.
// The language removed the risk for internal/ packages; this closes the
// remaining door, which is a NON-internal package appearing later and
// becoming the thin end of the same wedge.
func TestNoTestImportsTheApplicationModule(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	var offenders []string
	forEachGoFile(t, h.BaseDir, func(path string, file *ast.File, _ *token.FileSet) {
		for _, imp := range file.Imports {
			p, err := strconv.Unquote(imp.Path.Value)
			if err != nil {
				continue
			}
			if p == "amiro/backend" || strings.HasPrefix(p, "amiro/backend/") {
				rel, _ := filepath.Rel(h.BaseDir, path)
				offenders = append(offenders, rel+" imports "+p)
			}
		}
	})
	if len(offenders) > 0 {
		t.Fatalf("the test module must not depend on the application module:\n  %s\n\n"+
			"The test system talks to Amiro over HTTP, a PTY and a browser, exactly as a user does.\n"+
			"Anything needed from the app is transcribed, with a test that fails when the wire format drifts.",
			strings.Join(offenders, "\n  "))
	}
}

// TestSuitesDoNotImportEachOther keeps `harness/` the only shared code.
//
// A suite importing another suite is how a test tree acquires an order
// dependency that no amount of per-test isolation can fix: the shared helper
// starts carrying state, and two features stop being independently runnable.
// If two suites need the same helper, it belongs in harness/.
func TestSuitesDoNotImportEachOther(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	var offenders []string
	forEachGoFile(t, filepath.Join(h.BaseDir, "suites"), func(path string, file *ast.File, _ *token.FileSet) {
		self := filepath.Dir(path)
		for _, imp := range file.Imports {
			p, err := strconv.Unquote(imp.Path.Value)
			if err != nil || !strings.HasPrefix(p, "amiro/tests/suites/") {
				continue
			}
			imported := filepath.Join(h.BaseDir, strings.TrimPrefix(p, "amiro/tests/"))
			if imported == self {
				continue
			}
			rel, _ := filepath.Rel(h.BaseDir, path)
			offenders = append(offenders, rel+" imports "+p)
		}
	})
	if len(offenders) > 0 {
		t.Fatalf("suites must not import each other; shared code belongs in harness/:\n  %s",
			strings.Join(offenders, "\n  "))
	}
}

// TestSuitesDoNotSleep enforces the no-sleep rule.
//
// A sleep is a race that has been rounded up rather than removed: too short
// and it flakes, too long and the suite crawls, and either way it is not
// evidence that the thing being waited for happened. harness/assert's
// Eventually and harness/process's WaitFor are the sanctioned primitives,
// and they are the only places a sleep is legitimate -- they are what a
// deadline-bounded poll is built out of.
func TestSuitesDoNotSleep(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	// The polling primitives themselves, and nothing else.
	allowed := map[string]bool{
		filepath.Join("harness", "assert"):  true,
		filepath.Join("harness", "process"): true,
	}

	var offenders []string
	for _, root := range []string{"suites", "harness", "cmd"} {
		dir := filepath.Join(h.BaseDir, root)
		forEachGoFile(t, dir, func(path string, file *ast.File, fset *token.FileSet) {
			rel, _ := filepath.Rel(h.BaseDir, path)
			if allowed[filepath.Dir(rel)] {
				return
			}
			ast.Inspect(file, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "Sleep" {
					return true
				}
				pkg, ok := sel.X.(*ast.Ident)
				if !ok || pkg.Name != "time" {
					return true
				}
				offenders = append(offenders, fmt.Sprintf("%s:%d", rel, fset.Position(call.Pos()).Line))
				return true
			})
		})
	}
	if len(offenders) > 0 {
		t.Fatalf("time.Sleep is not allowed outside harness/assert and harness/process:\n  %s\n\n"+
			"Use assert.Eventually(t, what, within, cond) or process.WaitFor -- both poll with a\n"+
			"deadline and report the LAST observed state on timeout, which a sleep cannot.",
			strings.Join(offenders, "\n  "))
	}
}

// TestEveryTestAddressIsUnique guards the addressing scheme.
//
// The address surface/feature/name is what selection, artifact directories
// and the summary all key on. Two tests sharing one would share an artifact
// directory and overwrite each other's evidence -- and the second result
// would silently replace the first in the summary.
func TestEveryTestAddressIsUnique(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	cat, err := selector.Discover(h.BaseDir)
	if err != nil {
		t.Fatalf("discovering suites: %v", err)
	}
	seen := map[string]string{}
	for _, f := range cat.Features {
		for _, name := range f.Tests {
			addr := f.Address(name)
			if prev, dup := seen[addr]; dup {
				t.Errorf("duplicate test address %q (in %s and %s)", addr, prev, f.Dir)
			}
			seen[addr] = f.Dir
		}
	}
	if len(seen) == 0 {
		t.Fatal("no test addresses were discovered at all; selection would silently match nothing")
	}
	t.Logf("%d unique addresses across %d features", len(seen), len(cat.Features))
}

// forEachGoFile parses every non-vendored .go file under root.
func forEachGoFile(t *testing.T, root string, fn func(path string, file *ast.File, fset *token.FileSet)) {
	t.Helper()
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", "logs", "testdata", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		file, parseErr := parser.ParseFile(fset, path, nil, parser.ImportsOnly|parser.SkipObjectResolution)
		if parseErr != nil {
			return nil
		}
		// ImportsOnly stops at the import block, which is all the import
		// guards need. The sleep guard needs bodies, so it reparses -- done
		// here rather than always, because parsing every body of every file
		// twice for two guards that only want imports is wasted work.
		full, parseErr := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if parseErr == nil {
			file = full
		}
		fn(path, file, fset)
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
}
