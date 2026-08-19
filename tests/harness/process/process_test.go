package process

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness/logging"
)

func newLogger(t *testing.T) *logging.Logger {
	t.Helper()
	l, err := logging.New(t.TempDir(), "test-run", time.Now().UTC(), logging.LevelDebug, nil)
	if err != nil {
		t.Fatalf("logging.New: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l
}

func shell(t *testing.T, script string) Spec {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("no POSIX shell available: %v", err)
	}
	return Spec{
		Name:    "probe",
		Path:    sh,
		Args:    []string{"-c", script},
		Env:     os.Environ(),
		LogDir:  "probe",
		Surface: "meta",
	}
}

// TestWaitForLine_ScansPastEarlierOutputRatherThanReadingTheFirstLine is the
// single most important behaviour in this package.
//
// Bifrost writes its own startup logging to stdout AHEAD of cmd/server's
// PORT= line. A reader that took line one would find a log message and
// conclude the backend had failed -- which is precisely the failure recorded
// in docs/notes-backend-testing.md and re-checked before Phase 1 began.
func TestWaitForLine_ScansPastEarlierOutputRatherThanReadingTheFirstLine(t *testing.T) {
	log := newLogger(t)
	p, err := Start(log, shell(t, `
		echo "[bifrost] initialising provider registry"
		echo "[bifrost] loaded 6 providers"
		echo "PORT=54321"
		sleep 30
	`))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = p.Stop(context.Background()) })

	got, err := p.WaitForLine(context.Background(), "PORT=", 10*time.Second)
	if err != nil {
		t.Fatalf("WaitForLine: %v", err)
	}
	if got != "54321" {
		t.Errorf("read port %q, want \"54321\"", got)
	}
}

// TestWaitForLine_ReportsExitRatherThanTimingOutWhenTheProcessDies keeps a
// broken binary from costing the full startup timeout.
func TestWaitForLine_ReportsExitRatherThanTimingOutWhenTheProcessDies(t *testing.T) {
	log := newLogger(t)
	p, err := Start(log, shell(t, `echo "config error: nowhere to bind" >&2; exit 1`))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	started := time.Now()
	_, err = p.WaitForLine(context.Background(), "PORT=", 30*time.Second)
	if err == nil {
		t.Fatal("expected an error")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Errorf("took %s to notice the process had exited; it should not wait out the timeout", elapsed)
	}
	// The message must point at the logs, not merely say what went wrong.
	if !strings.Contains(err.Error(), "stderr:") {
		t.Errorf("the error does not name the log files:\n%v", err)
	}
}

// TestWaitForLine_FindsALinePrintedJustBeforeExit covers the drain case: a
// process that reported its port and then died has still told us the port,
// and losing that would turn a crash into an unexplained timeout.
func TestWaitForLine_FindsALinePrintedJustBeforeExit(t *testing.T) {
	log := newLogger(t)
	p, err := Start(log, shell(t, `echo "PORT=1234"; exit 0`))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	got, err := p.WaitForLine(context.Background(), "PORT=", 10*time.Second)
	if err != nil {
		t.Fatalf("WaitForLine: %v", err)
	}
	if got != "1234" {
		t.Errorf("read %q, want \"1234\"", got)
	}
}

// TestStart_StreamsOutputToDiskWhileTheProcessIsStillRunning is the
// "streamed, never buffered" guarantee.
//
// A hung process is exactly when its log matters most, so the assertion is
// made against a process that has NOT exited.
func TestStart_StreamsOutputToDiskWhileTheProcessIsStillRunning(t *testing.T) {
	log := newLogger(t)
	p, err := Start(log, shell(t, `echo "first line"; echo "PORT=1"; sleep 30`))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = p.Stop(context.Background()) })

	if _, err := p.WaitForLine(context.Background(), "PORT=", 10*time.Second); err != nil {
		t.Fatalf("WaitForLine: %v", err)
	}
	if p.Exited() {
		t.Fatal("the probe exited early; this test proves nothing about a running process")
	}

	path := log.Path(filepath.Join("probe", "probe.stdout.log"))
	err = WaitFor(context.Background(), "the log to contain the first line", 5*time.Second, func() error {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !strings.Contains(string(data), "first line") {
			return errNotYet
		}
		return nil
	})
	if err != nil {
		t.Errorf("output was not on disk while the process was still running: %v", err)
	}
}

var errNotYet = errNotYetType{}

type errNotYetType struct{}

