// Guards docs/coding-agent-parity/phases/phase-00-workspace-trust-and-rules.md's
// meta requirement: every RiskWrite/RiskExec/RiskExternal tool call path
// goes through the Trusted check -- no code may construct its own
// permission.Engine and skip the resolution runner.go performs (see
// runner.go's own comment on WithTrust / IsTrustedForTurn). The only
// correctness backstop that matters here is structural: if a second
// construction site exists, it either duplicates that resolution (a
// maintenance hazard the next change will get out of sync) or omits it (a
// silent bypass) -- both are worth catching at build time, not in review.
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

// allowedPermissionEngineConstructors is the strict allowlist of files
// permitted to call permission.New. runner.go is the real turn path, where
// Trusted is resolved via WorkspaceTrustRepository.IsTrustedForTurn before
// construction; eval_agent.go is the offline eval harness, which never
// serves a real request and deliberately starts every engine pre-trusted
// (permission.New's own default) since there is no human to prompt.
var allowedPermissionEngineConstructors = map[string]bool{
	"runner.go":     true,
	"eval_agent.go": true,
}

// checkPermissionEngineConstruction reports every permission.New(...) call
// in node that entryName is not allowlisted for.
func checkPermissionEngineConstruction(entryName string, node *ast.File) []string {
	var violations []string
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "New" {
			return true
		}
		pkgIdent, ok := sel.X.(*ast.Ident)
		if !ok || pkgIdent.Name != "permission" {
			return true
		}
		if !allowedPermissionEngineConstructors[entryName] {
			violations = append(violations, fmt.Sprintf(
				"%s calls permission.New directly -- only runner.go and eval_agent.go may; "+
					"every other caller must receive an *Engine that already went through "+
					"WorkspaceTrustRepository.IsTrustedForTurn, not build its own", entryName))
		}
		return true
	})
	return violations
}

// TestWorkspaceTrustGuard_OnlyAllowlistedFilesConstructThePermissionEngine
// walks the whole backend-go/internal tree (not just internal/api/chat):
// the invariant this protects is "nowhere in the backend", and scoping the
// walk to one package would silently stop covering a future construction
// site added somewhere else.
func TestWorkspaceTrustGuard_OnlyAllowlistedFilesConstructThePermissionEngine(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	internalDir := filepath.Join(h.BaseDir, "..", "backend-go", "internal")

	fset := token.NewFileSet()
	err := filepath.WalkDir(internalDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		// permission's own package: New is defined here, not called.
		if filepath.Base(filepath.Dir(path)) == "permission" {
			return nil
		}

		node, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			return fmt.Errorf("ParseFile %s: %w", path, perr)
		}
		for _, v := range checkPermissionEngineConstruction(name, node) {
			t.Errorf("%s: %s", path, v)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", internalDir, err)
	}
}

// TestWorkspaceTrustGuard_IsNonVacuous proves the guard actually catches a
// bypass, the same shape TestSandboxGuard_IsNonVacuous already uses for
// its own AST guard: synthesize a file NOT on the allowlist that
// constructs an engine directly, and confirm it's flagged.
func TestWorkspaceTrustGuard_IsNonVacuous(t *testing.T) {
	src := `package chat
func bypassTrust(mode permission.Mode) *permission.Engine {
	return permission.New(mode, nil, nil, nil)
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "shortcut.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}

	violations := checkPermissionEngineConstruction("shortcut.go", node)
	if len(violations) == 0 {
		t.Fatal("expected the guard to flag a non-allowlisted permission.New call, but got none")
	}
}

// TestWorkspaceTrustGuard_AllowlistedFilesStillPass is the converse sanity
// check: the allowlist itself must not accidentally flag its own members.
func TestWorkspaceTrustGuard_AllowlistedFilesStillPass(t *testing.T) {
	src := `package chat
func newEngine(mode permission.Mode) *permission.Engine {
	return permission.New(mode, nil, nil, nil)
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "runner.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}

	violations := checkPermissionEngineConstruction("runner.go", node)
	if len(violations) != 0 {
		t.Fatalf("runner.go is allowlisted but was flagged: %v", violations)
	}
}
