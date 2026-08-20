package meta_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"amiro/tests/harness"
)

type DocSourceEntry struct {
	Index    int
	Scope    string
	Path     string
	Writable bool
	Why      string
}

type CodeSourceEntry struct {
	Scope       string
	RelPath     string
	Source      string
	Writable    bool
	Description string
}

func parseDocSources(docPath string) ([]DocSourceEntry, error) {
	data, err := os.ReadFile(docPath)
	if err != nil {
		return nil, fmt.Errorf("reading doc %s: %w", docPath, err)
	}

	lines := strings.Split(string(data), "\n")
	tableRowRegex := regexp.MustCompile(`^\|\s*(\d+)\s*\|\s*(\w+)\s*\|\s*` + "`" + `([^` + "`" + `]+)` + "`" + `\s*\|\s*(\*\*yes\*\*|yes|no)\s*\|\s*(.*?)\s*\|$`)

	var entries []DocSourceEntry
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		matches := tableRowRegex.FindStringSubmatch(trimmed)
		if len(matches) == 6 {
			idx, _ := strconv.Atoi(matches[1])
			isWritable := strings.Contains(matches[4], "yes")
			entries = append(entries, DocSourceEntry{
				Index:    idx,
				Scope:    matches[2],
				Path:     matches[3],
				Writable: isWritable,
				Why:      matches[5],
			})
		}
	}

	return entries, nil
}

func parseCodeSources(sourcesGoPath string) ([]CodeSourceEntry, error) {
	src, err := os.ReadFile(sourcesGoPath)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", sourcesGoPath, err)
	}

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, sourcesGoPath, src, 0)
	if err != nil {
		return nil, fmt.Errorf("parsing %s: %w", sourcesGoPath, err)
	}

	var entries []CodeSourceEntry
	ast.Inspect(node, func(n ast.Node) bool {
		valSpec, ok := n.(*ast.ValueSpec)
		if !ok {
			return true
		}
		for i, name := range valSpec.Names {
			if name.Name == "Sources" && i < len(valSpec.Values) {
				cl, ok := valSpec.Values[i].(*ast.CompositeLit)
				if !ok {
					continue
				}
				for _, elt := range cl.Elts {
					compElt, ok := elt.(*ast.CompositeLit)
					if !ok {
						continue
					}
					var entry CodeSourceEntry
					for _, kv := range compElt.Elts {
						kvExpr, ok := kv.(*ast.KeyValueExpr)
						if !ok {
							continue
						}
						keyIdent, ok := kvExpr.Key.(*ast.Ident)
						if !ok {
							continue
						}
						switch keyIdent.Name {
						case "Scope":
							if scopeIdent, ok := kvExpr.Value.(*ast.Ident); ok {
								if scopeIdent.Name == "ScopeProject" {
									entry.Scope = "project"
								} else if scopeIdent.Name == "ScopeUser" {
									entry.Scope = "user"
								}
							}
						case "RelPath":
							if call, ok := kvExpr.Value.(*ast.CallExpr); ok {
								var parts []string
								for _, arg := range call.Args {
									if lit, ok := arg.(*ast.BasicLit); ok && lit.Kind == token.STRING {
										val, _ := strconv.Unquote(lit.Value)
										parts = append(parts, val)
									}
								}
								entry.RelPath = strings.Join(parts, "/")
							} else if lit, ok := kvExpr.Value.(*ast.BasicLit); ok && lit.Kind == token.STRING {
								entry.RelPath, _ = strconv.Unquote(lit.Value)
							}
						case "Source":
							if lit, ok := kvExpr.Value.(*ast.BasicLit); ok && lit.Kind == token.STRING {
								entry.Source, _ = strconv.Unquote(lit.Value)
							}
						case "Writable":
							if ident, ok := kvExpr.Value.(*ast.Ident); ok {
								entry.Writable = (ident.Name == "true")
							}
						case "Description":
							if lit, ok := kvExpr.Value.(*ast.BasicLit); ok && lit.Kind == token.STRING {
								entry.Description, _ = strconv.Unquote(lit.Value)
							}
						}
					}
					entries = append(entries, entry)
				}
			}
		}
		return true
	})

	return entries, nil
}

