// Package lifecycle_test covers Exit Criterion 3 ("SIGTERM shuts the
// sidecar down within 5 seconds; the lock is removed") and the part of
// Criterion 1 and the plan's "seam" description that is genuinely about
// the Tauri process itself (cargo tauri dev spawning the sidecar, the
// webview loading) rather than about the sidecar alone.
//
// The SIGTERM half needs nothing but the Go binary: every backend.Backend
// this test suite starts already goes through exactly this shutdown path
// on teardown (harness.Harness.finish -> backend.Stop -> process.Stop,
// SIGTERM then a 5s grace, see harness/process/process.go's StopGrace) and
// cmd/server's own `defer appwiring.RemoveLock(...)` -- this test is the
// one place that says so explicitly and checks the lock file by name,
// rather than relying on every other suite's teardown proving it
// implicitly. The full-app half needs cargo and is not met here.
package lifecycle_test

import (
	"os"
	"path/filepath"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/desktop"
)

func TestLifecycle_SIGTERMRemovesTheDiscoveryLockWithinFiveSeconds(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	lockPath := filepath.Join(be.AppDataDir, backend.LockFileName)
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("backend did not write its discovery lock at %s: %v", lockPath, err)
	}

	// backend.Backend.Stop (called here directly, rather than left to
	// teardown) is precisely SIGTERM-then-a-5s-grace via process.Stop,
	// followed by process.AssertStopped and process.AssertPortFree -- the
	// same path harness.Harness.finish uses for every backend test, made
	// explicit here as the criterion this feature exists to check.
	if err := be.Stop(h.Ctx); err != nil {
		t.Fatalf("SIGTERM shutdown: %v", err)
	}

	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("discovery lock at %s still exists after a graceful SIGTERM shutdown "+
			"(stat err = %v); cmd/server's defer appwiring.RemoveLock did not run", lockPath, err)
	}
}

// TestLifecycle_FullAppStartsSidecarAndLoadsWebview is the seam's
// Rust-side half: `cargo tauri dev` spawning the sidecar, reading PORT=,
// and pointing a real webview at it. It needs the Tauri toolchain, which
// this machine does not have -- see docs/testing/progress/verification-log-phase-06.md
// for the exact command that would close this once it does.
func TestLifecycle_FullAppStartsSidecarAndLoadsWebview(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	desktop.RequireToolchain(h, h.Config.Desktop.Enabled)

	// Reached only when cargo and the Tauri CLI are both on PATH.
	// desktop.Launch(ctx, desktop.LaunchSpec{Dir: filepath.Join(h.RepoRoot, "..")})
	// would spawn `cargo tauri dev`, wait for PORT=, and confirm the lock
	// file it writes names that same port -- the assertion is not written
	// further because it cannot be run, let alone debugged, on a machine
	// that cannot build src-tauri/ at all.
	h.Skip("cargo and the Tauri CLI were detected, but the full `cargo tauri dev` launch " +
		"is not implemented beyond this point -- it was never runnable on this machine, " +
		"so it was never exercised enough to trust")
}
