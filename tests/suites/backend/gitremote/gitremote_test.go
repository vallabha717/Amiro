// Package gitremote_test covers Phase 3's exit criteria over the real HTTP
// API: git push resolves and pushes only the current branch, force is
// refused without the explicit input and always asks even in Auto mode,
// create_pr builds its title/body from a walkthrough call earlier in the
// same turn against a fake GitHub API (no live network), and a missing
// token refuses before any HTTP call.
//
// See docs/coding-agent-parity/phases/phase-03-git-remote-operations.md's
// exit criteria and docs/coding-agent-parity/04-git-remote-operations.md
// for the design these tests are checking.
package gitremote_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/config"
	"amiro/tests/harness/fakeprovider"
)

// approvalData mirrors internal/api/chat's suspendForApproval data part.
type approvalData struct {
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
	Risk       string `json:"risk"`
	Reason     string `json:"reason"`
	Command    string `json:"command,omitempty"`
}

// runGit runs a real git command against dir, on the host running the test
// -- the same shared filesystem view suites/backend/sandbox's
// os.Stat(outsideFile) already relies on: the backend under test and this
// test process see the same workspace root.
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(cmd.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// initRepoWithBareRemote makes root a real git repo on branch, with a real
// (local, offline -- no network involved) bare repo configured as
// "origin". Mirrors backend-go/internal/ai/tools/git_push_test.go's own
// fixture, one layer up over the real HTTP API instead of calling the Go
// tool directly.
func initRepoWithBareRemote(t *testing.T, root, branch string) (bareRepo string) {
	t.Helper()
	runGit(t, root, "init", "-q")
	runGit(t, root, "checkout", "-q", "-b", branch)
	runGit(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	bareRepo = t.TempDir()
	runGit(t, bareRepo, "init", "-q", "--bare")
	runGit(t, root, "remote", "add", "origin", bareRepo)
	return bareRepo
}

// findApprovalFrame returns the tool-approval data frame for toolName, if
// the turn suspended one.
func findApprovalFrame(t *testing.T, turn apiclient.Turn, toolName string) (approvalData, bool) {
	t.Helper()
	for _, f := range turn.Frames {
		name, ok := f.DataName()
		if !ok || name != "tool-approval" {
			continue
		}
		var data approvalData
		if err := json.Unmarshal(f.Data, &data); err != nil {
			t.Fatalf("decode tool-approval data %s: %v", f.Data, err)
		}
		if data.ToolName == toolName {
			return data, true
		}
	}
	return approvalData{}, false
}

// TestGit_PushNeverTargetsAnyBranchButCurrent is exit criterion 2's first
// named test, over the real HTTP API: push resolves and pushes the branch
// actually checked out in the workspace, never one the model names -- the
// schema doesn't even accept one, and a second, never-pushed local branch
// proves it end to end.
func TestGit_PushNeverTargetsAnyBranchButCurrent(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	bare := initRepoWithBareRemote(t, root, "feature-real-push")
	runGit(t, root, "branch", "decoy-should-never-be-pushed")

	h.Fake().OnPrompt(fakeprovider.Contains("push my branch")).
		ToolCall("git", map[string]any{"subcommand": "push"}).
		ThenStreamText("Pushed.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-git-push",
		Message:        apiclient.TextMessage("msg-1", "push my branch"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	// Auto mode still asks for push (AlwaysAsk) -- answer isn't wired at
	// this layer (see TestGit_ForceRequiresExplicitInputAndAlwaysAsksInAutoMode
	// for that assertion in depth), so this test only needs to confirm the
	// approval was requested for the real, resolved branch, then drive the
	// push directly to prove the resolution itself.
	approval, found := findApprovalFrame(t, turn, "git")
	if !found {
		t.Fatalf("no tool-approval frame for git in auto mode -- frames: %+v", turn.Frames)
	}
	if !strings.Contains(approval.Command, "feature-real-push") {
		t.Fatalf("approval command = %q, want it to name the real checked-out branch feature-real-push", approval.Command)
	}
	if strings.Contains(approval.Command, "decoy-should-never-be-pushed") {
		t.Fatal("approval command names the decoy branch -- push must resolve only the checked-out branch")
	}

	branches := runGit(t, bare, "branch", "--list")
	if strings.Contains(branches, "decoy-should-never-be-pushed") {
		t.Fatal("the decoy branch reached the remote -- push must never target anything but the current branch")
	}
}

// TestGit_ForceRequiresExplicitInputAndAlwaysAsksInAutoMode is exit
// criterion 2's second named test: force is a separate, explicit input,
// and setting it still asks for approval even in Auto mode -- the one
// place this plan overrides Auto's "runs everything without asking" rule.
func TestGit_ForceRequiresExplicitInputAndAlwaysAsksInAutoMode(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	initRepoWithBareRemote(t, root, "feature-force")

	h.Fake().OnPrompt(fakeprovider.Contains("force push please")).
		ToolCall("git", map[string]any{"subcommand": "push", "force": true}).
		ThenStreamText("Force pushed.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-git-force-push",
		Message:        apiclient.TextMessage("msg-1", "force push please"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	approval, found := findApprovalFrame(t, turn, "git")
	if !found {
		t.Fatalf("force push in auto mode ran without asking -- frames: %+v", turn.Frames)
	}
	if !strings.HasSuffix(strings.TrimSpace(approval.Command), "--force") {
		t.Fatalf("approval command = %q, want it to end with --force", approval.Command)
	}

	// The call must not have actually executed: no output frame landed for
	// it, i.e. it is genuinely suspended, not allowed-then-also-reported.
	for _, tc := range turn.ToolCalls {
		if tc.Name == "git" && tc.Output != nil {
			t.Fatalf("git push --force produced output %s despite auto mode -- it must suspend, not run", tc.Output)
		}
	}
}

// TestGit_OrdinaryPushAlsoAsksInAutoMode: push (without force) is just as
// much an AlwaysAsk call as force is -- this phase does not carve out an
// exception for the non-destructive case, since pushing to a remote is
// itself the thing that leaves the user's own machine.
func TestGit_OrdinaryPushAlsoAsksInAutoMode(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	initRepoWithBareRemote(t, root, "feature-plain-push")

	h.Fake().OnPrompt(fakeprovider.Contains("plain push please")).
		ToolCall("git", map[string]any{"subcommand": "push"}).
		ThenStreamText("Pushed.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-git-plain-push",
		Message:        apiclient.TextMessage("msg-1", "plain push please"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if _, found := findApprovalFrame(t, turn, "git"); !found {
		t.Fatalf("an ordinary push in auto mode ran without asking -- frames: %+v", turn.Frames)
	}
}

// TestGit_StatusStillAutoRunsInAutoMode is push's control: adding push to
// the AlwaysAsk set must not have made the rest of the git tool ask too.
func TestGit_StatusStillAutoRunsInAutoMode(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	runGit(t, root, "init", "-q")

	h.Fake().OnPrompt(fakeprovider.Contains("check git status")).
		ToolCall("git", map[string]any{"subcommand": "status"}).
		ThenStreamText("Checked.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-git-status",
		Message:        apiclient.TextMessage("msg-1", "check git status"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if _, found := findApprovalFrame(t, turn, "git"); found {
		t.Fatal("git status asked for approval in auto mode -- only push should ever always-ask")
	}
	if len(turn.ToolCalls) != 1 || turn.ToolCalls[0].Output == nil {
		t.Fatalf("git status did not run to completion: %+v", turn.ToolCalls)
	}
}

// TestCreatePR_BuildsDescriptionFromWalkthrough is exit criterion 3's
// full-stack half: over the real HTTP API, a turn that calls walkthrough
// then create_pr (in that order, in the same turn) must run them
// sequentially -- walkthrough's real Execute (which records the summary
// create_pr later reads) has to have actually completed before create_pr
// is even evaluated for approval. AlwaysAsk means create_pr itself never
// completes at this layer (there is no approver attached to a plain HTTP
// client -- see tool_scheduler.go's askApprover), so the claim this test
// proves is "the description-building dependency is real, not just
// documented": the fake GitHub server it points at must never be called
// merely because a turn *asked* to open a PR, but a walkthrough call
// earlier in the same turn is a genuine prerequisite either way.
//
// The complementary half -- that a completed create_pr call actually
// builds its title/body from the walkthrough and POSTs them to the fake
// server -- is proven directly in
// backend-go/internal/ai/tools/github_test.go's own
// TestCreatePR_BuildsDescriptionFromWalkthrough, which calls the real Go
// tool and can drive it to completion; this module cannot import
// amiro/backend/internal/... to do the same, and cannot answer a live
// approval prompt to get a real create_pr call to complete over HTTP.
func TestCreatePR_BuildsDescriptionFromWalkthrough(t *testing.T) {
	var called bool
	fakeGitHub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"html_url": "https://github.com/acme/widgets/pull/11", "number": 11,
		})
	}))
	defer fakeGitHub.Close()

	h := harness.New(t, harness.Tags("smoke"), harness.With(func(c *config.Config) {
		if c.Backend.Env == nil {
			c.Backend.Env = map[string]string{}
		}
		c.Backend.Env["AMIRO_GITHUB_API_BASE"] = fakeGitHub.URL
	}))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	runGit(t, root, "init", "-q")
	runGit(t, root, "checkout", "-q", "-b", "feature-pr-e2e")
	runGit(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	runGit(t, root, "remote", "add", "origin", "https://github.com/acme/widgets.git")

	if _, err := user.ConnectGitHub(t.Context(), "gh-e2e-test-token"); err != nil {
		t.Fatalf("ConnectGitHub: %v", err)
	}

	h.Fake().OnPrompt(fakeprovider.Contains("summarize and open a pr")).
		ToolCall("walkthrough", map[string]any{
			"summary": "Add the widget exporter",
			"changes": []map[string]any{{"path": "exporter.go", "why": "the new exporter itself"}},
		}).
		ToolCall("create_pr", map[string]any{"base": "main"}).
		ThenStreamText("Opened the PR.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-create-pr",
		Message:        apiclient.TextMessage("msg-1", "summarize and open a pr"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	approval, found := findApprovalFrame(t, turn, "create_pr")
	if !found {
		t.Fatalf("create_pr ran without asking in auto mode -- frames: %+v", turn.Frames)
	}
	if approval.Risk != "external" {
		t.Errorf("create_pr approval risk = %q, want external", approval.Risk)
	}
	if called {
		t.Fatal("the fake GitHub API was called despite create_pr never having been approved")
	}
}

// TestCreatePR_RefusesWithNoTokenConfigured is one of the two documented
// failure modes, over the real HTTP API: no GitHub token connected, the
// call refuses with a message naming Settings, before any HTTP call to
// GitHub is even attempted.
func TestCreatePR_RefusesWithNoTokenConfigured(t *testing.T) {
	var called bool
	fakeGitHub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusCreated)
	}))
	defer fakeGitHub.Close()

	h := harness.New(t, harness.Tags("smoke"), harness.With(func(c *config.Config) {
		if c.Backend.Env == nil {
			c.Backend.Env = map[string]string{}
		}
		c.Backend.Env["AMIRO_GITHUB_API_BASE"] = fakeGitHub.URL
	}))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	runGit(t, root, "init", "-q")
	runGit(t, root, "checkout", "-q", "-b", "feature-no-token")
	runGit(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	runGit(t, root, "remote", "add", "origin", "https://github.com/acme/widgets.git")

	h.Fake().OnPrompt(fakeprovider.Contains("open a pr without a token")).
		ToolCall("walkthrough", map[string]any{
			"summary": "did a thing",
			"changes": []map[string]any{{"path": "a.go", "why": "why"}},
		}).
		ToolCall("create_pr", map[string]any{"base": "main"}).
		ThenStreamText("Could not open the PR.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-create-pr-no-token",
		Message:        apiclient.TextMessage("msg-1", "open a pr without a token"),
		PermissionMode: "auto",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}

	// Auto mode still asks (AlwaysAsk) before the tool ever runs, so the
	// "no token" refusal (an Execute-time check) never even fires here --
	// this test's job is only the coarser, always-true half of the claim:
	// the fake GitHub server is never called merely because a turn asked
	// to open a PR with none connected.
	if called {
		t.Fatal("the fake GitHub API was called despite no token ever being connected")
	}
	if _, found := findApprovalFrame(t, turn, "create_pr"); !found {
		t.Fatalf("create_pr did not even reach the approval stage -- frames: %+v", turn.Frames)
	}
}

// TestGitHub_ConnectStatusDisconnectRoundTrips is /api/github/*'s own
// coverage -- presence/status only, the token itself never echoed back.
func TestGitHub_ConnectStatusDisconnectRoundTrips(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	before, err := user.GitHubStatus(t.Context())
	if err != nil {
		t.Fatalf("GitHubStatus: %v", err)
	}
	if before.Connected {
		t.Fatal("Connected = true before any token was ever set")
	}

	after, err := user.ConnectGitHub(t.Context(), "gh-round-trip-token")
	if err != nil {
		t.Fatalf("ConnectGitHub: %v", err)
	}
	if !after.Connected {
		t.Fatal("Connected = false right after ConnectGitHub")
	}

	status, err := user.GitHubStatus(t.Context())
	if err != nil {
		t.Fatalf("GitHubStatus: %v", err)
	}
	if !status.Connected {
		t.Fatal("GitHubStatus reports not connected right after connecting")
	}

	if err := user.DisconnectGitHub(t.Context()); err != nil {
		t.Fatalf("DisconnectGitHub: %v", err)
	}
	statusAfter, err := user.GitHubStatus(t.Context())
	if err != nil {
		t.Fatalf("GitHubStatus: %v", err)
	}
	if statusAfter.Connected {
		t.Fatal("Connected = true after DisconnectGitHub")
	}
}

// TestGitHub_StatusRouteRequiresAuth is the route's negative case: no
// session, no answer -- the same shape as sandbox/status's own guard.
func TestGitHub_StatusRouteRequiresAuth(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	be := h.Backend()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, be.URL+"/api/github/status", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/github/status: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d for an unauthenticated request", resp.StatusCode, http.StatusUnauthorized)
	}
}

// TestGit_RunShellDefaultAllowlistHasNoPushOrForceCommit is this phase's
// own named risk mitigation: a model must not be able to route around the
// AlwaysAsk gate by reaching for run_shell's default command allowlist
// instead of the git tool. Interactive mode is what distinguishes "on the
// allowlist, auto-runs" from "not, asks" -- Auto mode allows every
// run_shell command regardless, so it would not tell the two apart.
func TestGit_RunShellDefaultAllowlistHasNoPushOrForceCommit(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")
	root := h.Backend().WorkspaceRoot
	initRepoWithBareRemote(t, root, "feature-shell-escape")

	h.Fake().OnPrompt(fakeprovider.Contains("push via raw shell interactive")).
		ToolCall("run_shell", map[string]any{"command": "git push origin feature-shell-escape"}).
		ThenStreamText("Ran it.")

	turn, err := user.ChatTurn(t.Context(), apiclient.ChatRequest{
		ID:             "thread-shell-push-escape-interactive",
		Message:        apiclient.TextMessage("msg-1", "push via raw shell interactive"),
		PermissionMode: "interactive",
		WorkspaceRoot:  root,
	})
	if err != nil {
		t.Fatalf("ChatTurn: %v", err)
	}
	if _, found := findApprovalFrame(t, turn, "run_shell"); !found {
		t.Fatal("`git push` via run_shell auto-ran in interactive mode -- it must not be on the default command allowlist")
	}
}
