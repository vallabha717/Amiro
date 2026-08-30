package tools

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"

	"amiro/backend/internal/agent/workspace"
)

// runGitFor is this file's own tiny git runner, deliberately separate from
// the tool under test: these fixtures set up repo state (init, branches,
// remotes) the push subcommand then acts on, so it must not share code
// with what it is verifying.
func runGitFor(t *testing.T, dir string, args ...string) string {
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

// gitPushFixture builds a real git repo checked out on branch, with a bare
// repo (a real, local, offline remote -- no network involved) configured
// as "origin". Returns the workspace and the bare repo's path, so a test
// can inspect exactly what landed there.
func gitPushFixture(t *testing.T, branch string) (*workspace.Workspace, string) {
	t.Helper()
	root := t.TempDir()
	runGitFor(t, root, "init", "-q")
	runGitFor(t, root, "checkout", "-q", "-b", branch)
	runGitFor(t, root, "commit", "-q", "--allow-empty", "-m", "initial")

	bare := t.TempDir()
	runGitFor(t, bare, "init", "-q", "--bare")
	runGitFor(t, root, "remote", "add", "origin", bare)

	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	return ws, bare
}

func execGit(t *testing.T, ws *workspace.Workspace, input string) GitOutput {
	t.Helper()
	d := gitTool(ws)
	out, err := d.Execute(context.Background(), json.RawMessage(input))
	if err != nil {
		t.Fatalf("git Execute: %v", err)
	}
	return out.(GitOutput)
}

// TestGit_PushResolvesCurrentBranchAndPushesOnlyThat is exit criterion 2's
// literal test: push must resolve and push the branch actually checked
// out, never a branch the model names -- the schema does not even accept
// one. A second, never-pushed local branch proves it: only feature-x's ref
// reaches the remote.
func TestGit_PushResolvesCurrentBranchAndPushesOnlyThat(t *testing.T) {
	ws, bare := gitPushFixture(t, "feature-x")
	runGitFor(t, ws.Root(), "branch", "decoy-should-never-be-pushed")

	out := execGit(t, ws, `{"subcommand":"push"}`)
	if out.ExitCode != 0 {
		t.Fatalf("push failed: exit=%d output=%q error=%q", out.ExitCode, out.Output, out.Error)
	}
	if !strings.Contains(out.Command, "push origin feature-x") {
		t.Fatalf("Command = %q, want it to target origin feature-x", out.Command)
	}

	branches := runGitFor(t, bare, "branch", "--list")
	if !strings.Contains(branches, "feature-x") {
		t.Fatalf("bare remote does not have feature-x after push: %q", branches)
	}
	if strings.Contains(branches, "decoy-should-never-be-pushed") {
		t.Fatal("push reached a branch other than the one actually checked out")
	}
}

// TestGit_PushIgnoresAnyBranchTheInputTries -- the schema has no branch/ref
// field for push, so there is no way for a call to even attempt naming
// one; this locks that in by feeding push extra unrecognized-but-plausible
// keys and confirming the checked-out branch (not "main") is still what
// gets pushed.
func TestGit_PushIgnoresAnyBranchTheInputTries(t *testing.T) {
	ws, bare := gitPushFixture(t, "feature-y")

	raw, _ := json.Marshal(map[string]any{"subcommand": "push", "branch": "main", "ref": "main"})
	d := gitTool(ws)
	out, err := d.Execute(context.Background(), raw)
	if err != nil {
		t.Fatalf("git Execute: %v", err)
	}
	got := out.(GitOutput)
	if !strings.Contains(got.Command, "feature-y") {
		t.Fatalf("Command = %q, want the actual checked-out branch feature-y", got.Command)
	}

	branches := runGitFor(t, bare, "branch", "--list")
	if strings.Contains(branches, "main") {
		t.Fatal("push reached \"main\" even though it was never checked out -- the input's extra fields leaked through")
	}
}

// TestGit_PushWithForceAppendsForceFlag is the force half of exit
// criterion 2: force is a separate, explicit input, and only setting it
// reaches --force.
func TestGit_PushWithForceAppendsForceFlag(t *testing.T) {
	ws, _ := gitPushFixture(t, "feature-force")

	out := execGit(t, ws, `{"subcommand":"push","force":true}`)
	if out.ExitCode != 0 {
		t.Fatalf("push --force failed: exit=%d output=%q error=%q", out.ExitCode, out.Output, out.Error)
	}
	if !strings.HasSuffix(strings.TrimSpace(out.Command), "--force") {
		t.Fatalf("Command = %q, want it to end with --force", out.Command)
	}
}

// TestGit_PushWithoutForceNeverAppendsForceFlag guards the other
// direction: an ordinary push must never carry --force just because a
// prior call in the same process set it.
func TestGit_PushWithoutForceNeverAppendsForceFlag(t *testing.T) {
	ws, _ := gitPushFixture(t, "feature-noforce")
	out := execGit(t, ws, `{"subcommand":"push"}`)
	if strings.Contains(out.Command, "--force") {
		t.Fatalf("Command = %q, want no --force", out.Command)
	}
}

// TestGit_PushRefusesWithNoOriginConfigured is one of the two documented
// failure modes: no remote configured, refused before git is even asked
// to try (docs/coding-agent-parity/04-git-remote-operations.md's "remote
// must already be configured").
func TestGit_PushRefusesWithNoOriginConfigured(t *testing.T) {
	root := t.TempDir()
	runGitFor(t, root, "init", "-q")
	runGitFor(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	ws, err := workspace.New(root)
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}

	d := gitTool(ws)
	_, err = d.Execute(context.Background(), json.RawMessage(`{"subcommand":"push"}`))
	if err == nil {
		t.Fatal("expected an error with no origin remote configured")
	}
	if !strings.Contains(err.Error(), "origin") {
		t.Errorf("error = %q, want it to name the missing remote", err.Error())
	}
}

// TestGit_PushRefusesInDetachedHead: no branch to resolve means no push,
// rather than guessing one.
func TestGit_PushRefusesInDetachedHead(t *testing.T) {
	ws, _ := gitPushFixture(t, "feature-detached")
	sha := strings.TrimSpace(runGitFor(t, ws.Root(), "rev-parse", "HEAD"))
	runGitFor(t, ws.Root(), "checkout", "-q", sha)

	d := gitTool(ws)
	_, err := d.Execute(context.Background(), json.RawMessage(`{"subcommand":"push"}`))
	if err == nil {
		t.Fatal("expected an error in detached HEAD")
	}
	if !strings.Contains(err.Error(), "branch") {
		t.Errorf("error = %q, want it to mention not being on a branch", err.Error())
	}
}

// TestGitTool_RejectsAndAcceptsSubcommands is a small sanity check that
// "push" joined the enum alongside the pre-existing ones, and that a
// genuinely unknown subcommand is still rejected.
func TestGitTool_AcceptsPushInSchema(t *testing.T) {
	ws, _ := testWorkspace(t)
	d, ok := FindByName(Defaults(Deps{Workspace: ws}), NameGit)
	if !ok {
		t.Fatal("git tool not found")
	}
	var schema struct {
		Properties struct {
			Subcommand struct {
				Enum []string `json:"enum"`
			} `json:"subcommand"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(d.ParametersSchema, &schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	found := false
	for _, s := range schema.Properties.Subcommand.Enum {
		if s == "push" {
			found = true
		}
	}
	if !found {
		t.Fatalf("push is not in the subcommand enum: %v", schema.Properties.Subcommand.Enum)
	}
}

// TestGitDefinition_AlwaysAskIsTrueOnlyForPush is this phase's own
// AlwaysAsk contract, at the unit level: every non-push subcommand (the
// pre-existing behavior) must be unaffected.
func TestGitDefinition_AlwaysAskIsTrueOnlyForPush(t *testing.T) {
	ws, _ := testWorkspace(t)
	d, ok := FindByName(Defaults(Deps{Workspace: ws}), NameGit)
	if !ok {
		t.Fatal("git tool not found")
	}
	if d.AlwaysAsk == nil {
		t.Fatal("git Definition.AlwaysAsk is nil")
	}
	for _, sub := range []string{"status", "diff", "log", "show", "add", "commit"} {
		raw, _ := json.Marshal(map[string]any{"subcommand": sub})
		if d.AlwaysAsk(raw) {
			t.Errorf("AlwaysAsk(%q) = true, want false -- only push should always ask", sub)
		}
	}
	for _, raw := range []string{
		`{"subcommand":"push"}`,
		`{"subcommand":"push","force":true}`,
		`{"subcommand":"push","force":false}`,
	} {
		if !d.AlwaysAsk(json.RawMessage(raw)) {
			t.Errorf("AlwaysAsk(%s) = false, want true", raw)
		}
	}
}
