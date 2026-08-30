// Guards docs/coding-agent-parity/phases/phase-03-git-remote-operations.md's
// meta requirement: git push and create_pr are the only two
// tools.Definitions that ever set AlwaysAsk, the predicate that overrides
// Auto mode's "runs everything without asking" rule and the
// Interactive/Edit RiskExternal allow-without-asking carve-out (see
// docs/coding-agent-parity/04-git-remote-operations.md). A future tool
// that starts setting RiskExternal alone, expecting to be silently allowed
// the way every MCP tool is, is a deliberate, considered choice -- but a
// tool that sets AlwaysAsk without anyone noticing is exactly the "slipped
// through" case this phase exists to prevent, and this guard exists to
// catch that at the source level, not by trusting every future PR to
// remember to look here.
//
// Structural (AST-level), like this package's other guards
// (checkpoint_guard_test.go, sandbox_guard_test.go,
// terminal_sandbox_guard_test.go) -- it does not run the Go code (this
// module cannot import amiro/backend/internal/... at all, see this
// package's own README), it reads the source text.
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

// allowedAlwaysAskFiles is the strict allowlist of internal/ai/tools/*.go
// files permitted to set Definition.AlwaysAsk. git.go's gitTool sets it
// for push only (see that file's gitAlwaysAsk); github.go's createPRTool
// sets it unconditionally. No other file has any business setting it.
var allowedAlwaysAskFiles = map[string]bool{
	"git.go":    true,
	"github.go": true,
}

// fileSetsAlwaysAsk reports whether node contains a struct literal field
// named AlwaysAsk anywhere.
func fileSetsAlwaysAsk(node *ast.File) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		if kv, ok := n.(*ast.KeyValueExpr); ok {
			if id, ok := kv.Key.(*ast.Ident); ok && id.Name == "AlwaysAsk" {
				found = true
			}
		}
		return true
	})
	return found
}

// checkAlwaysAskUsage returns a violation if entryName sets AlwaysAsk
// (anywhere in a struct literal) without being on the allowlist.
func checkAlwaysAskUsage(entryName string, node *ast.File) []string {
	if !fileSetsAlwaysAsk(node) || allowedAlwaysAskFiles[entryName] {
		return nil
	}
	return []string{fmt.Sprintf(
		"%s sets Definition.AlwaysAsk -- only git.go (push) and github.go (create_pr) may; "+
			"AlwaysAsk overrides Auto mode and the RiskExternal allow-without-asking carve-out, "+
			"see docs/coding-agent-parity/04-git-remote-operations.md",
		entryName)}
}

func TestAlwaysAskGuard_OnlyGitAndCreatePRSetIt(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	toolsDir := filepath.Join(h.BaseDir, "..", "backend-go", "internal", "ai", "tools")
	entries, err := os.ReadDir(toolsDir)
	if err != nil {
		t.Fatalf("ReadDir %s: %v", toolsDir, err)
	}

	fset := token.NewFileSet()
	found := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), "_test.go") || !strings.HasSuffix(entry.Name(), ".go") {
			continue
		}
		filePath := filepath.Join(toolsDir, entry.Name())
		node, err := parser.ParseFile(fset, filePath, nil, 0)
		if err != nil {
			t.Fatalf("ParseFile %s: %v", filePath, err)
		}

		if violations := checkAlwaysAskUsage(entry.Name(), node); len(violations) > 0 {
			t.Errorf("AlwaysAsk violations in %s: %v", entry.Name(), violations)
		}
		if fileSetsAlwaysAsk(node) {
			found[entry.Name()] = true
		}
	}

	// The allowlist itself must be exact, not just an upper bound -- a
	// stale entry (a file that used to set AlwaysAsk but no longer does)
	// would hide a real removal from anyone reading this guard as
	// documentation of what's gated.
	for file := range allowedAlwaysAskFiles {
		if !found[file] {
			t.Errorf("%s is allowlisted to set AlwaysAsk but does not actually set it -- the allowlist is stale", file)
		}
	}
}

// TestAlwaysAskGuard_IsNonVacuous proves the guard actually catches a new,
// unlisted file that sets AlwaysAsk -- the same shape as
// TestSandboxGuard_IsNonVacuous and TestWritableRootGuard's own
// self-check.
func TestAlwaysAskGuard_IsNonVacuous(t *testing.T) {
	src := `package tools
func rogueTool() Definition {
	return Definition{
		Name: "rogue",
		AlwaysAsk: func(json.RawMessage) bool { return true },
	}
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "rogue.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}

	violations := checkAlwaysAskUsage("rogue.go", node)
	if len(violations) == 0 {
		t.Fatal("expected the AlwaysAsk guard to flag rogue.go, but got no violations")
	}
}
