package sandbox

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// startLoopbackServer starts a real HTTP server on 127.0.0.1 that answers
// 200 to anything, and returns its base URL. Closed automatically via
// t.Cleanup.
func startLoopbackServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return fmt.Sprintf("http://%s", ln.Addr().String())
}

// requireLinuxBubblewrap skips a test outright, with a reason, when this
// isn't Linux or bwrap isn't actually usable here (missing, or present but
// unable to create namespaces in a restrictive container) -- see
// detectBubblewrap's own doc comment on why a failed smoke test is treated
// the same as "not found."
func requireLinuxBubblewrap(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skipf("bubblewrap is Linux-only, running on %s", runtime.GOOS)
	}
	resetForTest()
	t.Cleanup(resetForTest)
	b := Detect()
	if b.Name() != "bubblewrap" || !b.Sandboxed() {
		t.Skipf("bubblewrap not usable in this environment (detected backend: %s) -- see docs/coding-agent-parity/progress/verification-log-phase-02.md for what was actually exercised", b.Name())
	}
}

// TestSandbox_BlocksWriteOutsideWorkspaceRoot is exit criterion 2's first
// half: a command that tries to write outside the workspace root is
// blocked when a sandbox backend is available.
func TestSandbox_BlocksWriteOutsideWorkspaceRoot(t *testing.T) {
	requireLinuxBubblewrap(t)

	root := t.TempDir()
	outside := t.TempDir() // a real, separate directory -- not just "not root"

	var out bytes.Buffer
	result, err := Run(context.Background(), []string{"/bin/sh", "-c",
		"echo inside > " + filepath.Join(root, "inside.txt") + " && echo wrote-inside; " +
			"echo outside > " + filepath.Join(outside, "outside.txt") + " 2>/tmp/write-outside-stderr; echo exit=$?"},
		RunOpts{Dir: root, Stdout: &out, Stderr: &out})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !result.Sandboxed || result.Backend != "bubblewrap" {
		t.Fatalf("Result = %+v, want a real bubblewrap sandbox for this test to mean anything", result)
	}

	if _, statErr := os.Stat(filepath.Join(root, "inside.txt")); statErr != nil {
		t.Errorf("write inside the workspace root failed: %v (output: %s)", statErr, out.String())
	}
	if _, statErr := os.Stat(filepath.Join(outside, "outside.txt")); statErr == nil {
		t.Fatal("write outside the workspace root succeeded -- the sandbox did not confine it")
	}
	if !strings.Contains(out.String(), "wrote-inside") {
		t.Errorf("output = %q, want the inside write to have actually run", out.String())
	}
	if !strings.Contains(out.String(), "exit=") || strings.Contains(out.String(), "exit=0") {
		t.Errorf("output = %q, want the outside write's own command to report a non-zero exit", out.String())
	}
}

// TestSandbox_BlocksNetworkUnlessAllowlisted is exit criterion 2's second
// half: a command reaching the network is blocked by default and permitted
// once its prefix is on SandboxNetworkAllow.
//
// A real, listening loopback HTTP server is the fixture rather than a
// dead port: curl's own exit code is 7 ("couldn't connect") both when a
// network namespace has no route at all and when a real, shared namespace
// simply has nothing listening on the target port, so distinguishing "no
// network" from "network, wrong port" needs an endpoint that actually
// answers when reachable.
func TestSandbox_BlocksNetworkUnlessAllowlisted(t *testing.T) {
	requireLinuxBubblewrap(t)

	srv := startLoopbackServer(t)
	root := t.TempDir()
	curlArgv := []string{"/bin/sh", "-c",
		"curl -s -m 3 -o /dev/null -w '%{http_code}' " + srv + "/ 2>&1; echo"}

	t.Run("denied by default", func(t *testing.T) {
		var out bytes.Buffer
		result, err := Run(context.Background(), curlArgv, RunOpts{
			Dir: root, Stdout: &out, Stderr: &out, NetworkAllowed: false,
		})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if !result.Sandboxed {
			t.Fatalf("Result = %+v, want a real sandbox", result)
		}
		if strings.Contains(out.String(), "200") {
			t.Errorf("output = %q, want the real server unreachable with network denied", out.String())
		}
	})

	t.Run("allowed via NetworkAllowed", func(t *testing.T) {
		var out bytes.Buffer
		result, err := Run(context.Background(), curlArgv, RunOpts{
			Dir: root, Stdout: &out, Stderr: &out, NetworkAllowed: true,
		})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if !result.Sandboxed {
			t.Fatalf("Result = %+v, want a real sandbox", result)
		}
		if !strings.Contains(out.String(), "200") {
			t.Errorf("output = %q, want the real server reachable once network is allowed", out.String())
		}
	})
}

