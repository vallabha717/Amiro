// Guards docs/coding-agent-parity/phases/phase-02-sandboxed-execution.md's
// meta requirement: terminal.go's only call path to a subprocess is
// through internal/agent/sandbox's Run/Command, not a direct
// exec.Command/exec.CommandContext. The structural invariant this enforces
// is what makes the sandboxed/unsandboxed status terminal.go reports
// trustworthy at all -- a stray direct exec.Command call would spawn a
// process sandbox.Detect() never wrapped, and no result field would ever
// reveal it. Same AST-guard shape as
// tests/suites/meta/writable_root_guard_test.go and this repo's
// checkpoint_guard_test.go (this file is deliberately named
// terminal_sandbox_guard_test.go, not sandbox_guard_test.go -- that name
// is already taken by an unrelated, pre-existing guard over
// ws.ResolveReadable in this same package).
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

// forbiddenExecFuncs are the os/exec entry points that spawn a process
// directly, bypassing sandbox.Command/sandbox.Run's wrap step entirely.
// exec.LookPath is deliberately not included -- it only resolves a binary
// path (terminal.go uses it to pick a shell), it never starts anything.
var forbiddenExecFuncs = map[string]bool{
	"Command":        true,
	"CommandContext": true,
}

// checkTerminalExecCalls reports every direct exec.Command/CommandContext
// call in node.
func checkTerminalExecCalls(entryName string, node *ast.File) []string {
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
		if !ok || pkgIdent.Name != "exec" {
			return true
		}
		if !forbiddenExecFuncs[sel.Sel.Name] {
			return true
		}
		violations = append(violations, fmt.Sprintf(
			"%s calls exec.%s directly -- terminal.go's only subprocess call path must be "+
				"internal/agent/sandbox.Run or sandbox.Command, so every run_shell result's "+
				"Sandboxed/SandboxBackend fields stay honest",
			entryName, sel.Sel.Name))
		return true
	})
	return violations
}

// TestTerminalSandboxGuard_OnlyCallsSubprocessesThroughSandbox walks every
// non-test .go file in internal/ai/tools whose name starts with
// "terminal" -- terminal.go itself, plus any future terminal_*.go split
// out of it -- rather than hardcoding one filename, so a refactor that
// moves code within the package doesn't silently widen what this guard
// covers.
func TestTerminalSandboxGuard_OnlyCallsSubprocessesThroughSandbox(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	dir := filepath.Join(h.BaseDir, "..", "backend-go", "internal", "ai", "tools")

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir %s: %v", dir, err)
	}

	fset := token.NewFileSet()
	scanned := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, "terminal") || !strings.HasSuffix(name, ".go") ||
			strings.HasSuffix(name, "_test.go") {
			continue
		}
		scanned++
		filePath := filepath.Join(dir, name)
		node, err := parser.ParseFile(fset, filePath, nil, 0)
		if err != nil {
			t.Fatalf("ParseFile %s: %v", filePath, err)
		}
		for _, violation := range checkTerminalExecCalls(name, node) {
			t.Errorf("sandbox guard violation in %s: %s", filePath, violation)
		}
	}
	if scanned == 0 {
		t.Fatal("scanned zero terminal*.go files -- guard is vacuous (directory moved or renamed?)")
	}
}

// TestTerminalSandboxGuard_IsNonVacuous synthesises a hypothetical file
// that calls exec.Command directly and verifies the guard rejects it,
// proving the check isn't accidentally matching nothing.
func TestTerminalSandboxGuard_IsNonVacuous(t *testing.T) {
	src := `package tools

import "os/exec"

func badRun() {
	cmd := exec.Command("sh", "-c", "echo hi")
	_ = cmd
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "terminal_bad.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}
	violations := checkTerminalExecCalls("terminal_bad.go", node)
	if len(violations) == 0 {
		t.Fatal("sandbox guard did not detect a direct exec.Command call -- guard is vacuous")
	}
}

// TestTerminalSandboxGuard_RealFilesPassCleanToday proves the guard
// doesn't just work in synthetic examples: run against the real
// terminal.go and terminal_sandbox_test.go's own sibling files in this
// checkout right now, it reports zero violations -- the exact state the
// build-order step 2 change ("terminal.go calls through sandbox.Run
// instead of the direct os/exec call") was supposed to leave behind.
func TestTerminalSandboxGuard_RealFilesPassCleanToday(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	dir := filepath.Join(h.BaseDir, "..", "backend-go", "internal", "ai", "tools")
	path := filepath.Join(dir, "terminal.go")

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatalf("ParseFile %s: %v", path, err)
	}
	violations := checkTerminalExecCalls("terminal.go", node)
	if len(violations) != 0 {
		t.Fatalf("terminal.go has %d sandbox guard violation(s): %v", len(violations), violations)
	}
}
