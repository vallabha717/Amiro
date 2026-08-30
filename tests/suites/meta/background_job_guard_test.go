// Guards docs/coding-agent-parity/phases/phase-04-background-agent-runs.md's
// meta requirement: a background job's mode is always "edit" or "auto" at
// creation -- never "plan" or "interactive", both of which are meaningless
// unattended (see docs/coding-agent-parity/05-background-agent-runs.md's
// "A job creation request is restricted to Edit or Auto at creation time")
// -- and job creation always checks the Phase 0 trust grant before
// starting the worker goroutine, never after.
//
// Structural (AST/source-level), like this package's other guards
// (always_ask_guard_test.go, checkpoint_guard_test.go,
// sandbox_guard_test.go) -- this module cannot import
// amiro/backend/internal/... at all (see this package's own README), so it
// reads the source text of internal/api/backgroundjob/handler.go rather
// than calling the code.
package meta_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"

	"amiro/tests/harness"
)

// findFunc returns the *ast.FuncDecl named name, declared on a pointer
// receiver (every method in this handler is), or nil.
func findFunc(node *ast.File, name string) *ast.FuncDecl {
	for _, decl := range node.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != name {
			continue
		}
		return fn
	}
	return nil
}

// containsIdent reports whether node's subtree references a selector
// expression "<pkg>.<name>" anywhere (e.g. permission.ModeEdit).
func containsSelector(node ast.Node, pkg, name string) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		id, ok := sel.X.(*ast.Ident)
		if ok && id.Name == pkg && sel.Sel.Name == name {
			found = true
		}
		return true
	})
	return found
}

// firstCallOffset returns the source byte offset of the first call
// expression anywhere in node whose selector matches "<recv>.<method>"
// (e.g. "trust.IsTrustedForTurn"), or -1 if none is found. Byte offset
// (not statement nesting) is enough to answer "which of these two calls
// does the source put first" -- Go source position increases
// monotonically with location, and the ordering claim this guard checks
// ("trust is checked before the worker starts") does not depend on which
// block either call sits in, only on which one a reader hits first.
func firstCallOffset(fset *token.FileSet, node ast.Node, recv, method string) int {
	offset := -1
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != method {
			return true
		}
		recvIdent, ok := sel.X.(*ast.SelectorExpr)
		var recvName string
		if ok {
			// h.trust.IsTrustedForTurn -- sel.X is itself "h.trust".
			recvName = recvIdent.Sel.Name
		} else if id, ok := sel.X.(*ast.Ident); ok {
			recvName = id.Name
		}
		if recvName != recv {
			return true
		}
		pos := fset.Position(call.Pos()).Offset
		if offset == -1 || pos < offset {
			offset = pos
		}
		return true
	})
	return offset
}

func TestBackgroundJobGuard_CreateOnlyAllowsEditOrAutoMode(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	filePath := filepath.Join(h.BaseDir, "..", "backend-go", "internal", "api", "backgroundjob", "handler.go")

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, filePath, nil, 0)
	if err != nil {
		t.Fatalf("ParseFile %s: %v", filePath, err)
	}

	create := findFunc(node, "Create")
	if create == nil {
		t.Fatalf("no Create function found in %s -- has it been renamed?", filePath)
	}

	if !containsSelector(create, "permission", "ModeEdit") || !containsSelector(create, "permission", "ModeAuto") {
		t.Error("Create does not reference both permission.ModeEdit and permission.ModeAuto -- " +
			"a background job must be creatable in exactly those two modes")
	}
	if containsSelector(create, "permission", "ModePlan") || containsSelector(create, "permission", "ModeInteractive") {
		t.Error("Create references permission.ModePlan or permission.ModeInteractive -- " +
			"a background job may never be created in either: Plan produces nothing to run " +
			"unattended, and Interactive would suspend on the first write with no one watching " +
			"(docs/coding-agent-parity/05-background-agent-runs.md)")
	}
}

func TestBackgroundJobGuard_CreateChecksTrustBeforeStartingTheWorker(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	filePath := filepath.Join(h.BaseDir, "..", "backend-go", "internal", "api", "backgroundjob", "handler.go")

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, filePath, nil, 0)
	if err != nil {
		t.Fatalf("ParseFile %s: %v", filePath, err)
	}

	create := findFunc(node, "Create")
	if create == nil {
		t.Fatalf("no Create function found in %s -- has it been renamed?", filePath)
	}

	trustOffset := firstCallOffset(fset, create, "trust", "IsTrustedForTurn")
	if trustOffset == -1 {
		t.Fatal("Create never calls h.trust.IsTrustedForTurn -- " +
			"there is no such thing as starting a background run against an ungranted root " +
			"(docs/coding-agent-parity/05-background-agent-runs.md)")
	}

	startOffset := firstCallOffset(fset, create, "worker", "Start")
	if startOffset == -1 {
		t.Fatal("Create never calls h.worker.Start -- has job creation stopped starting a worker?")
	}

	if trustOffset >= startOffset {
		t.Errorf("h.worker.Start (offset %d) appears at or before h.trust.IsTrustedForTurn (offset %d) "+
			"in Create -- the trust grant must be checked BEFORE the worker goroutine starts, never after "+
			"or concurrently with it", startOffset, trustOffset)
	}
}

// TestBackgroundJobGuard_IsNonVacuous proves the two guards above would
// actually catch a violation, the same way always_ask_guard_test.go's own
// non-vacuity test works: synthesize a source string with the ordering
// reversed and confirm the offset check flags it.
func TestBackgroundJobGuard_IsNonVacuous(t *testing.T) {
	src := `package backgroundjob

func (h *Handler) Create() {
	h.worker.Start(job, user)
	h.trust.IsTrustedForTurn(ctx, userID, root, defaultRoot)
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "rogue.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}
	create := findFunc(node, "Create")
	if create == nil {
		t.Fatal("synthesized source has no Create func -- test is broken")
	}
	trustOffset := firstCallOffset(fset, create, "trust", "IsTrustedForTurn")
	startOffset := firstCallOffset(fset, create, "worker", "Start")
	if trustOffset == -1 || startOffset == -1 {
		t.Fatalf("firstCallOffset did not find both calls in the synthesized source: trust=%d start=%d", trustOffset, startOffset)
	}
	if trustOffset < startOffset {
		t.Fatal("the guard's ordering check did not flag a reversed-order Create -- it is vacuous")
	}
}

// modeGuardIsNonVacuous is folded into the same non-vacuity spirit: a
// Create that references ModePlan should be flagged.
func TestBackgroundJobGuard_ModeCheckIsNonVacuous(t *testing.T) {
	src := `package backgroundjob

import "amiro/backend/internal/agent/permission"

func (h *Handler) Create() {
	_ = permission.ModePlan
}
`
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "rogue.go", src, 0)
	if err != nil {
		t.Fatalf("ParseFile: %v", err)
	}
	create := findFunc(node, "Create")
	if create == nil {
		t.Fatal("synthesized source has no Create func -- test is broken")
	}
	if !containsSelector(create, "permission", "ModePlan") {
		t.Fatal("containsSelector did not find permission.ModePlan in the synthesized source -- the guard is vacuous")
	}
}
