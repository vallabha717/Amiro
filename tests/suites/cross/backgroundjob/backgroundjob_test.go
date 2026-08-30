// Package backgroundjob_test is Phase 4's cross-surface exit criterion: a
// job started from the terminal (`amiro run --background`) is visible from
// the web panel (docs/coding-agent-parity/05-background-agent-runs.md).
//
// There is exactly one job model behind both surfaces -- the web panel's
// GET /api/background-jobs and the TUI/CLI's identical HTTP call read the
// same row -- so this proves the CLI's --background flag actually reaches
// a real server over HTTP (not some in-process shortcut that a second
// surface could never see) rather than re-testing list rendering, which
// belongs to each surface's own suite.
package backgroundjob_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/backend"
)

// runAuthLogin mirrors cross/workspacetrust's own helper: a one-shot,
// non-interactive `amiro auth login` against be, establishing the session
// token `amiro run --background --connect` needs (resolveSession refuses
// to auto-provision an identity for an attached, non-embedded transport).
func runAuthLogin(t *testing.T, h *harness.Harness, be *backend.Backend, email, password string) {
	t.Helper()
	_ = os.MkdirAll(h.Dir(), 0o755)
	bin := h.TUIBinary()
	cmd := exec.Command(bin, "auth", "login",
		"--connect", be.URL,
		"--token", be.Token,
		"--email", email,
		"--password", password,
	)
	cmd.Dir = h.Dir()
	cmd.Env = backend.Env(h.Config, backend.Paths{
		AppDataDir:    be.AppDataDir,
		WorkspaceRoot: be.WorkspaceRoot,
		Home:          be.Home,
		DatabaseDSN:   filepath.Join(h.Dir(), "db", "amiro.db"),
	}, be.Token)

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amiro auth login: %v\noutput: %s", err, out)
	}
}

// backgroundRunOutput mirrors cmd/amiro's own unexported backgroundRunOutput.
type backgroundRunOutput struct {
	JobID         string `json:"jobId"`
	ThreadID      string `json:"threadId"`
	Status        string `json:"status"`
	WorkspaceRoot string `json:"workspaceRoot"`
	Error         string `json:"error,omitempty"`
}

func TestCrossSurface_JobStartedFromTheTerminalIsVisibleFromTheWebAPI(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()
	user := h.As("user")
	identity := h.Identity("user")

	// The "desktop/web" side: grant trust for the server's own default
	// workspace root -- already auto-granted via IsTrustedForTurn's env
	// exception, confirmed here anyway via the plain status route, the same
	// one a web trust-prompt check would call.
	status, err := user.WorkspaceTrustStatusFor(t.Context(), be.WorkspaceRoot)
	if err != nil {
		t.Fatalf("WorkspaceTrustStatusFor: %v", err)
	}
	if !status.Trusted {
		t.Fatalf("the server's own default workspace root is not auto-trusted -- cannot proceed")
	}

	runAuthLogin(t, h, be, identity.Email, identity.Password)

	bin := h.TUIBinary()
	cmd := exec.Command(bin, "run", "cross-surface background job check", "--background", "--json",
		"--connect", be.URL, "--token", be.Token, "-C", be.WorkspaceRoot)
	cmd.Dir = h.Dir()
	cmd.Env = backend.Env(h.Config, backend.Paths{
		AppDataDir:    be.AppDataDir,
		WorkspaceRoot: be.WorkspaceRoot,
		Home:          be.Home,
		DatabaseDSN:   filepath.Join(h.Dir(), "db", "amiro.db"),
	}, be.Token)

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("amiro run --background: %v\noutput: %s", err, out)
	}

	// --json prints exactly one JSON value on stdout; find and decode the
	// last line that parses, the same defensive approach amiro run's own
	// --json contract documents against incidental logger noise.
	var result backgroundRunOutput
	decoded := false
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if json.Unmarshal([]byte(line), &result) == nil && result.JobID != "" {
			decoded = true
			break
		}
	}
	if !decoded {
		t.Fatalf("could not find a decodable job result in amiro run --background's output:\n%s", out)
	}
	if result.Error != "" {
		t.Fatalf("amiro run --background reported an error: %s", result.Error)
	}

	// The web panel's own read path: a plain GET, from a client that never
	// touched the CLI at all.
	job, err := user.GetBackgroundJob(t.Context(), result.JobID)
	if err != nil {
		t.Fatalf("GetBackgroundJob (the web panel's own call): %v", err)
	}
	if job.ID != result.JobID || job.ThreadID != result.ThreadID {
		t.Fatalf("job fetched via the web API = %+v, want it to match what the CLI created: %+v", job, result)
	}
	if job.Prompt != "cross-surface background job check" {
		t.Fatalf("job.Prompt = %q, want the exact prompt the CLI submitted", job.Prompt)
	}
}
