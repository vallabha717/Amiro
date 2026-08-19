package e2e

import (
	"bufio"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// These exercise `amiro serve` as a real process -- the thing the unit
// tests structurally cannot reach. internal/web proves the resolution
// ladder, internal/httpserver proves the routing and the guards; only a
// spawned binary proves that a browser pointed at a port gets a working
// dashboard, that a deep link survives a hard refresh over real HTTP, and
// that the process stops when asked.

func buildAmiro(t *testing.T) string {
	t.Helper()

	bin := filepath.Join(t.TempDir(), "amiro")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/amiro")
	cmd.Dir = repoRoot(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build ./cmd/amiro failed: %v\n%s", err, out)
	}
	return bin
}

// uiBundle writes a directory shaped like a `next build` export, so these
// tests need no frontend build to run. --ui-dir and the compiled-in bundle
// go through the identical handler, so what this proves about one holds
// for the other.
func uiBundle(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"index.html":                   "<html><head><title>Amiro</title></head><body>DASHBOARD HOME</body></html>",
		"404.html":                     "<html><head></head><body>NOT FOUND</body></html>",
		"admin.html":                   "<html><head></head><body>ADMIN</body></html>",
		"admin/providers.html":         "<html><head></head><body>PROVIDERS</body></html>",
		"sign-in.html":                 "<html><head></head><body>SIGN IN</body></html>",
		"_next/static/chunk.abc123.js": "console.log('amiro')",
	}
	for name, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	return dir
}

type serveProcess struct {
	baseURL string
	cmd     *exec.Cmd
	stderr  *strings.Builder
}

// startServe launches `amiro serve` and waits for the PORT= line it prints
// on stdout, the same handoff cmd/server uses for Rust.
func startServe(t *testing.T, bin string, args ...string) (*serveProcess, func()) {
	t.Helper()

	full := append([]string{"serve"}, args...)
	cmd := exec.Command(bin, full...)
	cmd.Env = append(os.Environ(),
		"AMIRO_APP_DATA_DIR="+t.TempDir(),
		"AMIRO_AUTH_TOKEN=e2e-serve-token",
		// Keep the agent's file tools pointed somewhere disposable.
		"AMIRO_WORKSPACE_ROOT="+t.TempDir(),
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("StderrPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting amiro serve: %v", err)
	}

	var stderr strings.Builder
	go func() { _, _ = io.Copy(&stderr, stderrPipe) }()

	proc := &serveProcess{cmd: cmd, stderr: &stderr}
	cleanup := func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}

	portCh := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if port, ok := strings.CutPrefix(strings.TrimSpace(scanner.Text()), "PORT="); ok {
				portCh <- port
				return
			}
		}
		close(portCh)
	}()

	select {
	case port, ok := <-portCh:
		if !ok || port == "" {
			cleanup()
			t.Fatalf("amiro serve exited or closed stdout before printing PORT=\nstderr:\n%s", stderr.String())
		}
		proc.baseURL = "http://127.0.0.1:" + port
		return proc, cleanup
	case <-time.After(30 * time.Second):
		cleanup()
		t.Fatalf("timed out waiting for PORT=\nstderr:\n%s", stderr.String())
		return nil, nil
	}
}

// browserGet is what a browser actually sends for a same-origin
// navigation. Every request in these tests goes through it, because a
// request that omits Sec-Fetch-Site is not testing the path a browser
// takes -- see middleware.RequireTokenOrBrowser.
func browserGet(t *testing.T, url string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

func bodyOf(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(b)
}

// TestServe_ServesTheDashboardAndTheAPIOffOneListener is the whole point of
// Phase 0: before this, the exported bundle had no server and the sidecar
// served no bundle.
func TestServe_ServesTheDashboardAndTheAPIOffOneListener(t *testing.T) {
	p, cleanup := startServe(t, buildAmiro(t), "--ui-dir", uiBundle(t))
	defer cleanup()

	page := browserGet(t, p.baseURL+"/")
	if page.StatusCode != http.StatusOK {
		t.Fatalf("GET /: status = %d, want 200", page.StatusCode)
	}
	if body := bodyOf(t, page); !strings.Contains(body, "DASHBOARD HOME") {
		t.Fatalf("GET / did not serve the dashboard, body = %q", body)
	}

	health := browserGet(t, p.baseURL+"/health")
	if health.StatusCode != http.StatusOK {
		t.Fatalf("GET /health: status = %d, want 200", health.StatusCode)
	}
	if body := bodyOf(t, health); !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("GET /health body = %q, want the API's JSON", body)
	}
}

