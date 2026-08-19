// Package data_test covers the "data" feature from
// docs/testing/phases/phase-06-desktop.md's deliverables table: "AppDataDir
// resolution per platform; legacy better-chatbot -> amiro migration;
// legacy betterchatbot.db -> amiro.db fallback." It is not named as one of
// the numbered exit criteria, but the plan lists it as a feature this
// surface owns, and it happens to be fully testable without cargo.
//
// None of it needs cargo. It is pure Go behaviour in
// backend-go/internal/config's unexported appDataDir() and Load(), which
// this test module cannot import directly (the module boundary guard,
// suites/meta/boundary_test.go, forbids it, and the functions are
// unexported besides) -- so it drives the real compiled sidecar the same
// way backend-go/tests/e2e/sidecar_test.go does, black-box, through the
// environment variables that function actually reads.
//
// The one thing this suite CANNOT reach without setting
// AMIRO_APP_DATA_DIR explicitly -- which defeats the fallback logic
// entirely -- is harness/backend.Env's own default wiring, so these tests
// build and launch the binary directly rather than going through
// harness.Harness.Backend().
package data_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/process"
)

// healthCheck confirms the sidecar actually opened its database and
// started serving, rather than merely printing PORT= -- a server that
// fatally errors opening a corrupt or unreadable legacy file would still
// have gotten that far.
func healthCheck(port string) error {
	return process.WaitFor(context.Background(), "GET /health to return a response", 5*time.Second, func() error {
		resp, err := http.Get("http://127.0.0.1:" + port + "/health")
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		return nil
	})
}

func buildSidecar(t *testing.T, h *harness.Harness) string {
	t.Helper()
	bin, err := backend.Build(context.Background(), h.Log, backend.BuildSpec{
		RepoRoot: h.RepoRoot, Package: "./cmd/server", Name: "server",
	})
	if err != nil {
		t.Fatalf("building the sidecar: %v", err)
	}
	return bin
}

func TestData_AppDataDirFallsBackToLegacyDirectoryWhenPresentAndNoAmiroDirExists(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	bin := buildSidecar(t, h)

	home := filepath.Join(h.Dir(), "home")
	xdgDataHome := filepath.Join(h.Dir(), "xdg-data")
	legacyDir := filepath.Join(xdgDataHome, "better-chatbot")
	amiroDir := filepath.Join(xdgDataHome, "amiro")
	for _, d := range []string{home, legacyDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// amiroDir is deliberately NOT created: appDataDir() must prefer it
	// when it exists, so absence is what forces the legacy-dir branch.

	proc, err := process.Start(h.Log, process.Spec{
		Name: "server", Path: bin, Dir: h.Dir(),
		Env: []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + home,
			"XDG_DATA_HOME=" + xdgDataHome,
			"AMIRO_AUTH_TOKEN=data-test-token",
		},
		LogDir: filepath.Join(h.Surface, h.TestID), Surface: h.Surface, Test: h.Address,
	})
	if err != nil {
		t.Fatalf("starting the sidecar: %v", err)
	}
	t.Cleanup(func() { _ = proc.Stop(context.Background()) })
	if _, err := proc.WaitForLine(context.Background(), "PORT=", 10*time.Second); err != nil {
		t.Fatalf("waiting for PORT=: %v", err)
	}

	if err := process.WaitFor(context.Background(), "the discovery lock to appear in the legacy directory",
		5*time.Second, func() error {
			_, err := os.Stat(filepath.Join(legacyDir, backend.LockFileName))
			return err
		}); err != nil {
		t.Fatalf("appDataDir() did not resolve to the legacy better-chatbot directory "+
			"(%s) even though it exists and amiro/ does not: %v", legacyDir, err)
	}
	if _, err := os.Stat(filepath.Join(amiroDir, backend.LockFileName)); !os.IsNotExist(err) {
		t.Errorf("a lock file also appeared under the amiro/ directory (%s), which should never have been created", amiroDir)
	}
}

func TestData_AppDataDirPrefersAmiroDirectoryWhenBothExist(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	bin := buildSidecar(t, h)

	home := filepath.Join(h.Dir(), "home")
	xdgDataHome := filepath.Join(h.Dir(), "xdg-data")
	legacyDir := filepath.Join(xdgDataHome, "better-chatbot")
	amiroDir := filepath.Join(xdgDataHome, "amiro")
	for _, d := range []string{home, legacyDir, amiroDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	proc, err := process.Start(h.Log, process.Spec{
		Name: "server", Path: bin, Dir: h.Dir(),
		Env: []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + home,
			"XDG_DATA_HOME=" + xdgDataHome,
			"AMIRO_AUTH_TOKEN=data-test-token",
		},
		LogDir: filepath.Join(h.Surface, h.TestID), Surface: h.Surface, Test: h.Address,
	})
	if err != nil {
		t.Fatalf("starting the sidecar: %v", err)
	}
	t.Cleanup(func() { _ = proc.Stop(context.Background()) })
	if _, err := proc.WaitForLine(context.Background(), "PORT=", 10*time.Second); err != nil {
		t.Fatalf("waiting for PORT=: %v", err)
	}

	if err := process.WaitFor(context.Background(), "the discovery lock to appear under amiro/, not the legacy dir",
		5*time.Second, func() error {
			_, err := os.Stat(filepath.Join(amiroDir, backend.LockFileName))
			return err
		}); err != nil {
		t.Fatalf("appDataDir() did not prefer the amiro/ directory when both it and the legacy "+
			"directory exist: %v", err)
	}
}

func TestData_DatabaseFallsBackToLegacyFilenameWhenPresent(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))
	bin := buildSidecar(t, h)

	home := filepath.Join(h.Dir(), "home")
	xdgDataHome := filepath.Join(h.Dir(), "xdg-data")
	amiroDir := filepath.Join(xdgDataHome, "amiro")
	if err := os.MkdirAll(amiroDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	// A pre-existing legacy database file (a valid, empty SQLite database
	// is a zero-byte file) and deliberately no amiro.db, so opening
	// successfully at all proves the legacy filename was the one used.
	legacyDB := filepath.Join(amiroDir, "betterchatbot.db")
	if err := os.WriteFile(legacyDB, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	proc, err := process.Start(h.Log, process.Spec{
		Name: "server", Path: bin, Dir: h.Dir(),
		Env: []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=" + home,
			"XDG_DATA_HOME=" + xdgDataHome,
			"AMIRO_AUTH_TOKEN=data-test-token",
		},
		LogDir: filepath.Join(h.Surface, h.TestID), Surface: h.Surface, Test: h.Address,
	})
	if err != nil {
		t.Fatalf("starting the sidecar: %v", err)
	}
	t.Cleanup(func() { _ = proc.Stop(context.Background()) })
	portLine, err := proc.WaitForLine(context.Background(), "PORT=", 10*time.Second)
	if err != nil {
		t.Fatalf("waiting for PORT=: %v", err)
	}

	if err := healthCheck(portLine); err != nil {
		t.Fatalf("server did not become healthy against the legacy database file: %v", err)
	}

	amiroDB := filepath.Join(amiroDir, "amiro.db")
	if _, err := os.Stat(amiroDB); !os.IsNotExist(err) {
		t.Errorf("a fresh amiro.db was created at %s even though betterchatbot.db already existed; "+
			"the legacy filename should have been reused, not superseded", amiroDB)
	}
}
