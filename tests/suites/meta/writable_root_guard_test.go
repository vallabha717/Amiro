package meta_test

// TestWritableRootGuard enforces that WriteSkillMD (the atomic skill writer)
// is only called from the three authorised methods in internal/skills/service.go.
// Any other caller — a handler, a test helper, a utility — is a violation of
// the containment invariant: writes must always go through the Service methods
// that run the containment check before touching the filesystem.
//
// The guard is structural (AST-level), not behavioural, so it catches a new
// caller even before the tests run.

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

// allowedWriteSkillMDCallers lists the (file, function) pairs that are
// permitted to call WriteSkillMD. The file names are relative to
// backend-go/internal/skills/.
var allowedWriteSkillMDCallers = map[string]bool{
	// service.go: Create, Update, Duplicate.
	// We record the file rather than the function because the AST walk
	// identifies the containing file, and all three live in service.go.
	"service.go": true,
}

// checkWriteSkillMDCalls inspects one parsed file for calls to WriteSkillMD.
// It returns a violation string for each call found in a file that is not
// on the allowlist.
func checkWriteSkillMDCalls(entryName string, node *ast.File) []string {
	var violations []string
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		// Match both direct calls WriteSkillMD(...) and selector calls
		// pkg.WriteSkillMD(...) / s.WriteSkillMD(...).
		var calleeName string
		switch fn := call.Fun.(type) {
		case *ast.Ident:
			calleeName = fn.Name
		case *ast.SelectorExpr:
			calleeName = fn.Sel.Name
		}
		if calleeName == "WriteSkillMD" {
			if !allowedWriteSkillMDCallers[entryName] {
				violations = append(violations, fmt.Sprintf(
					"%s must not call WriteSkillMD directly; only service.go (Create/Update/Duplicate) is allowed",
					entryName,
				))
			}
		}
		return true
	})
	return violations
}

func TestWritableRootGuard_WriteSkillMDCalledOnlyFromService(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	// Scan internal/skills/*.go and internal/api/skills/*.go.
	dirs := []string{
		filepath.Join(h.BaseDir, "..", "backend-go", "internal", "skills"),
		filepath.Join(h.BaseDir, "..", "backend-go", "internal", "api", "skills"),
	}

	fset := token.NewFileSet()
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("ReadDir %s: %v", dir, err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") {
				continue
			}
			filePath := filepath.Join(dir, entry.Name())
			node, err := parser.ParseFile(fset, filePath, nil, 0)
			if err != nil {
				t.Fatalf("ParseFile %s: %v", filePath, err)
			}
			violations := checkWriteSkillMDCalls(entry.Name(), node)
			for _, v := range violations {
				t.Errorf("writable-root guard violation in %s: %s", filePath, v)
			}
		}
	}
}

// TestWritableRootGuard_IsNonVacuous synthesises a hypothetical handler file
// that calls WriteSkillMD directly and verifies the guard rejects it, proving
// the allowlist is not simply accepting everything.
func TestWritableRootGuard_IsNonVacuous(t *testing.T) {
	// This fake file is NOT service.go, so it must be rejected.
	src := `package skills
func badHandler() {
	WriteSkillMD("/some/dir", []byte("content"))
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "bad_handler.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}
	violations := checkWriteSkillMDCalls("bad_handler.go", node)
	if len(violations) == 0 {
		t.Fatal("writable-root guard did not detect WriteSkillMD call in bad_handler.go — guard is vacuous")
	}
}
