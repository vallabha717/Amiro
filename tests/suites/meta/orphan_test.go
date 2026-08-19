package meta_test

import (
	"net"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/process"
)

// TestTeardown_LeavesNoProcessAndNoBoundPort is the orphan guard.
//
// A leaked backend does not fail the test that leaked it. It fails a
// different test, later, usually one that has nothing to do with the cause
// -- and on a machine running four workers in parallel, it fails a
// different one each time. That is the shape of the worst class of flake,
// so teardown asserts rather than hopes.
func TestTeardown_LeavesNoProcessAndNoBoundPort(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))

	be := h.Backend()
	pid := be.Process().Pid()
	port := be.Port
	if pid == 0 || port == 0 {
		t.Fatalf("the backend reported pid %d port %d; nothing to assert on", pid, port)
	}

	// Stop explicitly rather than leaving it to cleanup, so the assertions
	// below run inside the test and report here.
	if err := be.Stop(t.Context()); err != nil {
		t.Fatalf("stopping the backend: %v", err)
	}

	if alive(pid) {
		t.Errorf("process %d is still alive after Stop()", pid)
	}
	if err := process.AssertPortFree("127.0.0.1", port, 5*time.Second); err != nil {
		t.Errorf("%v", err)
	}

	// And the port really is re-bindable, which is the property that
	// actually matters to the next test. A closed listener in TIME_WAIT
	// would pass a connect check and still fail a bind.
	l, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Errorf("port %d cannot be re-bound after teardown: %v", port, err)
	} else {
		_ = l.Close()
	}
}

// alive reports whether a pid names a live process.
//
// Signal 0 is the portable "does this exist and may I signal it?" probe: it
// performs the permission checks and delivers nothing.
func alive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// TestBackends_StartedConcurrentlyDoNotCollide is exit criterion 6 of
// Phase 1, asserted rather than assumed.
//
// Parallelism is only safe if every test's port, database and app-data
// directory are its own. Two subtests marked Parallel is the smallest thing
// that would actually catch a shared one.
func TestBackends_StartedConcurrentlyDoNotCollide(t *testing.T) {
	type observation struct {
		port    int
		appData string
		dsn     string
	}
	results := make(chan observation, 2)

	for _, name := range []string{"first", "second"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			h := harness.New(t, harness.Tags("smoke"))
			be := h.Backend()
			results <- observation{port: be.Port, appData: be.AppDataDir, dsn: be.DB.DSN}
		})
	}

	t.Cleanup(func() {
		close(results)
		var seen []observation
		for o := range results {
			seen = append(seen, o)
		}
		if len(seen) != 2 {
			t.Errorf("expected 2 concurrent backends, observed %d", len(seen))
			return
		}
		a, b := seen[0], seen[1]
		if a.port == b.port {
			t.Errorf("two concurrent backends bound the same port %d", a.port)
		}
		if a.appData == b.appData {
			t.Errorf("two concurrent backends shared an app-data directory: %s", a.appData)
		}
		if a.dsn == b.dsn {
			t.Errorf("two concurrent backends shared a database: %s", a.dsn)
		}
	})
}
