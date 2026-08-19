package security_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"amiro/tests/harness"
)

// debugish are the substrings that mark a route as a debug, profiling or
// developer affordance. Matched case-insensitively against the registered
// pattern.
var debugish = []string{
	"/debug", "pprof", "expvar", "/__", "/dev/", "/devtools",
	"/internal/", "/_internal", "/admin/debug", "/metrics/debug",
	"/test/", "/testing", "/dump", "/goroutine", "/heap", "/trace",
}

// TestSecurity_NoDebugRouteExistsInTheRouteTable is the static half of the
// phase document's "No debug or dev-only endpoint reachable in a release
// build".
//
// A live probe (the sibling test below) can only check paths somebody
// thought to guess, which is exactly the wrong shape for this question --
// the dangerous route is the one nobody remembered. So the primary
// assertion reads the route table itself, the same way
// suites/meta/route_coverage_test.go does, and checks every registered
// pattern rather than a list of guesses.
//
// It also checks the two things that could make a route table lie:
// build-tagged files under httpserver/ or middleware/ (a route that exists
// only in some builds), and any import of net/http/pprof or expvar
// anywhere in the application module (both register handlers on
// http.DefaultServeMux as an import side effect, so an import alone is
// enough to expose them if anything ever serves that mux).
func TestSecurity_NoDebugRouteExistsInTheRouteTable(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	appModule := filepath.Join(h.RepoRoot, "backend-go")
	routerPath := filepath.Join(appModule, "internal", "httpserver", "router.go")

	patterns := routePatterns(t, routerPath)
	if len(patterns) < 50 {
		t.Fatalf("parsed only %d routes out of %s; the parser is not seeing the route table, so this "+
			"guard would pass on anything", len(patterns), routerPath)
	}
	t.Logf("parsed %d registered routes from %s", len(patterns), routerPath)

	var offenders []string
	for _, p := range patterns {
		lower := strings.ToLower(p)
		for _, marker := range debugish {
			if strings.Contains(lower, marker) {
				offenders = append(offenders, p+" (matches "+marker+")")
			}
		}
	}
	if len(offenders) > 0 {
		t.Errorf("the route table registers debug/dev-shaped routes:\n  %s", strings.Join(offenders, "\n  "))
	}

	// A route registered only under a build tag would not be visible above
	// on the tag that happens to be in effect.
	for _, dir := range []string{
		filepath.Join(appModule, "internal", "httpserver"),
		filepath.Join(appModule, "internal", "middleware"),
		filepath.Join(appModule, "cmd", "server"),
	} {
		for _, file := range buildTaggedFiles(t, dir) {
			rel, _ := filepath.Rel(appModule, file)
			t.Errorf("%s is build-tagged. Routing and guards must not vary by build tag, or the route "+
				"table above describes only one of the binaries that ship.", rel)
		}
	}

	// net/http/pprof and expvar both register on http.DefaultServeMux from
	// their init functions, so importing either is enough.
	for _, banned := range []string{"net/http/pprof", "expvar"} {
		if files := importersOf(t, appModule, banned); len(files) > 0 {
			t.Errorf("the application module imports %q in:\n  %s\n"+
				"Both packages register handlers on http.DefaultServeMux as an import side effect.",
				banned, strings.Join(files, "\n  "))
		}
	}
}

// debugPaths are the paths a release build must not answer.
var debugPaths = []string{
	"/debug/pprof/", "/debug/pprof/goroutine", "/debug/pprof/heap",
	"/debug/pprof/profile", "/debug/pprof/trace", "/debug/pprof/cmdline",
	"/debug/vars", "/debug/requests", "/debug",
	"/metrics", "/__debug", "/__internal", "/_dev",
	"/api/debug", "/api/internal", "/api/dev", "/api/admin/debug",
	"/api/test", "/dump", "/goroutines", "/healthz/debug",
}

