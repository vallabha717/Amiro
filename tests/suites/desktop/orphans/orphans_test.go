// Package orphans_test proves Exit Criterion 4: "SIGKILL of the parent
// leaves no orphaned sidecar -- with a fix if the test fails, since this is
// a known gap."
//
// It is the one feature directory in the desktop surface that needs
// neither cargo nor Tauri. The gap backend-go/cmd/server/main.go named --
// "this process exiting when its stdin/parent pipe closes is the Go-side
// complement" -- is entirely about the Go binary's own reaction to its
// stdin pipe closing, and that reaction can be produced and observed with
// nothing but os.Pipe: closing the write end reproduces, at the OS level,
// exactly what a SIGKILLed parent does to every fd it held, including this
// one. No Rust process, real or simulated, is needed to close a pipe.
//
// One assumption here is load-bearing and UNVERIFIED on this machine:
// that tauri-plugin-shell's sidecar spawn actually gives the child a real
// pipe on stdin (rather than, say, Stdio::null()), which is the only thing
// that makes the os.ModeNamedPipe gate in main.go fire in production at
// all. CommandChild exposing a write() method is evidence for this --
// piping stdin is the only reason that method would exist -- but it is
// evidence, not proof. Confirm on a machine with cargo: launch the app,
// then `ls -l /proc/<sidecar-pid>/fd/0` and check it names a pipe, not
// /dev/null. See docs/testing/progress/phase-06-desktop.md's Follow-ups.
package orphans_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/process"
)

func TestOrphans_SidecarExitsWhenParentPipeCloses(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	bin, err := backend.Build(context.Background(), h.Log, backend.BuildSpec{
		RepoRoot: h.RepoRoot,
		Package:  "./cmd/server",
		Name:     "server",
	})
	if err != nil {
		t.Fatalf("building the sidecar: %v", err)
	}

	appData := filepath.Join(h.Dir(), "appdata")
	home := filepath.Join(h.Dir(), "home")
	for _, d := range []string{appData, home} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// The exact plumbing Tauri's sidecar API gives the child: a real pipe
	// as stdin, whose write end only the parent process holds. This test
	// plays the parent -- see the package doc comment for why that is a
	// faithful stand-in for Tauri, not a mock of it.
	parentR, parentW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer parentR.Close()

	proc, err := process.Start(h.Log, process.Spec{
		Name: "server",
		Path: bin,
		Dir:  h.Dir(),
		Env: []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + home,
			"AMIRO_AUTH_TOKEN=orphan-test-token",
			"AMIRO_APP_DATA_DIR=" + appData,
		},
		LogDir:  filepath.Join(h.Surface, h.TestID),
		Surface: h.Surface,
		Test:    h.Address,
		Stdin:   parentR,
	})
	if err != nil {
		t.Fatalf("starting the sidecar: %v", err)
	}
	t.Cleanup(func() { _ = proc.Stop(context.Background()) })

	portLine, err := proc.WaitForLine(context.Background(), "PORT=", 10*time.Second)
	if err != nil {
		t.Fatalf("waiting for PORT=: %v", err)
	}
	port, err := strconv.Atoi(portLine)
	if err != nil {
		t.Fatalf("sidecar printed PORT=%q, which is not a port", portLine)
	}

	// The parent "dies": every fd it held closes, including the write end
	// of the child's stdin. No signal is sent to the sidecar at all --
	// SIGKILL cannot be caught by anyone, the child included, which is
	// exactly why this mechanism (pipe closure, not a signal) is the one
	// the fix has to use.
	if err := parentW.Close(); err != nil {
		t.Fatal(err)
	}

	if err := process.WaitFor(context.Background(), "the sidecar to notice its parent pipe closed and exit",
		5*time.Second, func() error {
			if proc.Exited() {
				return nil
			}
			return fmt.Errorf("still running (pid %d)", proc.Pid())
		}); err != nil {
		t.Fatalf("%v -- the sidecar survived its parent's pipe closing; "+
			"it would be an orphan holding port %d forever", err, port)
	}

	if err := process.AssertPortFree("127.0.0.1", port, 5*time.Second); err != nil {
		t.Fatalf("sidecar process exited but port %d was not released: %v", port, err)
	}
}