// TestServe_DeepLinksSurviveAHardRefresh is the SPA-fallback contract
// verified over real HTTP. A user who bookmarks /admin/providers and opens
// it cold must get the page, not a 404 -- and that only works because the
// handler tries the export's "<route>.html" shape.
func TestServe_DeepLinksSurviveAHardRefresh(t *testing.T) {
	p, cleanup := startServe(t, buildAmiro(t), "--ui-dir", uiBundle(t))
	defer cleanup()

	for path, want := range map[string]string{
		"/admin":           "ADMIN",
		"/admin/providers": "PROVIDERS",
		"/sign-in":         "SIGN IN",
	} {
		resp := browserGet(t, p.baseURL+path)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s: status = %d, want 200", path, resp.StatusCode)
			resp.Body.Close()
			continue
		}
		if body := bodyOf(t, resp); !strings.Contains(body, want) {
			t.Errorf("GET %s: body does not contain %q", path, want)
		}
	}
}

// TestServe_InjectsTheSameOriginMarker proves the frontend will actually
// talk to this server. Without it, src/lib/backend/config.ts falls through
// to its 127.0.0.1:8787 dev default and every API call from the served
// page goes to the wrong place.
func TestServe_InjectsTheSameOriginMarker(t *testing.T) {
	p, cleanup := startServe(t, buildAmiro(t), "--ui-dir", uiBundle(t))
	defer cleanup()

	body := bodyOf(t, browserGet(t, p.baseURL+"/"))
	if !strings.Contains(body, `window.__BACKEND_ORIGIN__=""`) {
		t.Fatalf("served HTML carries no same-origin marker:\n%s", body)
	}
}

// TestServe_UnknownRoutesAnswerCorrectlyForTheirKind: an unknown page is
// the export's 404, an unknown API path is JSON. A catch-all that returned
// the SPA shell for /api/nope would make a client parse HTML as JSON.
func TestServe_UnknownRoutesAnswerCorrectlyForTheirKind(t *testing.T) {
	p, cleanup := startServe(t, buildAmiro(t), "--ui-dir", uiBundle(t))
	defer cleanup()

	page := browserGet(t, p.baseURL+"/no/such/page")
	if page.StatusCode != http.StatusNotFound {
		t.Errorf("GET /no/such/page: status = %d, want 404", page.StatusCode)
	}
	if body := bodyOf(t, page); !strings.Contains(body, "NOT FOUND") {
		t.Errorf("unknown page did not serve the export's 404, body = %q", body)
	}

	api := browserGet(t, p.baseURL+"/api/no-such-route")
	if api.StatusCode != http.StatusNotFound {
		t.Errorf("GET /api/no-such-route: status = %d, want 404", api.StatusCode)
	}
	if ct := api.Header.Get("Content-Type"); !strings.Contains(ct, "json") {
		t.Errorf("unknown API path Content-Type = %q, want JSON", ct)
	}
	_ = bodyOf(t, api)
}

