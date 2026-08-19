package resilience_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// MCP faults. The phase document's row is:
//
//	The fixture server crashes, hangs, returns oversized payloads, or speaks
//	bad protocol
//
// Two of those already have tests in suites/backend/chat/mcp_test.go and
// are not repeated here:
//
//   - crashes -- TestMCP_CrashAndReconnect drives the fixture's `crash`
//     tool and asserts the same server id works again afterwards.
//   - hangs -- TestMCP_TimeoutHandling drives the fixture's `slow` tool
//     with a 10s delay behind a 500ms context and asserts the call aborts.
//
// The two that had no test anywhere are here: oversized payloads and bad
// protocol. The oversized case drives the existing fixture's `big` tool.
// The bad-protocol case adds no fixture at all -- it points the stdio
// transport at a shell command, which is the more honest shape for it,
// since the whole point is a peer that is not the fixture and never was.
//
// One extra case is added that the phase document's wording folds into
// "crashes" but which is a genuinely different code path: a server that
// dies before the handshake, so there is never a session to lose. A client
// that only handles losing an established session hangs here.

// mcpFixtureCommand is the deterministic fixture server, as a COMPILED
// BINARY rather than as `go run`.
//
// suites/backend/chat/mcp_test.go runs it with `go run`, and that works
// there. It does not work here, and finding out why is worth recording,
// because the failure was a 20s timeout that looked exactly like the
// application being slow:
//
// harness/backend.Env gives every spawned backend its own HOME and
// XDG_CACHE_HOME inside the run directory, which is correct and deliberate
// -- a test must not write to the developer's real config. The consequence
// is that a `go run` the BACKEND spawns sees an empty GOCACHE and compiles
// the fixture and its stdlib dependencies from scratch, measured here at
// ~9s on an idle machine and well over 20s under load. The MCP connect
// timeout is 20s. So a perfectly healthy fixture server intermittently
// fails to connect, and it fails MORE the more MCP tests a file has, since
// each test gets its own empty cache.
//
// Compiling once, in the test process, with the developer's warm cache,
// removes the compile from inside the timeout entirely. It also makes this
// file several times faster.
func mcpFixtureCommand(t *testing.T, h *harness.Harness) apiclient.StdioConfig {
	t.Helper()
	return apiclient.StdioConfig{Command: mcpFixtureBinary(t, h)}
}

var (
	mcpFixtureOnce sync.Once
	mcpFixturePath string
	mcpFixtureErr  error
)

// mcpFixtureBinary builds fixtures/mcp/server once per test binary.
func mcpFixtureBinary(t *testing.T, h *harness.Harness) string {
	t.Helper()
	mcpFixtureOnce.Do(func() {
		out := filepath.Join(h.RunDir(), "mcp-fixture"+exeSuffix())
		src := filepath.Join(h.BaseDir, "fixtures", "mcp", "server", "main.go")
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "go", "build", "-o", out, src)
		cmd.Dir = h.BaseDir
		combined, err := cmd.CombinedOutput()
		if err != nil {
			mcpFixtureErr = fmt.Errorf("building the MCP fixture server: %w\n%s", err, combined)
			return
		}
		mcpFixturePath = out
	})
	if mcpFixtureErr != nil {
		t.Fatalf("%v", mcpFixtureErr)
	}
	return mcpFixturePath
}

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

// trySaveMCPServer registers a server config, bounded, and hands back
// whatever happened.
//
// POST /api/mcp CONNECTS as part of saving -- it is not a config write that
// defers the handshake to first use. That is where every fault in this file
// except the oversized one actually surfaces, and discovering it is what
// turned these tests from "call a tool and see" into what they are now.
func trySaveMCPServer(t *testing.T, h *harness.Harness, c *apiclient.Client, name string,
	cfg apiclient.StdioConfig, within time.Duration) (apiclient.MCPServer, error) {
	t.Helper()
	var server apiclient.MCPServer
	var err error
	runBounded(t, h, "saving MCP server "+name, within, func(ctx context.Context) {
		server, err = c.SaveMCPServer(ctx, apiclient.MCPServerInput{
			Name:       name,
			Config:     cfg,
			Visibility: "private",
		})
	})
	if err == nil && server.ID != "" {
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = c.DeleteMCPServer(ctx, server.ID)
		})
	}
	return server, err
}

