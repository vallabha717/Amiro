// Package ipc_test covers the "ipc" feature: "Tauri commands in
// src-tauri/src/lib.rs; capability restrictions in
// capabilities/default.json hold."
//
// There is nothing to test today: src-tauri/src/lib.rs registers zero
// custom #[tauri::command] functions (no invoke_handler call exists at
// all), and capabilities/default.json grants exactly "core:default" and
// nothing beyond it. This test is a structural guard against exactly that
// changing silently -- a parse of the Rust source and the capabilities
// file, not a live IPC round trip, so it runs without cargo -- and it is
// meant to start FAILING the day someone adds a real command, which is
// the point: that is the day this feature directory needs an actual test
// instead of a guard.
package ipc_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
)

func TestIPC_NoCustomCommandsAreRegisteredYet(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	// h.RepoRoot is the repository root (the directory holding backend-go/
	// and src-tauri/ as siblings), not backend-go itself -- see
	// harness/backend.FindRepoRoot and how Build joins "backend-go" onto it.
	libRS := filepath.Join(h.RepoRoot, "src-tauri", "src", "lib.rs")
	src, err := os.ReadFile(libRS)
	if err != nil {
		t.Fatalf("reading %s: %v", libRS, err)
	}

	if strings.Contains(string(src), "invoke_handler") {
		t.Fatalf("%s now calls invoke_handler, which means custom Tauri commands exist -- "+
			"this feature directory needs a real IPC test (spawn the app, invoke the command, "+
			"assert its capability restriction), not this structural guard", libRS)
	}
	count := strings.Count(string(src), "#[tauri::command]")
	if count != 0 {
		t.Fatalf("%s has %d #[tauri::command] function(s) but no invoke_handler registering them -- "+
			"that is either dead code or a registration bug, and either way this guard's assumption "+
			"(zero custom commands) no longer holds", libRS, count)
	}

	capsPath := filepath.Join(h.RepoRoot, "src-tauri", "capabilities", "default.json")
	caps, err := os.ReadFile(capsPath)
	if err != nil {
		t.Fatalf("reading %s: %v", capsPath, err)
	}
	if !strings.Contains(string(caps), `"core:default"`) {
		t.Fatalf("%s no longer grants core:default -- capability set changed, review it by hand", capsPath)
	}
}