// TestSecurity_NoDebugPathAnswersOnAReleaseBuild is the live half.
//
// "Release build" is `go build -tags embedui`, which is what
// scripts/build-ui.sh prints as the command that produces a shippable
// binary:
//
//	cd backend-go && go build -tags embedui -o bin/amiro-server ./cmd/server
//
// That distinction is load-bearing here rather than pedantic: with the tag
// the dashboard bundle is compiled in and cmd/server registers the "/"
// catch-all, so a debug path is handled by the dashboard's own not-found
// page. The tag is therefore the build in which "is a debug endpoint
// reachable?" is actually being asked of what users run.
//
// The control at the end is what makes the 404s mean something: a route
// that DOES exist answers 200 through the same client, so a server that
// 404'd everything (wrong token, wrong port, dead process) cannot pass.
func TestSecurity_NoDebugPathAnswersOnAReleaseBuild(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"), harness.BuildTags("embedui"))
	be := h.Backend()
	client := &http.Client{}

	probe := func(path string) (int, string) {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, be.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		be.Authorize(req)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("GET %s against a release (-tags embedui) build: %v", path, err)
		}
		defer resp.Body.Close()
		buf := make([]byte, 512)
		n, _ := resp.Body.Read(buf)
		return resp.StatusCode, string(buf[:n])
	}

	for _, p := range debugPaths {
		status, body := probe(p)
		if status != http.StatusNotFound {
			t.Errorf("GET %s on a release build returned %d, want 404\nbody: %s",
				p, status, strings.TrimSpace(body))
		}
	}

	// The control.
	if status, body := probe("/health"); status != http.StatusOK {
		t.Fatalf("GET /health returned %d, want 200 -- the 404s above may just mean this client could "+
			"not reach the server at all\nbody: %s", status, strings.TrimSpace(body))
	}
	// A second control: the dashboard itself IS served here, which is what
	// makes this the release build and not the untagged one.
	if status, _ := probe("/"); status != http.StatusOK {
		t.Fatalf("GET / returned %d on what should be an embedui build; the debug probes above ran "+
			"against a binary with no dashboard, which is not the build under test", status)
	}

	// And the same question of the OTHER binary that ships: `amiro serve`
	// is a different entrypoint with its own options, so a debug
	// affordance could exist there and nowhere else. --no-ui leaves
	// httpserver.Options.UI a genuine nil interface, so "/" is never
	// registered and the mux answers 404 itself.
	served := startServe(t, h, "release-probe", "127.0.0.1")
	for _, p := range []string{"/debug/pprof/", "/debug/vars", "/metrics", "/__debug"} {
		resp, err := httpGet(served.URL+p, map[string]string{"X-Amiro-Token": served.Token})
		if err != nil {
			t.Fatalf("GET %s against `amiro serve`: %v", p, err)
		}
		status := resp.StatusCode
		_ = resp.Body.Close()
		if status != http.StatusNotFound {
			t.Errorf("GET %s against `amiro serve` returned %d, want 404", p, status)
		}
	}
}

