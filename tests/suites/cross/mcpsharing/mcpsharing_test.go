// Package mcpsharing_test proves Phase 7's "MCP sharing" cross-surface
// journey, quoted verbatim from the Section 1 table of
// docs/testing/phases/phase-07-cross-surface.md:
//
//	| MCP sharing | An MCP server configured in one client is visible in the other |
//
// and contributes to Exit Criterion 1, quoted verbatim: "`amirotest run
// --surface cross` passes, and every cross-surface journey above has a
// test."
//
// WHERE AN MCP SERVER ACTUALLY LIVES, WHICH IS WHY THIS IS CROSS-SURFACE.
// An MCP server is not process-level configuration and not a file either
// client reads: it is a per-user row, written by POST /api/mcp and read by
// GET /api/mcp/list (internal/api/mcp, internal/mcp/manager.go's List, which
// scopes to the calling user and merges in the live connection's tool list).
// So "configured in one client, visible in the other" is a claim about the
// one database that both clients read -- exactly the claim `cross` exists
// for, and exactly the kind of claim a second apiclient.Client tests
// faithfully.
//
// TWO LEVELS, BECAUSE THE ROW DESERVES BOTH.
//   - Visible at the API: a second client lists the server, reads back its
//     live tool list, and calls one of its tools. Configuration alone would
//     be a weaker claim than "usable".
//   - Visible in the TUI: the real `amiro` binary under a real PTY offers
//     that server's tools in `@`-completion, read off the rendered frame.
//     That is the form "visible in the other client" takes for a terminal,
//     and it is not substituted.
//
// The MCP server itself is the repo's own stdio fixture
// (tests/fixtures/mcp/server) -- the same fixture
// suites/backend/chat/mcp_test.go uses -- spawned by the backend exactly as
// a user's stdio server would be. See fixtureBinary for why it is compiled
// ahead of time rather than launched with `go run`.
package mcpsharing_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/pty"
)

// mcpListRow is the subset of internal/mcp.ServerInfo that GET /api/mcp/list
// returns and this test reads. Transcribed, not imported.
type mcpListRow struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ToolInfo []struct {
		Name string `json:"name"`
	} `json:"toolInfo"`
}

// fixtureBinary compiles tests/fixtures/mcp/server once per test binary and
// returns the executable's path.
//
// Deliberately NOT `go run <main.go>`, which is how
// suites/backend/chat/mcp_test.go spawns the same fixture: `go run` compiles
// and links on every spawn, and internal/mcp gives a server 20 seconds to
// finish connecting. On a cold build cache -- or a warm machine running the
// rest of this suite in parallel -- that budget is genuinely exceeded, and
// the failure reads as "mcp: connecting to server ... timed out" rather than
// as what it is. Building once removes the compile from the connect path
// entirely instead of widening a timeout that is the application's, not the
// test's.
var (
	fixtureOnce sync.Once
	fixturePath string
	fixtureErr  error
)

func fixtureBinary(t *testing.T, h *harness.Harness) string {
	t.Helper()
	fixtureOnce.Do(func() {
		dir := filepath.Join(h.RunDir(), "cross-mcp-fixture")
		if fixtureErr = os.MkdirAll(dir, 0o755); fixtureErr != nil {
			return
		}
		out := filepath.Join(dir, "mcp-fixture")
		cmd := exec.Command("go", "build", "-o", out, "./fixtures/mcp/server")
		cmd.Dir = h.BaseDir
		if combined, err := cmd.CombinedOutput(); err != nil {
			fixtureErr = fmt.Errorf("building the MCP fixture server: %w\n%s", err, combined)
			return
		}
		fixturePath = out
	})
	if fixtureErr != nil {
		t.Fatalf("%v", fixtureErr)
	}
	return fixturePath
}

func fixtureServer(t *testing.T, h *harness.Harness, name string) apiclient.MCPServerInput {
	t.Helper()
	return apiclient.MCPServerInput{
		Name:       name,
		Config:     apiclient.StdioConfig{Command: fixtureBinary(t, h)},
		Visibility: "private",
	}
}