// saveMCPServer is trySaveMCPServer for the servers a test needs to work.
func saveMCPServer(t *testing.T, h *harness.Harness, c *apiclient.Client, name string, cfg apiclient.StdioConfig) apiclient.MCPServer {
	t.Helper()
	server, err := trySaveMCPServer(t, h, c, name, cfg, 90*time.Second)
	if err != nil {
		t.Fatalf("saving MCP server %s: %v", name, err)
	}
	return server
}

// TestResilience_MCPOversizedPayloadDoesNotHangOrCorrupt asks the fixture
// for a tool result far larger than any real one and asserts the backend
// either delivers it whole or refuses it -- and in particular that it never
// delivers a truncated result as if it were complete.
//
// Silent truncation is the specific danger with a size limit on a pipe: the
// model would be handed a prefix of a file or a search result and reason
// about it as if it were the whole thing, which is a wrong answer with no
// error anywhere. "Never a silent partial write" reads in both directions.
func TestResilience_MCPOversizedPayloadDoesNotHangOrCorrupt(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	server := saveMCPServer(t, h, user, "resilience-mcp-oversized", mcpFixtureCommand(t, h))

	const sizeKB = 16 * 1024 // 16 MiB of a single repeated character.
	var raw json.RawMessage
	var err error
	runBounded(t, h, "an MCP tool call returning 16 MiB", 120*time.Second, func(ctx context.Context) {
		raw, err = user.CallMCPTool(ctx, server.ID, "big", map[string]any{"size_kb": sizeKB})
	})

	switch {
	case err != nil:
		// A refusal is a perfectly good answer, as long as it is an answer.
		t.Logf("the backend refused a %d KiB MCP payload: %v", sizeKB, err)
	default:
		// Delivered. Then it must be delivered WHOLE. The fixture returns
		// exactly sizeKB*1024 'A's, so anything shorter is truncation.
		payload := string(raw)
		got := strings.Count(payload, "A")
		want := sizeKB * 1024
		t.Logf("the backend delivered a %d KiB MCP payload as %d bytes of JSON", sizeKB, len(payload))
		if got != want {
			t.Errorf("an oversized MCP tool result came back truncated with no error: "+
				"the fixture returned %d 'A' characters, the response carries %d.\n"+
				"  A model handed a silent prefix of a tool result reasons about it as if it were "+
				"the whole thing; a refusal would be better than this.", want, got)
		}
	}

	assertBackendHealthy(t, h, user, "an oversized MCP payload")
	assertMCPStillWorks(t, h, user, server.ID, "after an oversized payload")
}

// TestResilience_MCPBadProtocolProducesCleanError points the stdio
// transport at a process that is alive, reads its input, and answers with
// something that is not JSON-RPC at all.
//
// A peer that is dead is easy to notice. A peer that is healthy, responsive
// and wrong is the one that hangs a client written around "wait for the
// reply with this id" -- the reply never comes and nothing ever closes.
func TestResilience_MCPBadProtocolProducesCleanError(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	// Answers every line with a well-formed line of nonsense, and never
	// closes stdin, so the transport stays open for as long as the backend
	// keeps it. Nothing here is ever going to satisfy a JSON-RPC reader
	// waiting for a matching id.
	server, err := trySaveMCPServer(t, h, user, "resilience-mcp-bad-protocol", apiclient.StdioConfig{
		Command: "sh",
		Args:    []string{"-c", `while IFS= read -r line; do echo "this is not json-rpc"; done`},
	}, 90*time.Second)

	if err == nil {
		// If the handshake somehow succeeded, the tool call is where the
		// nonsense has to surface instead.
		t.Logf("the bad-protocol peer was accepted at save time; asserting on the tool call instead")
		var callErr error
		runBounded(t, h, "calling a tool on an MCP server that speaks nonsense", 90*time.Second, func(ctx context.Context) {
			_, callErr = user.CallMCPTool(ctx, server.ID, "echo", map[string]any{"message": "hello"})
		})
		if callErr == nil {
			t.Errorf("calling a tool on a peer that only ever answers %q reported success; "+
				"the backend cannot have received a tool result it could believe", "this is not json-rpc")
		}
	} else {
		// The expected path: POST /api/mcp handshakes, the handshake never
		// completes, and the client is told -- with the server's name and
		// the timeout in the message, which is what makes it actionable.
		t.Logf("saving a bad-protocol MCP peer failed cleanly: %v", err)
		if status := apiclient.StatusOf(err); status == 0 {
			t.Errorf("the failure carried no HTTP status at all, which means the request did not "+
				"complete: %v", err)
		} else if status >= 500 {
			// Recorded, not failed. A peer the operator configured wrongly is
			// arguably a client error, but a 500 with an accurate message is
			// still a clean, client-visible error, which is the bar here.
			t.Logf("NOTE: a misconfigured MCP peer is reported as HTTP %d; the message is accurate "+
				"but the status says the server failed rather than the configuration", status)
		}
		if !strings.Contains(err.Error(), "resilience-mcp-bad-protocol") {
			t.Errorf("the error does not name which MCP server failed, so an operator with several "+
				"cannot tell which one to fix: %v", err)
		}
	}

	assertBackendHealthy(t, h, user, "an MCP peer speaking bad protocol")
	assertGoodMCPServerStillWorks(t, h, user, "after a bad-protocol peer")
}

