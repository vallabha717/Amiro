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

// allowedReadableCallers is the strict allowlist of tool files permitted
// to call ws.ResolveReadable or ws.RelReadable. Any other tool file calling
// either method violates the sandbox invariant.
var allowedReadableCallers = map[string]bool{
	"files.go":   true,
	"search.go":  true,
	"repomap.go": true,
}

// checkASTSandbox verifies that only allowlisted read tools call ws.ResolveReadable / ws.RelReadable.
func checkToolFileSandbox(entryName string, node *ast.File) []string {
	var violations []string

	ast.Inspect(node, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok {
			if sel.Sel.Name == "ResolveReadable" || sel.Sel.Name == "RelReadable" {
				if !allowedReadableCallers[entryName] {
					violations = append(violations, fmt.Sprintf("%s must not call %s (only files.go, search.go, and repomap.go are allowed to resolve read-only roots)", entryName, sel.Sel.Name))
				}
			}
		}
		return true
	})

	return violations
}

func TestSandboxGuard_ModifyingToolsNeverUseResolveReadable(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	toolsDir := filepath.Join(h.BaseDir, "..", "backend-go", "internal", "ai", "tools")
	entries, err := os.ReadDir(toolsDir)
	if err != nil {
		t.Fatalf("ReadDir %s: %v", toolsDir, err)
	}

	fset := token.NewFileSet()
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), "_test.go") || !strings.HasSuffix(entry.Name(), ".go") {
			continue
		}
		filePath := filepath.Join(toolsDir, entry.Name())
		node, err := parser.ParseFile(fset, filePath, nil, 0)
		if err != nil {
			t.Fatalf("ParseFile %s: %v", filePath, err)
		}

		violations := checkToolFileSandbox(entry.Name(), node)
		if len(violations) > 0 {
			t.Errorf("sandbox violations in %s: %v", entry.Name(), violations)
		}
	}
}

func TestSandboxGuard_IsNonVacuous(t *testing.T) {
	// Synthesize a new, hypothetical tool file (delete.go) calling ResolveReadable.
	// The allowlist must reject it even though delete.go was not a known legacy filename.
	srcBadTool := `package tools
func runDelete(ws *workspace.Workspace, path string) {
	ws.ResolveReadable(path)
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "delete.go", srcBadTool, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}

	violations := checkToolFileSandbox("delete.go", node)
	if len(violations) == 0 {
		t.Fatal("expected sandbox guard to detect ResolveReadable in delete.go, but got none")
	}
}