func TestCrossSurface_MCPServerConfiguredInOneClientIsVisibleAndUsableInTheOther(t *testing.T) {
	const serverName = "crossmcpshared"

	h := harness.New(t, harness.Tags("smoke"))
	h.Backend()

	id := h.Identity("admin")
	browser := h.Client().As("browser", id.Token)
	terminal := h.Client().As("tui", id.Token)

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	saved, err := browser.SaveMCPServer(ctx, fixtureServer(t, h, serverName))
	if err != nil {
		t.Fatalf("configuring the MCP server from the browser-side client: %v", err)
	}
	t.Cleanup(func() { _ = browser.DeleteMCPServer(context.Background(), saved.ID) })

	// The other client lists it. The fixture still has to start and hand
	// over its tool list, so this polls the real API rather than assuming the
	// connection is already up -- and reports the last thing it saw if it
	// never does.
	var seenTools []string
	assert.Eventually(t, "the terminal-side client to see the browser's MCP server with its tools", 90*time.Second, func() error {
		raw, err := terminal.ListMCPServers(ctx)
		if err != nil {
			return err
		}
		var rows []mcpListRow
		if err := json.Unmarshal(raw, &rows); err != nil {
			return err
		}
		for _, row := range rows {
			if row.ID != saved.ID {
				continue
			}
			if row.Name != serverName {
				return &mismatch{what: "name", got: row.Name, want: serverName}
			}
			seenTools = seenTools[:0]
			for _, ti := range row.ToolInfo {
				seenTools = append(seenTools, ti.Name)
			}
			for _, want := range []string{"echo"} {
				if !contains(seenTools, want) {
					return &mismatch{what: "tool list", got: strings.Join(seenTools, ","), want: want}
				}
			}
			return nil
		}
		return &mismatch{what: "server id", got: raw2names(rows), want: saved.ID}
	})

	// Visible is one thing; usable from the other client is the thing that
	// matters. This is the second client driving the first client's server.
	out, err := terminal.CallMCPTool(ctx, saved.ID, "echo", map[string]any{
		"message": "hello from the other client",
	})
	if err != nil {
		t.Fatalf("the terminal-side client could not call a tool on the server the browser configured: %v", err)
	}
	if !strings.Contains(string(out), "echo: hello from the other client") {
		t.Errorf("the echo tool returned %s, which does not carry the terminal-side client's message", out)
	}
}

func TestCrossSurface_MCPServerConfiguredInTheDashboardIsOfferedByTUIMentionCompletion(t *testing.T) {
	const serverName = "crossmcpmention"

	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()
	browser := h.As("admin")

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	saved, err := browser.SaveMCPServer(ctx, fixtureServer(t, h, serverName))
	if err != nil {
		t.Fatalf("configuring the MCP server from the browser-side client: %v", err)
	}
	t.Cleanup(func() { _ = browser.DeleteMCPServer(context.Background(), saved.ID) })

	// The TUI loads its mention candidates once, at startup
	// (internal/tui/page/mentions.go), so the server's tool list has to be
	// live before the TUI is launched -- calling a tool is the deterministic
	// way to make that true, rather than hoping the connection has settled.
	if _, err := browser.CallMCPTool(ctx, saved.ID, "echo", map[string]any{"message": "warm up"}); err != nil {
		t.Fatalf("warming up the fixture MCP server: %v", err)
	}

	sess := h.PTY(
		harness.PTYAppDataDir(be.AppDataDir),
		harness.PTYDir(be.WorkspaceRoot),
		harness.PTYDims(180, 60),
	)
	defer sess.Close()

	if err := sess.WaitForText("Ask Amiro", 15*time.Second); err != nil {
		t.Fatalf("the TUI did not render its prompt: %v\nframe:\n%s", err, sess.Frame())
	}
	if err := sess.Send("@" + serverName + "/"); err != nil {
		t.Fatalf("typing the mention prefix: %v", err)
	}

	// editor.MCPToolMentions names an MCP tool "server/tool" with the help
	// text "MCP tool on <server>" -- the whole row, so this cannot be
	// satisfied by the composer echoing back what was typed.
	want := "@" + serverName + "/echo  MCP tool on " + serverName
	if err := sess.WaitForFrame(func(b *pty.Buffer) bool {
		return strings.Contains(unwrapped(b.Plain()), want)
	}, 15*time.Second); err != nil {
		t.Fatalf("the TUI's @-completion never offered the MCP server configured through the dashboard "+
			"(looked for the popup row %q): %v\nframe:\n%s", want, err, sess.Frame())
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func raw2names(rows []mcpListRow) string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID+"("+r.Name+")")
	}
	if len(out) == 0 {
		return "(no servers at all)"
	}
	return strings.Join(out, ", ")
}

// mismatch carries the last observed state into assert.Eventually's timeout
// message, which is the whole reason that helper reports the last error
// instead of a bare deadline.
type mismatch struct{ what, got, want string }

func (m *mismatch) Error() string {
	return "the other client's " + m.what + " is " + m.got + ", waiting for " + m.want
}

// unwrapped joins a rendered frame's lines back together, undoing the
// terminal's own hard wrap at the right margin. See the same helper in
// suites/cross/skills for the full reasoning.
func unwrapped(frame string) string {
	return strings.ReplaceAll(frame, "\n", "")
}
