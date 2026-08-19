package meta_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/config"
)

// stateDirs hold the APPLICATION's own files, preserved for debugging.
// sidecar.lock.json legitimately contains the shared secret at 0600 -- that
// is how `amiro` discovers a running backend -- so redacting it would break
// the feature under test. The rule this guard enforces is that nothing the
// HARNESS writes may leak, not that the application may not keep its own
// secrets in its own state directory.
var stateDirs = map[string]bool{"appdata": true, "workspace": true, "db": true, "home": true}

// TestLogs_ContainNoConfiguredSecretInTheClear sweeps the whole run's log
// tree for every secret the configuration knows about.
//
// Redaction happens at write time, so this guard is testing the redactor
// rather than cleaning up after it. A secret that reaches disk once has
// leaked, and a post-processing pass is a pass that does not run when the
// process crashes.
func TestLogs_ContainNoConfiguredSecretInTheClear(t *testing.T) {
	h := harness.New(t, harness.NoBackend(), harness.Tags("smoke"))

	secrets := h.Config.Secrets()
	if len(secrets) == 0 {
		t.Fatal("the configuration produced no secrets to sweep for; even the default account passwords should be here")
	}

	var findings []string
	err := filepath.WalkDir(h.RunDir(), func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if stateDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext == ".zip" || ext == ".png" || ext == ".jpg" || ext == ".webm" || ext == ".webp" || ext == ".ico" {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		text := string(data)
		for _, secret := range secrets {
			if strings.Contains(text, secret) {
				rel, _ := filepath.Rel(h.RunDir(), path)
				findings = append(findings, rel+" contains a configured secret in the clear")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the run directory: %v", err)
	}
	if len(findings) > 0 {
		t.Fatalf("secrets leaked into the log tree:\n  %s", strings.Join(findings, "\n  "))
	}
}

// TestRedactor_ReplacesAPasswordSentThroughTheRealAPI is the positive
// proof.
//
// The sweep above passes trivially if nothing ever writes a secret. This
// one deliberately sends one through the API -- a registration, which puts
// the password in a request body the client logs -- and then asserts the
// recorded body carries a fingerprint instead.
func TestRedactor_ReplacesAPasswordSentThroughTheRealAPI(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))

	password := h.Config.Accounts.Admin.Password
	h.Seeded() // registers all three accounts through POST /api/auth/register

	httpLog := filepath.Join(h.RunDir(), "backend", h.TestID, "http.ndjson")
	data, err := os.ReadFile(httpLog)
	if err != nil {
		t.Fatalf("reading %s: %v", httpLog, err)
	}
	body := string(data)

	if !strings.Contains(body, "/api/auth/register") {
		t.Fatal("no registration was recorded in http.ndjson; this test proved nothing")
	}
	if strings.Contains(body, password) {
		t.Errorf("the account password appears in the clear in %s", httpLog)
	}
	want := config.Fingerprint(password)
	if !strings.Contains(body, want) {
		t.Errorf("the recorded request body contains neither the password nor its fingerprint %s;\n"+
			"the body was probably not logged at all, which makes this guard vacuous", want)
	}
}
