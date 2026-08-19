package lifecycle_test

import (
	"net/http"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/process"
)

// TestLifecycle_PortReportedAndLockFileMatches verifies that the spawned backend prints PORT=
// on stdout and writes sidecar.lock.json into its app-data directory with matching PID, port, and token.
func TestLifecycle_PortReportedAndLockFileMatches(t *testing.T) {
	h := harness.New(t)
	be := h.Backend()

	if be.Port == 0 {
		t.Fatal("backend reported port 0; PORT= line was not parsed")
	}

	lock, ok, err := backend.ReadLock(be.AppDataDir)
	if err != nil {
		t.Fatalf("reading discovery lock: %v", err)
	}
	if !ok {
		t.Fatal("sidecar.lock.json was not found in app-data directory")
	}
	if lock.Port != be.Port {
		t.Errorf("lock port %d != backend port %d", lock.Port, be.Port)
	}
	if lock.Token != be.Token {
		t.Error("lock token does not match harness generated token")
	}
	if lock.PID != be.Process().Pid() {
		t.Errorf("lock PID %d != process PID %d", lock.PID, be.Process().Pid())
	}
}

// TestLifecycle_GracefulShutdownFreesPort verifies that Stop() terminates the process cleanly
// and the listening port is freed.
func TestLifecycle_GracefulShutdownFreesPort(t *testing.T) {
	h := harness.New(t)
	be := h.Backend()
	port := be.Port

	if err := be.Stop(t.Context()); err != nil {
		t.Fatalf("stopping backend: %v", err)
	}

	// Verify port is freed
	if err := process.AssertPortFree("127.0.0.1", port, 5*time.Second); err != nil {
		t.Errorf("port %d was not freed after shutdown: %v", port, err)
	}
}

// TestLifecycle_RejectsRequestWithoutToken verifies that requests lacking the shared secret header
// are rejected by the outer middleware.
func TestLifecycle_RejectsRequestWithoutToken(t *testing.T) {
	h := harness.New(t)
	be := h.Backend()

	client := &http.Client{}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, be.URL+"/health", nil)
	if err != nil {
		t.Fatalf("creating request: %v", err)
	}
	// Do not set X-Amiro-Token header
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("executing request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401 Unauthorized for request without token, got %d", resp.StatusCode)
	}
}
