// Package sandbox_test proves the sidecar's sandboxed execution is the
// same guarantee as the dashboard build: same backend package
// (internal/agent/sandbox), same terminal.go call path, so there is
// nothing sidecar-specific to isolate differently. What this suite adds
// over suites/backend/sandbox is the desktop-specific angle: the sidecar
// is what a packaged Tauri app actually spawns
// (backend-go/cmd/server, same binary harness.New already builds and
// launches for every desktop test in this directory), so proving the
// property here closes the "desktop parity" half of Phase 2's own
// deliverable table rather than assuming the backend suite's coverage
// transfers.
//
// No cargo/Tauri CLI is needed for any test in this file: sandboxing has
// no Rust surface at all (see 03-sandboxed-execution.md -- it is entirely
// a Go sidecar concern), unlike lifecycle/webview/packaging's cargo-gated
// halves.
package sandbox_test

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/config"
	"amiro/tests/harness/fakeprovider"
)

// shellOutput mirrors internal/ai/tools' terminalOutput, same as
// suites/backend/sandbox's own copy -- kept local rather than shared, the
// same reasoning suites/backend/sandbox's own doc comment on
// NetworkAllowed vs commandAllowed gives: this is deliberately not shared
// code between the two suites, only a shape that must stay identical.
type shellOutput struct {
	Command        string `json:"command"`
	ExitCode       int    `json:"exit_code"`
	Output         string `json:"output"`
	Sandboxed      bool   `json:"sandboxed"`
	SandboxBackend string `json:"sandbox_backend"`
}

func decodeShellOutput(t *testing.T, raw json.RawMessage) shellOutput {
	t.Helper()
	var out shellOutput
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode run_shell output %s: %v", raw, err)
	}
	return out
}

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
	return "http://" + ln.Addr().String()
}

