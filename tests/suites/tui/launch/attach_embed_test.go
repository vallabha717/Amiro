package launch_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
)


func TestLaunch_AttachesToRunningBackend(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	// Read initial lockfile written by the running backend
	lockPath := filepath.Join(be.AppDataDir, "sidecar.lock.json")
	initialLockBytes, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("reading initial backend lock file: %v", err)
	}

	var initialLock struct {
		PID   int    `json:"pid"`
		Port  int    `json:"port"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(initialLockBytes, &initialLock); err != nil {
		t.Fatalf("unmarshaling initial lockfile: %v", err)
	}
	if initialLock.PID == 0 || initialLock.Port == 0 {
		t.Fatalf("invalid initial lockfile data: %+v", initialLock)
	}

	// Launch TUI pointed at the backend's AppDataDir
	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
	)
	defer sess.Close()

	// Wait for TUI to render its initial chat frame
	if err := sess.WaitForText("Ask Amiro", 5*time.Second); err != nil {
		t.Fatalf("TUI did not display prompt: %v\nframe:\n%s", err, sess.Frame())
	}

	// 1. Assert TUI process PID is different from backend PID (distinct processes)
	tuiPID := sess.Process.Pid()
	if tuiPID == initialLock.PID {
		t.Fatalf("TUI process PID (%d) unexpectedly matches backend PID (%d)", tuiPID, initialLock.PID)
	}

	// 2. Assert lock file still exists and was NOT overwritten by the TUI (embedded server never started)
	currentLockBytes, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("reading current lock file: %v", err)
	}
	var currentLock struct {
		PID   int    `json:"pid"`
		Port  int    `json:"port"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(currentLockBytes, &currentLock); err != nil {
		t.Fatalf("unmarshaling current lockfile: %v", err)
	}

	if currentLock.PID != initialLock.PID {
		t.Errorf("lockfile PID changed: got %d, want original backend PID %d (TUI embedded server should NOT have started)", currentLock.PID, initialLock.PID)
	}
	if currentLock.Port != initialLock.Port {
		t.Errorf("lockfile Port changed: got %d, want original backend Port %d", currentLock.Port, initialLock.Port)
	}

	// 3. Assert backend is still reachable and healthy on original port
	req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/health", initialLock.Port), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Amiro-Token", initialLock.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("backend health check on port %d failed: %v", initialLock.Port, err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("backend health status = %d, want 200", resp.StatusCode)
	}
}

func TestLaunch_EmbedsServerWhenNoneRunning(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	freshAppData := filepath.Join(h.Dir(), "fresh-appdata")
	if err := os.MkdirAll(freshAppData, 0o755); err != nil {
		t.Fatal(err)
	}

	lockPath := filepath.Join(freshAppData, "sidecar.lock.json")
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("lockfile should not exist before launch in fresh directory")
	}

	sess := h.PTY(
		harness.PTYAppDataDir(freshAppData),
	)
	defer sess.Close()

	// TUI should start, embed its backend, and render the chat page
	if err := sess.WaitForText("Ask Amiro", 10*time.Second); err != nil {
		t.Fatalf("TUI did not start embedded server and render prompt: %v\nframe:\n%s", err, sess.Frame())
	}

	// 1. Assert lockfile was created in the fresh AppDataDir
	lockBytes, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("embedded server should have created sidecar.lock.json: %v", err)
	}

	var lock struct {
		PID   int    `json:"pid"`
		Port  int    `json:"port"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(lockBytes, &lock); err != nil {
		t.Fatalf("unmarshaling embedded lockfile: %v", err)
	}

	// 2. Assert lock PID is the TUI's own PID
	tuiPID := sess.Process.Pid()
	if lock.PID != tuiPID {
		t.Errorf("embedded lockfile PID = %d, want TUI PID %d", lock.PID, tuiPID)
	}

	// 3. Assert embedded server is responding to health check on its bound port
	if lock.Port <= 0 {
		t.Fatalf("embedded server port = %d, want positive port", lock.Port)
	}
	embReq, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/health", lock.Port), nil)
	if err != nil {
		t.Fatal(err)
	}
	embReq.Header.Set("X-Amiro-Token", lock.Token)
	embResp, err := http.DefaultClient.Do(embReq)
	if err != nil {
		t.Fatalf("embedded server health check on port %d failed: %v", lock.Port, err)
	}
	_ = embResp.Body.Close()
	if embResp.StatusCode != http.StatusOK {
		t.Errorf("embedded server health status = %d, want 200", embResp.StatusCode)
	}
}


