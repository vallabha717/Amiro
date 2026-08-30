// Guards docs/coding-agent-parity/phases/phase-01-checkpoints-and-rewind.md's
// meta requirement: checkpoint capture never writes outside the workspace
// root. The structural invariant this enforces is narrower and more
// checkable than "never escapes the root" directly (that is
// workspace.Resolve's job, already guarded by its own tests) -- it is "the
// checkpoint package's raw filesystem *writes* live in exactly one place",
// restore.go, which is the only file that ever calls ws.Resolve and then
// acts on the result. capture.go only ever reads (os.Stat, os.ReadFile) to
// build a pre-image; if it ever grows a raw write call, that write did not
// go through the same resolve-then-act discipline restore.go's own review
// already covers, and is worth catching at build time.
package meta_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
)

// checkpointRawWriteFuncs are the os package functions that touch the
// filesystem destructively or create/replace a file -- the operations a
// checkpoint restore legitimately needs (write the blob back, delete a
// file that didn't exist before) and capture.go never should.
var checkpointRawWriteFuncs = map[string]bool{
	"WriteFile": true,
	"Remove":    true,
	"RemoveAll": true,
	"Create":    true,
	"OpenFile":  true,
	"Mkdir":     true,
	"MkdirAll":  true,
	"Rename":    true,
}

// allowedCheckpointWriters is the strict allowlist of files in
// internal/agent/checkpoint permitted to call any of the above.
var allowedCheckpointWriters = map[string]bool{
	"restore.go": true,
}

// checkCheckpointWrites reports every raw os.* write call in node that
// entryName is not allowlisted for.
func checkCheckpointWrites(entryName string, node *ast.File) []string {
	var violations []string
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		pkgIdent, ok := sel.X.(*ast.Ident)
		if !ok || pkgIdent.Name != "os" {
			return true
		}
		if !checkpointRawWriteFuncs[sel.Sel.Name] {
			return true
		}
		if !allowedCheckpointWriters[entryName] {
			violations = append(violations, fmt.Sprintf(
				"%s calls os.%s -- only restore.go may perform a raw filesystem write in this "+
					"package, and only after resolving the path through workspace.Resolve",
				entryName, sel.Sel.Name))
		}
		return true
	})
	return violations
}

// TestCheckpointGuard_OnlyRestoreWritesToDisk walks
// backend-go/internal/agent/checkpoint -- the whole package, not just
// capture.go, so a future file added to this package is covered
// automatically rather than requiring the guard to be remembered and
// updated.
func TestCheckpointGuard_OnlyRestoreWritesToDisk(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	dir := filepath.Join(h.BaseDir, "..", "backend-go", "internal", "agent", "checkpoint")

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir %s: %v", dir, err)
	}

	fset := token.NewFileSet()
	scanned := 0
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), "_test.go") || !strings.HasSuffix(entry.Name(), ".go") {
			continue
		}
		scanned++
		filePath := filepath.Join(dir, entry.Name())
		node, perr := parser.ParseFile(fset, filePath, nil, 0)
		if perr != nil {
			t.Fatalf("ParseFile %s: %v", filePath, perr)
		}
		for _, v := range checkCheckpointWrites(entry.Name(), node) {
			t.Errorf("%s: %s", filePath, v)
		}
	}
	if scanned == 0 {
		t.Fatal("no source files found in internal/agent/checkpoint -- guard is vacuous")
	}
}

// TestCheckpointGuard_IsNonVacuous proves the guard actually catches a
// bypass: a synthetic capture.go that writes directly must be flagged.
func TestCheckpointGuard_IsNonVacuous(t *testing.T) {
	src := `package checkpoint
func bypass(abs string, data []byte) {
	os.WriteFile(abs, data, 0o644)
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "capture.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}

	violations := checkCheckpointWrites("capture.go", node)
	if len(violations) == 0 {
		t.Fatal("expected the guard to flag a raw os.WriteFile call in capture.go, but got none")
	}
}

// TestCheckpointGuard_RestoreStillPasses is the converse sanity check: the
// allowlisted file must not be flagged for the exact writes it legitimately
// performs.
func TestCheckpointGuard_RestoreStillPasses(t *testing.T) {
	src := `package checkpoint
func apply(abs string, data []byte) {
	os.WriteFile(abs, data, 0o644)
	os.Remove(abs)
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "restore.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}

	violations := checkCheckpointWrites("restore.go", node)
	if len(violations) != 0 {
		t.Fatalf("restore.go is allowlisted but was flagged: %v", violations)
	}
}