// TestSandbox_SidecarReportsTheSameHonestStatusAsTheDashboardBuild proves
// the sidecar build (backend-go/cmd/server, what harness.New actually
// spawns in this directory) carries the identical Sandboxed/SandboxBackend
// contract suites/backend/sandbox proves against the dashboard build --
// same package, same wiring, so this is a parity check rather than a
// second independent proof of the underlying sandbox mechanics.
func TestSandbox_SidecarReportsTheSameHonestStatusAsTheDashboardBuild(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot

	h.Fake().OnPrompt(fakeprovider.Contains("desktop sandbox status check")).
		ToolCall("run_shell", map[string]any{"command": "echo desktop-sandbox-marker"}).
		ThenStreamText("Done.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-desktop-sandbox-status",
		Message:        apiclient.TextMessage("msg-1", "desktop sandbox status check"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if len(turn.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %+v, want exactly one run_shell call", turn.ToolCalls)
	}
	out := decodeShellOutput(t, turn.ToolCalls[0].Output)

	if out.Sandboxed && out.SandboxBackend == "none" {
		t.Fatal("Sandboxed=true but SandboxBackend=\"none\" -- inconsistent honesty contract on the sidecar build")
	}
	if !out.Sandboxed && out.SandboxBackend != "none" {
		t.Fatalf("Sandboxed=false but SandboxBackend=%q, want \"none\"", out.SandboxBackend)
	}
	if out.SandboxBackend == "" {
		t.Fatal("SandboxBackend is empty on the sidecar build")
	}
	if !strings.Contains(out.Output, "desktop-sandbox-marker") {
		t.Errorf("Output = %q, want the echoed marker", out.Output)
	}
	t.Logf("sidecar build's detected backend: %q (sandboxed=%v)", out.SandboxBackend, out.Sandboxed)
}

// TestSandbox_SidecarBlocksWriteOutsideWorkspaceRoot is
// suites/backend/sandbox.TestSandbox_BlocksWriteOutsideWorkspaceRoot's
// sidecar-build twin.
func TestSandbox_SidecarBlocksWriteOutsideWorkspaceRoot(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "escaped-from-sidecar.txt")

	h.Fake().OnPrompt(fakeprovider.Contains("desktop sandbox escape")).
		ToolCall("run_shell", map[string]any{
			"command": "echo escaped > " + outsideFile + "; echo exit=$?",
		}).
		ThenStreamText("Ran it.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-desktop-sandbox-escape",
		Message:        apiclient.TextMessage("msg-1", "desktop sandbox escape"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	out := decodeShellOutput(t, turn.ToolCalls[0].Output)
	if !out.Sandboxed {
		h.Skip("no real sandbox backend available to the sidecar build in this environment (GOOS=" + runtime.GOOS +
			", backend reported " + out.SandboxBackend + ") -- see suites/backend/sandbox for the same reasoned skip against the dashboard build")
	}

	if _, statErr := os.Stat(outsideFile); statErr == nil {
		t.Fatalf("write outside the workspace root (%s) succeeded under the sidecar build -- backend %q did not confine it", outsideFile, out.SandboxBackend)
	}
}

// TestSandbox_SidecarNetworkDeniedByDefaultThenAllowlisted is
// suites/backend/sandbox's two network tests collapsed into one, run
// against the sidecar build: denied by default, reachable once the
// command's prefix is allow-listed via AMIRO_SANDBOX_NETWORK_ALLOW.
func TestSandbox_SidecarNetworkDeniedByDefaultThenAllowlisted(t *testing.T) {
	t.Run("denied_by_default", func(t *testing.T) {
		h := harness.New(t, harness.Tags("smoke"))
		user := h.As("user")
		root := h.Backend().WorkspaceRoot
		srv := startLoopbackServer(t)

		h.Fake().OnPrompt(fakeprovider.Contains("desktop sandbox net denied")).
			ToolCall("run_shell", map[string]any{
				"command": "curl -s -m 3 -o /dev/null -w '%{http_code}' " + srv + "/",
			}).
			ThenStreamText("Ran it.")

		turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
			ID:             "thread-desktop-sandbox-net-denied",
			Message:        apiclient.TextMessage("msg-1", "desktop sandbox net denied"),
			PermissionMode: "auto",
			WorkspaceRoot:  root,
		})
		if err != nil {
			t.Fatalf("ChatTurn: %v", err)
		}
		out := decodeShellOutput(t, turn.ToolCalls[0].Output)
		if !out.Sandboxed {
			h.Skip("no real sandbox backend available to the sidecar build in this environment (GOOS=" + runtime.GOOS + ")")
		}
		if code := strings.TrimSpace(out.Output); code != "000" {
			t.Fatalf("http_code = %q, want \"000\" with network denied by default under the sidecar build", code)
		}
	})

	t.Run("allowed_via_SandboxNetworkAllow", func(t *testing.T) {
		h := harness.New(t, harness.Tags("smoke"), harness.With(func(c *config.Config) {
			if c.Backend.Env == nil {
				c.Backend.Env = map[string]string{}
			}
			c.Backend.Env["AMIRO_SANDBOX_NETWORK_ALLOW"] = "curl"
		}))
		user := h.As("user")
		root := h.Backend().WorkspaceRoot
		srv := startLoopbackServer(t)

		h.Fake().OnPrompt(fakeprovider.Contains("desktop sandbox net allowed")).
			ToolCall("run_shell", map[string]any{
				"command": "curl -s -m 3 -o /dev/null -w '%{http_code}' " + srv + "/",
			}).
			ThenStreamText("Ran it.")

		turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
			ID:             "thread-desktop-sandbox-net-allowed",
			Message:        apiclient.TextMessage("msg-1", "desktop sandbox net allowed"),
			PermissionMode: "auto",
			WorkspaceRoot:  root,
		})
		if err != nil {
			t.Fatalf("ChatTurn: %v", err)
		}
		out := decodeShellOutput(t, turn.ToolCalls[0].Output)
		if !out.Sandboxed {
			h.Skip("no real sandbox backend available to the sidecar build in this environment (GOOS=" + runtime.GOOS + ")." +
				" AMIRO_SANDBOX_NETWORK_ALLOW is not exercisable without a real backend to enforce it.")
		}
		if code := strings.TrimSpace(out.Output); code != "200" {
			t.Fatalf("http_code = %q, want \"200\" once curl is on SandboxNetworkAllow under the sidecar build", code)
		}
	})
}