func compareSources(docEntries []DocSourceEntry, codeEntries []CodeSourceEntry) error {
	if len(docEntries) != 8 {
		return fmt.Errorf("doc has %d entries, want 8", len(docEntries))
	}
	if len(codeEntries) != 8 {
		return fmt.Errorf("code has %d entries, want 8", len(codeEntries))
	}

	for i := 0; i < 8; i++ {
		doc := docEntries[i]
		code := codeEntries[i]

		if doc.Scope != code.Scope {
			return fmt.Errorf("row %d scope mismatch: doc has %q, code has %q", i+1, doc.Scope, code.Scope)
		}
		if doc.Writable != code.Writable {
			return fmt.Errorf("row %d writable mismatch: doc has %v, code has %v", i+1, doc.Writable, code.Writable)
		}
		// Match path pattern (e.g. <project>/.agents/skills/ vs .agents/skills)
		expectedRel := strings.TrimPrefix(strings.TrimPrefix(doc.Path, "<project>/"), "~/")
		expectedRel = strings.TrimSuffix(expectedRel, "/")
		if code.RelPath != expectedRel {
			return fmt.Errorf("row %d relPath mismatch: doc has %q (rel %q), code has %q", i+1, doc.Path, expectedRel, code.RelPath)
		}
	}
	return nil
}

// TestSkillsSourcesGuard asserts that skills.Sources matches the 8-row table documented in
// docs/skills/01-discovery-and-precedence.md so that the doc and code cannot drift.
func TestSkillsSourcesGuard(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	docPath := filepath.Join(h.BaseDir, "..", "docs", "skills", "01-discovery-and-precedence.md")
	codePath := filepath.Join(h.BaseDir, "..", "backend-go", "internal", "skills", "sources.go")

	docEntries, err := parseDocSources(docPath)
	if err != nil {
		t.Fatalf("parseDocSources: %v", err)
	}

	codeEntries, err := parseCodeSources(codePath)
	if err != nil {
		t.Fatalf("parseCodeSources: %v", err)
	}

	if err := compareSources(docEntries, codeEntries); err != nil {
		t.Fatalf("sources table drift detected between doc and code: %v", err)
	}

	t.Logf("Verified all 8 scan root sources match between docs/skills/01-discovery-and-precedence.md and internal/skills/sources.go")
}

// TestSkillsSourcesGuard_IsNonVacuous proves that compareSources fails when either the doc or code is mutated.
func TestSkillsSourcesGuard_IsNonVacuous(t *testing.T) {
	validDoc := []DocSourceEntry{
		{Index: 1, Scope: "project", Path: "<project>/.agents/skills/", Writable: false},
		{Index: 2, Scope: "project", Path: "<project>/.amiro/skills/", Writable: false},
		{Index: 3, Scope: "project", Path: "<project>/.claude/skills/", Writable: false},
		{Index: 4, Scope: "project", Path: "<project>/.codex/skills/", Writable: false},
		{Index: 5, Scope: "user", Path: "~/.agents/skills/", Writable: true},
		{Index: 6, Scope: "user", Path: "~/.amiro/skills/", Writable: false},
		{Index: 7, Scope: "user", Path: "~/.claude/skills/", Writable: false},
		{Index: 8, Scope: "user", Path: "~/.codex/skills/", Writable: false},
	}

	validCode := []CodeSourceEntry{
		{Scope: "project", RelPath: ".agents/skills", Source: ".agents", Writable: false},
		{Scope: "project", RelPath: ".amiro/skills", Source: ".amiro", Writable: false},
		{Scope: "project", RelPath: ".claude/skills", Source: ".claude", Writable: false},
		{Scope: "project", RelPath: ".codex/skills", Source: ".codex", Writable: false},
		{Scope: "user", RelPath: ".agents/skills", Source: ".agents", Writable: true},
		{Scope: "user", RelPath: ".amiro/skills", Source: ".amiro", Writable: false},
		{Scope: "user", RelPath: ".claude/skills", Source: ".claude", Writable: false},
		{Scope: "user", RelPath: ".codex/skills", Source: ".codex", Writable: false},
	}

	if err := compareSources(validDoc, validCode); err != nil {
		t.Fatalf("expected valid match, got error: %v", err)
	}

	// Mutate count
	if err := compareSources(validDoc[:7], validCode); err == nil {
		t.Errorf("expected error for mismatched length, got nil")
	}

	// Mutate writable flag
	mutatedCode := make([]CodeSourceEntry, len(validCode))
	copy(mutatedCode, validCode)
	mutatedCode[4].Writable = false
	if err := compareSources(validDoc, mutatedCode); err == nil {
		t.Errorf("expected error for mutated writable flag on ~/.agents/skills/, got nil")
	}

	// Mutate scope
	mutatedScopeCode := make([]CodeSourceEntry, len(validCode))
	copy(mutatedScopeCode, validCode)
	mutatedScopeCode[0].Scope = "user"
	if err := compareSources(validDoc, mutatedScopeCode); err == nil {
		t.Errorf("expected error for mutated scope, got nil")
	}
}
