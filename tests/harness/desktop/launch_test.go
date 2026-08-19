package desktop_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness/backend"
	"amiro/tests/harness/config"
	"amiro/tests/harness/desktop"
	"amiro/tests/harness/logging"
)

// newTestLogger builds a bare Logger the way every other harness
// subpackage's own tests do (see harness/logging/logging_test.go) -- this
// package tests itself in isolation, the same as its siblings, rather than
// going through the full harness.New ceremony that suites use.
func newTestLogger(t *testing.T) *logging.Logger {
	t.Helper()
	cfg := config.Defaults()
	l, err := logging.New(t.TempDir(), "run-1", time.Now().UTC(), logging.LevelDebug, logging.NewRedactor(&cfg))
	if err != nil {
		t.Fatalf("logging.New: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l
}

// writeStubTauriScript stands in for `cargo tauri dev`, which this machine
// cannot run (no cargo). It proves Launch's own logic -- line-by-line
// PORT= scanning, ports.ndjson recording, the lock-read poll -- entirely
// independent of whether the real toolchain is present, the same way Phase
// 1 proved WaitForLine's "scan past Bifrost's own startup noise" rule with
// a script rather than a real provider binary.
func writeStubTauriScript(t *testing.T, portLine string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "stub-tauri.sh")
	var body string
	if portLine != "" {
		body = "#!/bin/sh\necho 'tauri-plugin-log: starting'\necho '" + portLine + "'\ncat >/dev/null\n"
	} else {
		body = "#!/bin/sh\necho 'tauri-plugin-log: starting, never prints PORT='\ncat >/dev/null\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatalf("writing stub script: %v", err)
	}
	return path
}

func readPortsNDJSON(t *testing.T, path string) []desktop.PortEvent {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("opening %s: %v", path, err)
	}
	defer f.Close()
	var out []desktop.PortEvent
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var e desktop.PortEvent
		if err := json.Unmarshal(line, &e); err != nil {
			t.Fatalf("unmarshalling ports.ndjson line %q: %v", line, err)
		}
		out = append(out, e)
	}
	return out
}

func TestLaunch_ParsesPortHandoffAndRecordsPortsNDJSON(t *testing.T) {
	log := newTestLogger(t)

	stub := writeStubTauriScript(t, "PORT=54321")

	appData := t.TempDir()
	lockJSON, err := json.Marshal(backend.Lock{PID: 4242, Port: 54321, Token: "stub-token"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appData, backend.LockFileName), lockJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	app, err := desktop.Launch(context.Background(), desktop.LaunchSpec{
		Log: log, Surface: "desktop", Test: "desktop/lifecycle/TestStub", TestID: "TestStub",
		Binary: stub, AppDataDir: appData, StartupTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	t.Cleanup(func() { _ = app.Stop(context.Background()) })

	if app.Port != 54321 {
		t.Fatalf("app.Port = %d, want 54321", app.Port)
	}

	events := readPortsNDJSON(t, log.Path(app.PortsPath))
	var sawHandoff, sawLockRead bool
	for _, e := range events {
		if e.Kind == "handoff" && e.Port == 54321 {
			sawHandoff = true
		}
		if e.Kind == "lock-read" && e.PID == 4242 && e.Port == 54321 {
			sawLockRead = true
		}
	}
	if !sawHandoff {
		t.Errorf("ports.ndjson has no handoff event for port 54321: %+v", events)
	}
	if !sawLockRead {
		t.Errorf("ports.ndjson has no lock-read event for the pre-seeded lock file: %+v", events)
	}
}

func TestLaunch_TimesOutCleanlyWhenNoPortLineAppears(t *testing.T) {
	log := newTestLogger(t)

	stub := writeStubTauriScript(t, "")

	_, err := desktop.Launch(context.Background(), desktop.LaunchSpec{
		Log: log, Surface: "desktop", Test: "desktop/lifecycle/TestStub2", TestID: "TestStub2",
		Binary: stub, StartupTimeout: 300 * time.Millisecond,
	})
	if err == nil {
		t.Fatal("Launch should fail when no PORT= line ever appears, not hang or silently succeed")
	}
}