// TestServe_RefusesCrossSiteRequests: relaxing the shared-secret header for
// the served page must not hand the API to any site the user happens to
// visit.
func TestServe_RefusesCrossSiteRequests(t *testing.T) {
	p, cleanup := startServe(t, buildAmiro(t), "--ui-dir", uiBundle(t))
	defer cleanup()

	req, err := http.NewRequest(http.MethodGet, p.baseURL+"/health", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("cross-site request: status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
	}
}

// TestServe_WarnsLoudlyWhenBoundBeyondLoopback. Binding 0.0.0.0 exposes an
// agent that runs shell commands to the network. That is a legitimate
// thing to want and it must never happen quietly.
func TestServe_WarnsLoudlyWhenBoundBeyondLoopback(t *testing.T) {
	p, cleanup := startServe(t, buildAmiro(t), "--host", "0.0.0.0", "--ui-dir", uiBundle(t))
	defer cleanup()

	// The banner is written before the PORT= line is consumed, but the
	// stderr copy races it; give it a moment to land.
	deadline := time.Now().Add(3 * time.Second)
	var out string
	for time.Now().Before(deadline) {
		out = p.stderr.String()
		if strings.Contains(out, "WARNING") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	if !strings.Contains(out, "WARNING") {
		t.Fatalf("no warning printed for a 0.0.0.0 bind:\n%s", out)
	}
	for _, want := range []string{"reachable", "network"} {
		if !strings.Contains(strings.ToLower(out), want) {
			t.Errorf("the warning should mention %q, got:\n%s", want, out)
		}
	}
}

// TestServe_NoUIServesTheAPIAloneBehindTheSharedSecret. --no-ui makes
// serve a plain headless backend, and it must not need a bundle to exist.
//
// It also keeps the shared-secret requirement, which is the deliberate
// half: the header is relaxed only for a page this server itself
// delivered, because that page could not have been given a secret
// privately. With no page there is no such request, so nothing has earned
// the relaxation and every caller is a programmatic one that has the
// token.
func TestServe_NoUIServesTheAPIAloneBehindTheSharedSecret(t *testing.T) {
	p, cleanup := startServe(t, buildAmiro(t), "--no-ui")
	defer cleanup()

	unauthed := browserGet(t, p.baseURL+"/health")
	defer unauthed.Body.Close()
	if unauthed.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /health with no token: status = %d, want %d", unauthed.StatusCode, http.StatusUnauthorized)
	}

	req, err := http.NewRequest(http.MethodGet, p.baseURL+"/health", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("X-Amiro-Token", "e2e-serve-token")
	authed, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	if authed.StatusCode != http.StatusOK {
		t.Fatalf("GET /health with the token: status = %d, want 200", authed.StatusCode)
	}
	if body := bodyOf(t, authed); !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("body = %q, want the API's JSON", body)
	}

	page := browserGet(t, p.baseURL+"/")
	defer page.Body.Close()
	if page.StatusCode == http.StatusOK {
		t.Fatalf("GET / returned 200 with --no-ui, want no dashboard")
	}
}

// TestServe_ShutsDownGracefullyOnSIGTERM mirrors the sidecar's own
// lifecycle test. A serve process that ignores SIGTERM leaks a listener
// and, worse, keeps the discovery lock, so the next `amiro` attaches to a
// backend on its way out.
func TestServe_ShutsDownGracefullyOnSIGTERM(t *testing.T) {
	p, cleanup := startServe(t, buildAmiro(t), "--ui-dir", uiBundle(t))
	defer cleanup()

	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("SIGTERM: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("amiro serve did not exit within 10s of SIGTERM\nstderr:\n%s", p.stderr.String())
	}

	// The port must actually be released, not just the process reaped.
	if _, err := http.Get(p.baseURL + "/health"); err == nil {
		t.Fatal("the listener is still accepting connections after shutdown")
	}
}

// TestServe_RefusesToStartASecondBackendOnTheSameDatabase. attach-or-embed
// exists because two processes writing one SQLite file is how a desktop app
// corrupts its own state; `serve` is not an exception to that rule.
func TestServe_RefusesToStartASecondBackendOnTheSameDatabase(t *testing.T) {
	bin := buildAmiro(t)
	appData := t.TempDir()
	ui := uiBundle(t)

	env := append(os.Environ(),
		"AMIRO_APP_DATA_DIR="+appData,
		"AMIRO_AUTH_TOKEN=e2e-serve-token",
		"AMIRO_WORKSPACE_ROOT="+t.TempDir(),
	)

	first := exec.Command(bin, "serve", "--ui-dir", ui)
	first.Env = env
	stdout, err := first.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	if err := first.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() {
		_ = first.Process.Kill()
		_ = first.Wait()
	}()

	// Wait for the first one to be up and to have written its lock.
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		if strings.HasPrefix(strings.TrimSpace(scanner.Text()), "PORT=") {
			break
		}
	}

	second := exec.Command(bin, "serve", "--ui-dir", ui)
	second.Env = env
	out, err := second.CombinedOutput()
	if err == nil {
		t.Fatalf("a second `amiro serve` started against the same database:\n%s", out)
	}
	if !strings.Contains(string(out), "already running") {
		t.Fatalf("the error should say a backend is already running, got:\n%s", out)
	}
}

// TestVersion_ReportsWhetherADashboardIsEmbedded. A binary built without
// -tags embedui looks identical from the outside to one built with it, and
// "why does serve say there is no UI" is otherwise unanswerable.
func TestVersion_ReportsWhetherADashboardIsEmbedded(t *testing.T) {
	out, err := exec.Command(buildAmiro(t), "version").CombinedOutput()
	if err != nil {
		t.Fatalf("amiro version: %v\n%s", err, out)
	}

	got := string(out)
	if !strings.Contains(got, "amiro ") {
		t.Errorf("version output = %q, want it to name the binary", got)
	}
	if !strings.Contains(got, "dashboard") {
		t.Errorf("version output = %q, want a dashboard line", got)
	}
	// This test binary is built without the tag, so it must say so.
	if !strings.Contains(got, "not embedded") {
		t.Errorf("a binary built without -tags embedui should say so, got %q", got)
	}
}
