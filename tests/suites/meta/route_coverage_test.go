package meta_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"amiro/tests/harness"
)

type WaiverEntry struct {
	Method  string `yaml:"method"`
	Pattern string `yaml:"pattern"`
	Owner   string `yaml:"owner"`
	Reason  string `yaml:"reason"`
}

type WaiversFile struct {
	Waivers []WaiverEntry `yaml:"waivers"`
}

type Route struct {
	Method  string
	Pattern string
}

func (r Route) String() string {
	if r.Method == "" {
		return r.Pattern
	}
	return r.Method + " " + r.Pattern
}

// parseRoutesFromRouter reads backend-go/internal/httpserver/router.go and extracts
// all mux.Handle and mux.HandleFunc registrations.
func parseRoutesFromRouter(t *testing.T, routerPath string) []Route {
	t.Helper()
	src, err := os.ReadFile(routerPath)
	if err != nil {
		t.Fatalf("reading router.go: %v", err)
	}

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, routerPath, src, 0)
	if err != nil {
		t.Fatalf("parsing router.go: %v", err)
	}

	var routes []Route
	ast.Inspect(node, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if sel.Sel.Name != "Handle" && sel.Sel.Name != "HandleFunc" {
			return true
		}
		if len(call.Args) < 1 {
			return true
		}
		lit, ok := call.Args[0].(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		val, err := strconv.Unquote(lit.Value)
		if err != nil {
			return true
		}
		parts := strings.SplitN(val, " ", 2)
		if len(parts) == 2 {
			routes = append(routes, Route{Method: parts[0], Pattern: parts[1]})
		} else {
			routes = append(routes, Route{Method: "", Pattern: parts[0]})
		}
		return true
	})

	if len(routes) == 0 {
		t.Fatalf("parsed 0 routes from %s; parser failed", routerPath)
	}
	return routes
}

// loadWaivers loads and validates waivers.yaml.
func loadWaivers(t *testing.T, path string) map[string]WaiverEntry {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}

	var file WaiversFile
	if err := yaml.Unmarshal(data, &file); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}

	waiverMap := make(map[string]WaiverEntry, len(file.Waivers))
	for _, w := range file.Waivers {
		if w.Method == "" || w.Pattern == "" || w.Owner == "" || w.Reason == "" {
			t.Fatalf("waiver entry missing required field: %+v", w)
		}
		key := w.Method + " " + w.Pattern
		waiverMap[key] = w
	}
	return waiverMap
}

// scanExercisedPatterns scans all Go source files under suites/backend/ and harness/apiclient/
// to extract route patterns and HTTP paths tested or transcribed.
func scanExercisedPatterns(t *testing.T, baseDir string) map[string]bool {
	t.Helper()
	exercised := make(map[string]bool)

	dirsToScan := []string{
		filepath.Join(baseDir, "suites", "backend"),
		filepath.Join(baseDir, "harness", "apiclient"),
	}

	for _, dir := range dirsToScan {
		_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || !strings.HasSuffix(p, ".go") {
				return nil
			}
			fset := token.NewFileSet()
			fileNode, parseErr := parser.ParseFile(fset, p, nil, 0)
			if parseErr != nil {
				return nil
			}

			ast.Inspect(fileNode, func(n ast.Node) bool {
				path := resolvePathExpr(n)
				if path != "" && (strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/storage") || strings.HasPrefix(path, "/health")) {
					if idx := strings.Index(path, "?"); idx != -1 {
						path = path[:idx]
					}
					exercised[path] = true
				}
				return true
			})
			return nil
		})
	}
	return exercised
}

func resolvePathExpr(node ast.Node) string {
	switch n := node.(type) {
	case *ast.BasicLit:
		if n.Kind == token.STRING {
			val, err := strconv.Unquote(n.Value)
			if err == nil {
				return val
			}
		}
	case *ast.BinaryExpr:
		if n.Op == token.ADD {
			x := resolvePathExpr(n.X)
			y := resolvePathExpr(n.Y)
			if x != "" && y != "" {
				return x + y
			}
		}
	case *ast.CallExpr:
		ident, isIdent := n.Fun.(*ast.Ident)
		if isIdent && ident.Name == "join" && len(n.Args) > 0 {
			first := resolvePathExpr(n.Args[0])
			if first != "" {
				var segs []string
				segs = append(segs, strings.TrimPrefix(first, "/"))
				for _, arg := range n.Args[1:] {
					part := resolvePathExpr(arg)
					if part != "" {
						segs = append(segs, strings.TrimPrefix(part, "/"))
					} else {
						segs = append(segs, "{param}")
					}
				}
				return "/" + strings.Join(segs, "/")
			}
		}
	}
	return ""
}

func routeMatches(route Route, exercised map[string]bool) bool {
	// Root fallback route "/" is exercised in matrix MethodPathAndCORS
	if route.Pattern == "/" {
		return true
	}

	// Exact match
	if exercised[route.Pattern] {
		return true
	}

	// Build exact regex for parameterized routes:
	// e.g. "/api/mcp/servers/{id}" -> "^/api/mcp/servers/[^/]+$"
	// "/storage/{token...}" -> "^/storage/.+$"
	pat := regexp.QuoteMeta(route.Pattern)
	reParamRest := regexp.MustCompile(`\\{[^}]+\\\.\\\.\\\.\\}`)
	pat = reParamRest.ReplaceAllString(pat, `.+`)
	reParam := regexp.MustCompile(`\\{[^}]+\\}`)
	pat = reParam.ReplaceAllString(pat, `[^/]+`)
	reg, err := regexp.Compile("^" + pat + "$")
	if err != nil {
		return false
	}

	for ex := range exercised {
		if reg.MatchString(ex) {
			return true
		}
	}
	return false
}

// TestRouteCoverageGuard enforces 100% route coverage across router.go or explicit waivers.
func TestRouteCoverageGuard(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	repoRoot := filepath.Dir(h.BaseDir)
	routerPath := filepath.Join(repoRoot, "backend-go", "internal", "httpserver", "router.go")
	waiversPath := filepath.Join(h.BaseDir, "suites", "meta", "waivers.yaml")

	routes := parseRoutesFromRouter(t, routerPath)
	waivers := loadWaivers(t, waiversPath)
	exercised := scanExercisedPatterns(t, h.BaseDir)

	var uncovered []string
	var coveredCount int
	var waivedCount int

	routeKeyMap := make(map[string]bool)

	for _, r := range routes {
		key := r.String()
		routeKeyMap[key] = true

		if _, ok := waivers[key]; ok {
			waivedCount++
			continue
		}

		if routeMatches(r, exercised) {
			coveredCount++
		} else {
			uncovered = append(uncovered, key)
		}
	}

	// Verify no phantom waivers exist for nonexistent routes
	for wKey, w := range waivers {
		if !routeKeyMap[wKey] {
			t.Errorf("waiver %q in %s does not match any route in router.go", wKey, waiversPath)
		}
		if w.Reason == "" || w.Owner == "" {
			t.Errorf("waiver %q must have non-empty owner and reason", wKey)
		}
	}

	if len(uncovered) > 0 {
		t.Fatalf("route coverage guard failed: %d routes in router.go are uncovered and not waived:\n  - %s\n\n"+
			"Every route must be tested in suites/backend/ or explicitly waived with rationale in suites/meta/waivers.yaml.",
			len(uncovered), strings.Join(uncovered, "\n  - "))
	}

	t.Logf("Route coverage: %d total routes in router.go (%d covered, %d waived, 0 uncovered)",
		len(routes), coveredCount, waivedCount)
}
