package workspacetrust_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/fakeprovider"
)

// TestWorkspaceTrust_GrantThenRevokeRoundTrips is exit criterion 1's core
// round trip: check, grant, check, revoke, check.
func TestWorkspaceTrust_GrantThenRevokeRoundTrips(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	root := t.TempDir()

	before, err := user.WorkspaceTrustStatusFor(t.Context(), root)
	if err != nil {
		t.Fatalf("status before grant: %v", err)
	}
	if before.Trusted {
		t.Fatal("Trusted = true before any grant")
	}

	if _, err := user.GrantWorkspaceTrust(t.Context(), root); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	after, err := user.WorkspaceTrustStatusFor(t.Context(), root)
	if err != nil {
		t.Fatalf("status after grant: %v", err)
	}
	if !after.Trusted {
		t.Fatal("Trusted = false after Grant")
	}

	if err := user.RevokeWorkspaceTrust(t.Context(), root); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	final, err := user.WorkspaceTrustStatusFor(t.Context(), root)
	if err != nil {
		t.Fatalf("status after revoke: %v", err)
	}
	if final.Trusted {
		t.Fatal("Trusted = true after Revoke")
	}
}

// TestWorkspaceTrust_ListShowsAGrantedRoot backs a Settings "granted roots"
// section.
func TestWorkspaceTrust_ListShowsAGrantedRoot(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")
	root := t.TempDir()

	if _, err := user.GrantWorkspaceTrust(t.Context(), root); err != nil {
		t.Fatalf("Grant: %v", err)
	}

	grants, err := user.ListWorkspaceTrust(t.Context())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var found bool
	for _, g := range grants {
		if g.ResolvedRoot == root {
			found = true
			if g.GrantedVia != "prompt" {
				t.Errorf("grantedVia = %q, want %q for a client-initiated Grant call", g.GrantedVia, "prompt")
			}
		}
	}
	if !found {
		t.Fatalf("List() = %+v, want it to contain %q", grants, root)
	}
}

// TestWorkspaceTrust_RequireSession is the auth guard, all four routes.
func TestWorkspaceTrust_RequireSession(t *testing.T) {
	h := harness.New(t)
	anon := h.Client().Anonymous()
	root := t.TempDir()

	if _, err := anon.WorkspaceTrustStatusFor(t.Context(), root); apiclient.StatusOf(err) != 401 {
		t.Errorf("anonymous status: got status %d, want 401", apiclient.StatusOf(err))
	}
	if _, err := anon.GrantWorkspaceTrust(t.Context(), root); apiclient.StatusOf(err) != 401 {
		t.Errorf("anonymous grant: got status %d, want 401", apiclient.StatusOf(err))
	}
	if err := anon.RevokeWorkspaceTrust(t.Context(), root); apiclient.StatusOf(err) != 401 {
		t.Errorf("anonymous revoke: got status %d, want 401", apiclient.StatusOf(err))
	}
	if _, err := anon.ListWorkspaceTrust(t.Context()); apiclient.StatusOf(err) != 401 {
		t.Errorf("anonymous list: got status %d, want 401", apiclient.StatusOf(err))
	}
}

// TestWorkspaceTrust_UngrantedRootRefusesWrite is exit criterion 2, exercised
// over the real API rather than the permission package directly: a turn
// against an interactively-opened (never granted) root refuses a write_file
// call, names the missing grant, and the file is never actually created.
func TestWorkspaceTrust_UngrantedRootRefusesWrite(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := t.TempDir()

	h.Fake().OnPrompt(fakeprovider.Contains("please write")).
		ToolCall("write_file", map[string]any{"path": "note.txt", "content": "hello"}).
		ThenStreamText("I could not write that file.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-untrusted-write",
		Message:        apiclient.TextMessage("msg-1", "please write a note"),
		PermissionMode: "auto", // Auto mode too: trust gates ahead of every mode.
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	if len(turn.ToolCalls) != 1 {
		t.Fatalf("ToolCalls = %+v, want exactly one", turn.ToolCalls)
	}
	tc := turn.ToolCalls[0]
	if tc.Error == "" && !strings.Contains(string(tc.Output), "has not been granted trust") {
		t.Fatalf("tool call = %+v, want a refusal naming the missing trust grant", tc)
	}

	if _, err := os.Stat(filepath.Join(root, "note.txt")); err == nil {
		t.Fatal("note.txt was created despite the workspace never being granted trust")
	}
}

// TestWorkspaceTrust_EnvSourcedRootAutoGrants is exit criterion 3 over the
// real API: the server's own configured default workspace
// (h.Backend().WorkspaceRoot, the same root AMIRO_WORKSPACE_ROOT sets it
// to) is trusted from the very first status check -- no prior Grant call
// -- and a turn against it actually runs a write, proving the auto-grant
// is not just a status-endpoint fiction.
func TestWorkspaceTrust_EnvSourcedRootAutoGrants(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	wsRoot := h.Backend().WorkspaceRoot

	status, err := user.WorkspaceTrustStatusFor(t.Context(), wsRoot)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.Trusted {
		t.Fatal("the server's own default workspace must read as trusted before any turn or Grant call")
	}

	h.Fake().OnPrompt(fakeprovider.Contains("please write")).
		ToolCall("write_file", map[string]any{"path": "note.txt", "content": "hello"}).
		ThenStreamText("Done.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-env-write",
		Message:        apiclient.TextMessage("msg-1", "please write a note"),
		PermissionMode: "auto",
		WorkspaceRoot:  wsRoot, // explicitly echoed, as the TUI always does
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if len(turn.ToolCalls) != 1 || turn.ToolCalls[0].Error != "" {
		t.Fatalf("ToolCalls = %+v, want one successful write_file call", turn.ToolCalls)
	}

	if _, err := os.Stat(filepath.Join(wsRoot, "note.txt")); err != nil {
		t.Fatalf("note.txt was not created against the auto-granted default workspace: %v", err)
	}
}
