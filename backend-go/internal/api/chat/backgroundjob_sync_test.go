package chat

import (
	"context"
	"os/exec"
	"strings"
	"testing"

	"amiro/backend/internal/agent/session"
)

func runGitForSync(t *testing.T, dir string, args ...string) string {
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

func TestSlugify_KeepsOnlyLowercaseAlnumCappedShort(t *testing.T) {
	got := slugify("Fix the Login Bug!! (urgent)")
	want := "fix-the-login-bug-urgent"
	if got != want {
		t.Fatalf("slugify = %q, want %q", got, want)
	}
}

func TestSlugify_CapsLengthWithoutTrailingDash(t *testing.T) {
	got := slugify(strings.Repeat("a ", 100))
	if len(got) > 40 {
		t.Fatalf("slugify length = %d, want <= 40", len(got))
	}
	if strings.HasSuffix(got, "-") {
		t.Fatalf("slugify = %q, ends with a dash", got)
	}
}

func TestJobBranchName_NamesTheJobNeverTheUsersBranch(t *testing.T) {
	got := jobBranchName("job-123", "Refactor the auth module")
	want := "agent/job-123-refactor-the-auth-module"
	if got != want {
		t.Fatalf("jobBranchName = %q, want %q", got, want)
	}
}

func TestJobBranchName_EmptyPromptStillProducesAValidBranch(t *testing.T) {
	got := jobBranchName("job-123", "!!!")
	if got != "agent/job-123-run" {
		t.Fatalf("jobBranchName = %q, want agent/job-123-run", got)
	}
}

func TestCreateAndCheckoutBranch_SwitchesWithoutLosingCommits(t *testing.T) {
	root := t.TempDir()
	runGitForSync(t, root, "init", "-q")
	runGitForSync(t, root, "checkout", "-q", "-b", "main")
	runGitForSync(t, root, "commit", "-q", "--allow-empty", "-m", "initial")

	if err := createAndCheckoutBranch(context.Background(), root, "agent/job-1-do-a-thing"); err != nil {
		t.Fatalf("createAndCheckoutBranch: %v", err)
	}

	branch := strings.TrimSpace(runGitForSync(t, root, "rev-parse", "--abbrev-ref", "HEAD"))
	if branch != "agent/job-1-do-a-thing" {
		t.Fatalf("current branch = %q, want the new branch", branch)
	}
	log := runGitForSync(t, root, "log", "--oneline")
	if !strings.Contains(log, "initial") {
		t.Fatalf("log = %q, lost the original commit", log)
	}
}

func TestCreateAndCheckoutBranch_RefusesADuplicateBranchName(t *testing.T) {
	root := t.TempDir()
	runGitForSync(t, root, "init", "-q")
	runGitForSync(t, root, "checkout", "-q", "-b", "main")
	runGitForSync(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	runGitForSync(t, root, "branch", "agent/dup")

	if err := createAndCheckoutBranch(context.Background(), root, "agent/dup"); err == nil {
		t.Fatal("createAndCheckoutBranch succeeded for an already-existing branch name, want an error")
	}
}

func TestResolveDefaultBranch_ReadsOriginHEAD(t *testing.T) {
	upstream := t.TempDir()
	runGitForSync(t, upstream, "init", "-q", "--bare")

	root := t.TempDir()
	runGitForSync(t, root, "init", "-q")
	runGitForSync(t, root, "checkout", "-q", "-b", "trunk")
	runGitForSync(t, root, "commit", "-q", "--allow-empty", "-m", "initial")
	runGitForSync(t, root, "remote", "add", "origin", upstream)
	runGitForSync(t, root, "push", "-q", "origin", "trunk")
	runGitForSync(t, root, "remote", "set-head", "origin", "trunk")

	got := resolveDefaultBranch(context.Background(), root)
	if got != "trunk" {
		t.Fatalf("resolveDefaultBranch = %q, want trunk", got)
	}
}

func TestResolveDefaultBranch_FallsBackToMainWithNoOrigin(t *testing.T) {
	root := t.TempDir()
	runGitForSync(t, root, "init", "-q")

	got := resolveDefaultBranch(context.Background(), root)
	if got != "main" {
		t.Fatalf("resolveDefaultBranch = %q, want the main fallback", got)
	}
}

func TestTurnSuspended_TrueWhenAnyObservationIsSuspended(t *testing.T) {
	log := session.NewLog()
	log.Record(session.Action{Kind: session.ActionTool, Tool: "read_file"}, session.Observation{Status: session.StatusOK})
	log.Record(session.Action{Kind: session.ActionTool, Tool: "git"}, session.Observation{Status: session.StatusDenied, Suspended: true})

	if !turnSuspended(TurnResult{Log: log}) {
		t.Fatal("turnSuspended = false, want true")
	}
}

func TestTurnSuspended_FalseWithNoSuspendedObservation(t *testing.T) {
	log := session.NewLog()
	log.Record(session.Action{Kind: session.ActionTool, Tool: "read_file"}, session.Observation{Status: session.StatusOK})

	if turnSuspended(TurnResult{Log: log}) {
		t.Fatal("turnSuspended = true, want false")
	}
}

func TestTurnSuspended_FalseWithNilLog(t *testing.T) {
	if turnSuspended(TurnResult{}) {
		t.Fatal("turnSuspended = true for a nil log, want false")
	}
}
