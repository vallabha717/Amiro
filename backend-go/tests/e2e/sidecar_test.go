// Package e2e holds cross-cutting suites that exercise the sidecar as a real
// process rather than an in-process http.Handler -- the parts unit tests
// structurally can't reach: stdout port handoff, real TCP bind behavior,
// process lifecycle. Colocated unit tests already cover the handler logic
// itself; this proves the wiring described in plan section 1 actually works
// end to end.
package e2e

import (
	"bufio"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// buildSidecar compiles cmd/server into a temp binary and returns its path.
func buildSidecar(t *testing.T) string {
	t.Helper()

	bin := filepath.Join(t.TempDir(), "bc-server")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/server")
	cmd.Dir = repoRoot(t)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build ./cmd/server failed: %v\n%s", err, out)
	}
	return bin
}

// repoRoot resolves backend-go/ from tests/e2e/ regardless of the working
// directory `go test` was invoked from.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs("../..")
	if err != nil {
		t.Fatalf("resolving backend-go root: %v", err)
	}
	return dir
}

// startSidecar launches the built binary with the given env, waits for the
// PORT= line on stdout, and returns the base URL plus a cleanup func.
func startSidecar(t *testing.T, bin string, env []string) (baseURL string, cleanup func()) {
	t.Helper()

	cmd := exec.Command(bin)
	cmd.Env = env
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting sidecar: %v", err)
	}

	cleanup = func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}

	portCh := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if port, ok := strings.CutPrefix(line, "PORT="); ok {
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
			t.Fatal("sidecar exited or closed stdout before printing a PORT= line")
		}
		return "http://127.0.0.1:" + port, cleanup
	case <-time.After(10 * time.Second):
		cleanup()
		t.Fatal("timed out waiting for sidecar to print PORT= on stdout")
		return "", nil
	}
}

func TestSidecar_PrintsPortAndBindsLoopbackOnly(t *testing.T) {
	bin := buildSidecar(t)
	baseURL, cleanup := startSidecar(t, bin, append(os.Environ(),
		"BETTERCHATBOT_AUTH_TOKEN=e2e-test-token",
		"BETTERCHATBOT_ALLOWED_ORIGIN=tauri://localhost",
		"BETTERCHATBOT_APP_DATA_DIR="+t.TempDir(),
	))
	defer cleanup()

	if !strings.HasPrefix(baseURL, "http://127.0.0.1:") {
		t.Fatalf("baseURL = %q, want a 127.0.0.1 loopback address", baseURL)
	}
}

func TestSidecar_HealthRejectsRequestWithoutToken(t *testing.T) {
	bin := buildSidecar(t)
	baseURL, cleanup := startSidecar(t, bin, append(os.Environ(),
		"BETTERCHATBOT_AUTH_TOKEN=e2e-test-token",
		"BETTERCHATBOT_ALLOWED_ORIGIN=tauri://localhost",
		"BETTERCHATBOT_APP_DATA_DIR="+t.TempDir(),
	))
	defer cleanup()

	resp, err := http.Get(baseURL + "/health")
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
	}
}

func TestSidecar_HealthReturnsOkWithValidToken(t *testing.T) {
	bin := buildSidecar(t)
	baseURL, cleanup := startSidecar(t, bin, append(os.Environ(),
		"BETTERCHATBOT_AUTH_TOKEN=e2e-test-token",
		"BETTERCHATBOT_ALLOWED_ORIGIN=tauri://localhost",
		"BETTERCHATBOT_APP_DATA_DIR="+t.TempDir(),
	))
	defer cleanup()

	req, err := http.NewRequest(http.MethodGet, baseURL+"/health", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("X-BetterChatbot-Token", "e2e-test-token")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
}

func TestSidecar_ShutsDownGracefullyOnSIGTERM(t *testing.T) {
	bin := buildSidecar(t)
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		"BETTERCHATBOT_AUTH_TOKEN=e2e-test-token",
		"BETTERCHATBOT_APP_DATA_DIR="+t.TempDir(),
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting sidecar: %v", err)
	}

	scanner := bufio.NewScanner(stdout)
	ready := make(chan struct{})
	go func() {
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "PORT=") {
				close(ready)
				return
			}
		}
	}()
	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("sidecar never printed PORT=")
	}

	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("sending SIGTERM: %v", err)
	}

	exitErr := make(chan error, 1)
	go func() { exitErr <- cmd.Wait() }()

	select {
	case err := <-exitErr:
		if err != nil {
			t.Fatalf("sidecar did not exit cleanly after SIGTERM: %v", err)
		}
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("sidecar did not shut down within 10s of SIGTERM -- graceful shutdown is hanging")
	}
}
