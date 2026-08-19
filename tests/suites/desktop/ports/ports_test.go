// Package ports_test covers the "ports" feature: "OS-assigned port each
// launch; a port collision recovers; two app instances behave per design
// (attach or refuse, not double-bind)."
//
// Only the first third is testable without cargo, and it is: cmd/server
// always binds :0 (config.Load's Port defaults to 0) and reports back
// whatever the OS gave it, which two independently launched sidecars can
// prove directly. The other two thirds are policy that belongs to Tauri's
// own launch sequence in src-tauri/src/lib.rs, which -- per the desktop
// phase's Explore survey -- always spawns a fresh sidecar unconditionally;
// nothing there checks appwiring's discovery lock before spawning. So
// "two instances attach or refuse" may not even be implemented today, and
// "a port collision recovers" cannot be observed either way without a
// real second cargo tauri dev launch to collide with. Both are recorded
// as NOT MET here rather than guessed at.
package ports_test

import (
	"context"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/desktop"
)

func TestPorts_ConcurrentLaunchesGetDistinctOSAssignedPorts(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))

	one, err := backend.Start(context.Background(), backend.Options{
		RepoRoot: h.RepoRoot, BaseDir: h.BaseDir, Config: h.Config, Log: h.Log,
		TestID: h.TestID + "-one", Surface: h.Surface, Address: h.Address + "/one",
	})
	if err != nil {
		t.Fatalf("starting the first backend: %v", err)
	}
	t.Cleanup(func() { _ = one.Stop(context.Background()) })

	two, err := backend.Start(context.Background(), backend.Options{
		RepoRoot: h.RepoRoot, BaseDir: h.BaseDir, Config: h.Config, Log: h.Log,
		TestID: h.TestID + "-two", Surface: h.Surface, Address: h.Address + "/two",
	})
	if err != nil {
		t.Fatalf("starting the second backend: %v", err)
	}
	t.Cleanup(func() { _ = two.Stop(context.Background()) })

	if one.Port == 0 || two.Port == 0 {
		t.Fatalf("both backends must have a nonzero OS-assigned port: one=%d two=%d", one.Port, two.Port)
	}
	if one.Port == two.Port {
		t.Fatalf("two concurrently launched sidecars were both assigned port %d", one.Port)
	}
}

// TestPorts_CollisionRecoveryAndTwoInstancePolicy covers the two thirds of
// this feature that need a real second `cargo tauri dev` launch. Not
// reachable without cargo.
func TestPorts_CollisionRecoveryAndTwoInstancePolicy(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	desktop.RequireToolchain(h, h.Config.Desktop.Enabled)
	h.Skip("reached only with cargo and the Tauri CLI present -- not implemented beyond the toolchain check, " +
		"since it was never runnable here, and src-tauri/src/lib.rs's spawn path shows no sign of " +
		"discovery-lock-aware collision handling to even verify")
}