// TestResilience_MCPServerDiesBeforeHandshakeProducesCleanError points the
// transport at a command that exits immediately.
//
// Distinct from suites/backend/chat/mcp_test.go's TestMCP_CrashAndReconnect,
// which crashes a server that had already handshaked and answered a call.
// Here there is never a session at all: the pipe closes while the client is
// still waiting for `initialize`. A client that handles "my session died"
// but not "there was never a session" waits forever right here.
func TestResilience_MCPServerDiesBeforeHandshakeProducesCleanError(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	started := time.Now()
	server, err := trySaveMCPServer(t, h, user, "resilience-mcp-stillborn", apiclient.StdioConfig{
		Command: "sh",
		Args:    []string{"-c", "exit 3"},
	}, 90*time.Second)
	elapsed := time.Since(started)

	if err == nil {
		t.Logf("the stillborn peer was accepted at save time; asserting on the tool call instead")
		var callErr error
		runBounded(t, h, "calling a tool on an MCP server that exits immediately", 90*time.Second, func(ctx context.Context) {
			_, callErr = user.CallMCPTool(ctx, server.ID, "echo", map[string]any{"message": "hello"})
		})
		if callErr == nil {
			t.Errorf("calling a tool on an MCP command that exits with status 3 before saying anything reported success")
		}
	} else {
		t.Logf("a stillborn MCP peer failed cleanly after %s: %v", elapsed.Round(time.Millisecond), err)
		// FINDING, recorded rather than asserted: the failure arrives on the
		// connect TIMEOUT, not on the child process exiting. `sh -c "exit 3"`
		// is gone in milliseconds and its stdout closes with it, which the
		// transport could notice immediately; instead the operator waits the
		// full connect budget for a peer that was never going to answer.
		// Clean, and slow. Closing it means the stdio transport failing on
		// EOF from the child rather than only on the timer.
		if elapsed > 10*time.Second {
			t.Logf("NOTE: a peer that exited immediately still cost %s to report, "+
				"which is the connect timeout rather than the child's exit (see the FINDING comment)",
				elapsed.Round(time.Millisecond))
		}
	}

	assertBackendHealthy(t, h, user, "an MCP server that died before the handshake")
	assertGoodMCPServerStillWorks(t, h, user, "after a stillborn peer")
}

// assertMCPStillWorks is the recoverable-state half for a server that is
// expected to survive the fault: the same server id, still usable.
func assertMCPStillWorks(t *testing.T, h *harness.Harness, c *apiclient.Client, serverID, when string) {
	t.Helper()
	var raw json.RawMessage
	var err error
	runBounded(t, h, "an ordinary MCP echo call "+when, 60*time.Second, func(ctx context.Context) {
		raw, err = c.CallMCPTool(ctx, serverID, "echo", map[string]any{"message": "still here"})
	})
	if err != nil {
		t.Fatalf("MCP server %s is unusable %s: %v", serverID, when, err)
	}
	if !strings.Contains(string(raw), "echo: still here") {
		t.Errorf("MCP server %s answered %s with %s, want it to echo the message",
			serverID, when, truncateForLog(string(raw)))
	}
}

// assertGoodMCPServerStillWorks is the recoverable-state half for the
// faults where the faulty server itself is beyond saving: a NEW, healthy
// MCP server must still register and answer.
//
// That is the assertion that catches a leaked transport, a wedged
// per-user MCP manager, or a mutex the failed connection never released --
// none of which the failing call itself would reveal.
func assertGoodMCPServerStillWorks(t *testing.T, h *harness.Harness, c *apiclient.Client, when string) {
	t.Helper()
	good := saveMCPServer(t, h, c, "resilience-mcp-good"+strings.ReplaceAll(when, " ", "-"), mcpFixtureCommand(t, h))
	assertMCPStillWorks(t, h, c, good.ID, when)
}