func (errNotYetType) Error() string { return "not yet" }

// TestStop_KillsTheWholeProcessGroup is what makes teardown trustworthy.
//
// The probe spawns a child that outlives its parent and holds a file open.
// Without a process group, killing the parent leaves the child running --
// and in the real suite that child is a Go sidecar still holding a port.
func TestStop_KillsTheWholeProcessGroup(t *testing.T) {
	log := newLogger(t)
	marker := filepath.Join(t.TempDir(), "child-alive")
	p, err := Start(log, shell(t, `
		( while true; do touch `+marker+`; sleep 0.05; done ) &
		echo "PORT=1"
		wait
	`))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := p.WaitForLine(context.Background(), "PORT=", 10*time.Second); err != nil {
		t.Fatalf("WaitForLine: %v", err)
	}
	// Wait until the grandchild has actually started touching the marker,
	// so a pass cannot come from it never having run.
	if err := WaitFor(context.Background(), "the grandchild to start", 5*time.Second, func() error {
		_, err := os.Stat(marker)
		return err
	}); err != nil {
		t.Fatalf("the grandchild never started: %v", err)
	}

	if err := p.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if err := p.AssertStopped(); err != nil {
		t.Errorf("%v", err)
	}

	// If the grandchild survived it will keep touching the marker. Remove
	// it and confirm it stays gone.
	if err := os.Remove(marker); err != nil {
		t.Fatalf("removing the marker: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Error("the grandchild is still running after Stop(); the process group was not killed")
	}
}

// TestWaitFor_ReportsTheLastObservedStateOnTimeout is why there is no Sleep
// in this package's public surface.
func TestWaitFor_ReportsTheLastObservedStateOnTimeout(t *testing.T) {
	err := WaitFor(context.Background(), "something that never happens", 100*time.Millisecond, func() error {
		return errSpecific
	})
	if err == nil {
		t.Fatal("expected a timeout")
	}
	if !strings.Contains(err.Error(), "the specific reason") {
		t.Errorf("the timeout discarded the last error:\n%v", err)
	}
}

var errSpecific = errSpecificType{}

type errSpecificType struct{}

func (errSpecificType) Error() string { return "the specific reason" }

// TestAssertPortFree_DistinguishesABoundPortFromAFreeOne pins the teardown
// assertion that catches a leaked listener the process check cannot: the
// parent can be gone while a child it spawned still holds the socket.
func TestAssertPortFree_DistinguishesABoundPortFromAFreeOne(t *testing.T) {
	port, err := FreePort("127.0.0.1")
	if err != nil {
		t.Fatalf("FreePort: %v", err)
	}
	if err := AssertPortFree("127.0.0.1", port, time.Second); err != nil {
		t.Errorf("a released port should be reported free: %v", err)
	}

	// Now hold the port and confirm the assertion fails while it is held.
	listener, err := listen(port)
	if err != nil {
		t.Skipf("could not re-bind port %d to test the negative case: %v", port, err)
	}
	defer listener.Close()
	if err := AssertPortFree("127.0.0.1", port, 500*time.Millisecond); err == nil {
		t.Error("a bound port was reported free")
	}
}

// TestInheritSafe_StripsEveryApplicationVariable is the guard against the
// worst failure this package can enable.
//
// A spawned backend that inherits the developer's AMIRO_APP_DATA_DIR writes
// into their real database. That happened once during Phase 0 -- caught only
// because /api/auth/status answered isFirstUser:false against what was
// supposed to be an empty database.
func TestInheritSafe_StripsEveryApplicationVariable(t *testing.T) {
	t.Setenv("AMIRO_APP_DATA_DIR", "/home/someone/.local/share/amiro")
	t.Setenv("BETTERCHATBOT_AUTH_TOKEN", "a-real-token")
	t.Setenv("PATH", os.Getenv("PATH"))

	env := InheritSafe("HOME")
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		switch {
		case strings.HasPrefix(k, "AMIRO_"):
			t.Errorf("%s survived InheritSafe", k)
		case strings.HasPrefix(k, "BETTERCHATBOT_"):
			t.Errorf("%s survived InheritSafe", k)
		case k == "HOME":
			t.Error("HOME was explicitly stripped but survived")
		}
	}
	// PATH must survive, or nothing starts at all.
	var hasPath bool
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			hasPath = true
		}
	}
	if !hasPath {
		t.Error("PATH was stripped; no spawned binary would resolve")
	}
}