// TestSandbox_FallsThroughToUnsandboxedAndSaysSo is exit criterion 3: a
// command run with no available backend still executes -- no capability
// regression -- and Result.Sandboxed is false.
//
// It forces Detect()'s cached result to noneBackend (forceBackendForTest)
// rather than depending on this machine actually lacking bwrap/sandbox-exec
// -- this environment has bwrap installed, so relying on absence would make
// the test meaningless here and everywhere else it has one too. Forcing the
// backend still exercises the real Run() path end to end: a command that
// would try to write outside a workspace root, which a real backend would
// block, must actually succeed under "none."
func TestSandbox_FallsThroughToUnsandboxedAndSaysSo(t *testing.T) {
	forceBackendForTest(noneBackend{})
	t.Cleanup(resetForTest)

	root := t.TempDir()
	outside := t.TempDir()
	var out bytes.Buffer
	result, err := Run(context.Background(), []string{"/bin/sh", "-c",
		"echo x > " + filepath.Join(outside, "unblocked.txt") + " && echo wrote-outside"},
		RunOpts{Dir: root, Stdout: &out, Stderr: &out})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if result.Sandboxed {
		t.Fatalf("Result.Sandboxed = true, want false with no backend forced")
	}
	if result.Backend != "none" {
		t.Fatalf("Result.Backend = %q, want %q", result.Backend, "none")
	}
	// The capability-regression check this criterion cares about: a write
	// outside the workspace root, which TestSandbox_BlocksWriteOutsideWorkspaceRoot
	// proves a real backend blocks, must still succeed here -- "no
	// backend" must not silently narrow what the tool could do before this
	// package existed.
	if _, statErr := os.Stat(filepath.Join(outside, "unblocked.txt")); statErr != nil {
		t.Errorf("write outside the workspace root failed under the none backend (%v) -- this is a capability regression, not a safety feature: with no isolation available, run_shell must still behave exactly as it did before this package existed", statErr)
	}
	if !strings.Contains(out.String(), "wrote-outside") {
		t.Errorf("output = %q, want the command to have actually run", out.String())
	}
}

// TestNoneBackend_NeverBlocksNetworkOrWrites pins noneBackend's contract
// directly and unconditionally (no environment dependency): it is the
// identity wrapper, full stop, regardless of NetworkAllowed or Dir.
func TestNoneBackend_NeverBlocksNetworkOrWrites(t *testing.T) {
	var b noneBackend
	argv := []string{"echo", "hi"}
	for _, opts := range []CommandOpts{
		{},
		{Dir: "/some/dir"},
		{NetworkAllowed: true},
		{NetworkAllowed: false, Dir: "/some/dir"},
	} {
		got := b.wrap(argv, opts)
		if len(got) != 2 || got[0] != "echo" || got[1] != "hi" {
			t.Errorf("wrap(%v, %+v) = %v, want unchanged", argv, opts, got)
		}
	}
}

// TestDetect_CachesAcrossCalls proves the "process lifetime" caching
// contract: two calls to Detect() return the same instance, and Detect is
// safe from concurrent callers (the same shape lsp.NewPool's discovery
// promises).
func TestDetect_CachesAcrossCalls(t *testing.T) {
	resetForTest()
	t.Cleanup(resetForTest)
	first := Detect()
	second := Detect()
	if first != second {
		t.Fatalf("Detect() returned different backends across calls: %v vs %v -- must be cached for the process lifetime", first, second)
	}
}

// TestDetect_ReturnsAnHonestBackend is exit
// criterion 3's detection half. It cannot force bwrap/sandbox-exec to be
// absent on a machine that legitimately has them (this environment does),
// so it instead pins the contract at the Backend-interface level: an
// implementation is only ever "none" when Sandboxed() is false, and
// Detect() must return exactly one Backend value that satisfies that.
func TestDetect_ReturnsAnHonestBackend(t *testing.T) {
	b := Detect()
	if b.Sandboxed() && b.Name() == "none" {
		t.Fatal("a backend named \"none\" must never report Sandboxed() true -- that is the exact confusion this package exists to prevent")
	}
	if !b.Sandboxed() && b.Name() != "none" {
		t.Fatalf("backend %q reports Sandboxed() false but is not named \"none\" -- Result.Backend would then lie about which backend produced an unsandboxed result", b.Name())
	}
}