// TestSecurity_TheUntaggedBuildStillExposesNoDebugEndpoint asks the same
// question of the OTHER build shape -- a plain `go build ./cmd/server`
// with no tags, which is what scripts/dev-backend.sh runs and what every
// other suite in this repository spawns.
//
// It found a real defect, recorded here rather than fixed because this
// suite owns tests/ and not backend-go/.
//
// FINDING: on an untagged build, ANY path that is not under /api/,
// /storage/ or /health panics the handler and drops the connection.
// cmd/server/main.go does `uiHandler, hasUI := web.New()`, and web.New
// returns a TYPED nil (*web.Handler)(nil) together with false
// (backend-go/internal/web/web.go). Assigning that typed nil to
// httpserver.Options.UI, whose type is the http.Handler INTERFACE, makes
// `opts.UI != nil` true -- so router.go registers `mux.Handle("/",
// apiAware(opts.UI))` even though there is no dashboard, and the first
// request to reach it dereferences a nil receiver in
// (*web.Handler).ServeHTTP. net/http recovers the panic per connection, so
// the client sees an EOF rather than a status.
//
// Severity in context: the panic is behind middleware.RequireToken, so a
// caller needs the shared secret to trigger it, and the shipped build
// (-tags embedui) is unaffected because its UI handler is real. It is
// still a nil-pointer panic on a mistyped URL, and the phase document's
// resilience bar is "never a hang, never a panic".
//
// Closing step, one line in cmd/server/main.go:
//
//	uiHandler, hasUI := web.New()
//	opts := httpserver.Options{BrowserAuth: hasUI, LoopbackOriginWildcard: true}
//	if hasUI { opts.UI = uiHandler }
//
// The security question this test exists to answer is unaffected and is
// asserted below: no debug path is REACHABLE on an untagged build either.
// A dropped connection is not a debug endpoint answering.
func TestSecurity_TheUntaggedBuildStillExposesNoDebugEndpoint(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	var dropped []string
	for _, p := range debugPaths {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, be.URL+p, nil)
		if err != nil {
			t.Fatal(err)
		}
		be.Authorize(req)
		resp, err := (&http.Client{}).Do(req)
		if err != nil {
			// No status at all: nothing answered, which is not a reachable
			// endpoint. Recorded, and explained in the doc comment above.
			dropped = append(dropped, p)
			continue
		}
		status := resp.StatusCode
		_ = resp.Body.Close()
		if status >= 200 && status < 300 {
			t.Errorf("CRITICAL: GET %s answered %d on an untagged build -- a debug endpoint is reachable",
				p, status)
		} else if status != http.StatusNotFound {
			t.Errorf("GET %s answered %d on an untagged build, want 404", p, status)
		}
	}

	// The control: a real route still answers, so the drops above are
	// about those paths and not about an unreachable server.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, be.URL+"/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	be.Authorize(req)
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	status := resp.StatusCode
	_ = resp.Body.Close()
	if status != http.StatusOK {
		t.Fatalf("GET /health returned %d, want 200", status)
	}

	if len(dropped) > 0 {
		t.Logf("FINDING (recorded, not a failure of the debug-endpoint question): %d untagged-build paths "+
			"dropped the connection instead of answering 404: %s\n"+
			"Cause and one-line fix are in this test's doc comment: cmd/server/main.go assigns a TYPED nil "+
			"*web.Handler to httpserver.Options.UI (an http.Handler interface), so router.go registers the "+
			"\"/\" catch-all and (*web.Handler).ServeHTTP panics on a nil receiver. The shipped "+
			"-tags embedui build is unaffected.", len(dropped), strings.Join(dropped, ", "))
	} else {
		t.Log("every untagged-build debug path answered 404 cleanly -- the typed-nil UI handler defect " +
			"recorded in this test's doc comment has been fixed; the FINDING branch can be removed")
	}
}

// routePatterns extracts every string literal passed as the first argument
// to mux.Handle / mux.HandleFunc in the given file.
func routePatterns(t *testing.T, path string) []string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
	var out []string
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || len(call.Args) == 0 {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || (sel.Sel.Name != "Handle" && sel.Sel.Name != "HandleFunc") {
			return true
		}
		lit, ok := call.Args[0].(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		pattern, err := strconv.Unquote(lit.Value)
		if err != nil {
			return true
		}
		out = append(out, pattern)
		return true
	})
	return out
}

// buildTaggedFiles returns every .go file in dir carrying a //go:build line.
func buildTaggedFiles(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("reading %s: %v", dir, err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		// Only the header matters; a //go:build line has to precede the
		// package clause.
		head, _, _ := strings.Cut(string(data), "\npackage ")
		if strings.Contains(head, "//go:build") {
			out = append(out, path)
		}
	}
	return out
}

// importersOf returns every .go file under root importing the named package.
func importersOf(t *testing.T, root, pkg string) []string {
	t.Helper()
	fset := token.NewFileSet()
	var out []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", ".git", "testdata", "dist", "target":
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
		for _, imp := range file.Imports {
			p, unquoteErr := strconv.Unquote(imp.Path.Value)
			if unquoteErr == nil && p == pkg {
				rel, _ := filepath.Rel(root, path)
				out = append(out, rel)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	return out
}
