package eval

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/backend/internal/agent/session"
)

// fakeAgent does whatever the test tells it to, to the workspace it is
// given. The harness is what is under test here, not a model.
type fakeAgent struct {
	act  func(root string) error
	log  func() *session.Log
	use  Usage
	seen []string // the workspace roots it was handed, one per task
}

func (a *fakeAgent) Solve(ctx context.Context, root, prompt, mode string) (*session.Log, Usage, error) {
	a.seen = append(a.seen, root)
	var err error
	if a.act != nil {
		err = a.act(root)
	}
	l := session.NewLog()
	if a.log != nil {
		l = a.log()
	}
	return l, a.use, err
}

func fixture(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func run(t *testing.T, agent Agent, tasks ...Task) *Report {
	t.Helper()
	r := &Runner{Agent: agent}
	report, err := r.Run(context.Background(), &Suite{Name: "test", Tasks: tasks})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return report
}

func TestRunner_ScoresByTheWorkspaceNotByWhatTheAgentSays(t *testing.T) {
	src := fixture(t, map[string]string{"a.txt": "before"})

	// An agent that claims success and changes nothing.
	liar := &fakeAgent{}
	report := run(t, liar, Task{
		ID: "t", Prompt: "fix it", Fixture: src,
		Verify: []Check{{Kind: CheckFileContains, Path: "a.txt", Contains: "after"}},
	})
	if got := report.Results[0].Outcome; got != Failed {
		t.Fatalf("Outcome = %q, want failed -- verification must read the workspace", got)
	}

	worker := &fakeAgent{act: func(root string) error {
		return os.WriteFile(filepath.Join(root, "a.txt"), []byte("after"), 0o644)
	}}
	report = run(t, worker, Task{
		ID: "t", Prompt: "fix it", Fixture: src,
		Verify: []Check{{Kind: CheckFileContains, Path: "a.txt", Contains: "after"}},
	})
	if got := report.Results[0].Outcome; got != Resolved {
		t.Fatalf("Outcome = %q, want resolved", got)
	}
}

// A task that mutates its own fixture passes once and fails afterwards,
// and diagnosing that costs far more than a copy does.
func TestRunner_CopiesTheFixtureAndLeavesTheOriginalAlone(t *testing.T) {
	src := fixture(t, map[string]string{"a.txt": "original"})

	agent := &fakeAgent{act: func(root string) error {
		return os.WriteFile(filepath.Join(root, "a.txt"), []byte("clobbered"), 0o644)
	}}
	run(t, agent, Task{
		ID: "t", Prompt: "x", Fixture: src,
		Verify: []Check{{Kind: CheckFileContains, Path: "a.txt", Contains: "clobbered"}},
	})

	raw, _ := os.ReadFile(filepath.Join(src, "a.txt"))
	if string(raw) != "original" {
		t.Fatalf("the fixture was modified in place: %q", raw)
	}
	if agent.seen[0] == src {
		t.Fatal("the agent was given the fixture directory itself")
	}
}

func TestRunner_GivesEachTaskItsOwnWorkspace(t *testing.T) {
	src := fixture(t, map[string]string{"a.txt": "x"})
	agent := &fakeAgent{}
	run(t,
		agent,
		Task{ID: "one", Prompt: "p", Fixture: src, Verify: []Check{{Kind: CheckFileContains, Path: "a.txt", Contains: "x"}}},
		Task{ID: "two", Prompt: "p", Fixture: src, Verify: []Check{{Kind: CheckFileContains, Path: "a.txt", Contains: "x"}}},
	)
	if agent.seen[0] == agent.seen[1] {
		t.Fatal("two tasks shared a workspace; one task's leftovers would change another's result")
	}
}

func TestRunner_ReportsEveryFailedCheckByName(t *testing.T) {
	src := fixture(t, map[string]string{"a.txt": "x"})
	report := run(t, &fakeAgent{}, Task{
		ID: "t", Prompt: "p", Fixture: src,
		Verify: []Check{
			{Kind: CheckFileContains, Path: "a.txt", Contains: "x", Describe: "this one passes"},
			{Kind: CheckFileContains, Path: "a.txt", Contains: "nope", Describe: "the substring check"},
			{Kind: CheckFileAbsent, Path: "a.txt", Describe: "the absence check"},
		},
	})
	failed := strings.Join(report.Results[0].FailedChecks, " | ")
	if !strings.Contains(failed, "the substring check") || !strings.Contains(failed, "the absence check") {
		t.Fatalf("FailedChecks = %q, want both failures named", failed)
	}
	if strings.Contains(failed, "this one passes") {
		t.Fatalf("a passing check was reported as failed: %q", failed)
	}
}

// The negative case matters as much as the positive one: this is how plan
// mode is tested.
func TestRunner_FileAbsentPassesOnlyWhenNothingWasWritten(t *testing.T) {
	src := fixture(t, map[string]string{"keep.txt": "x"})
	quiet := run(t, &fakeAgent{}, Task{
		ID: "t", Prompt: "p", Fixture: src, Mode: "plan",
		Verify: []Check{{Kind: CheckFileAbsent, Path: "new.txt"}},
	})
	if quiet.Results[0].Outcome != Resolved {
		t.Fatalf("an agent that wrote nothing failed a file_absent check: %+v", quiet.Results[0])
	}

	noisy := run(t, &fakeAgent{act: func(root string) error {
		return os.WriteFile(filepath.Join(root, "new.txt"), []byte("!"), 0o644)
	}}, Task{
		ID: "t", Prompt: "p", Fixture: src, Mode: "plan",
		Verify: []Check{{Kind: CheckFileAbsent, Path: "new.txt"}},
	})
	if noisy.Results[0].Outcome == Resolved {
		t.Fatal("an agent that wrote the file still passed a file_absent check")
	}
}

func TestRunner_DistinguishesABrokenFixtureFromAFailedAgent(t *testing.T) {
	src := fixture(t, map[string]string{"a.txt": "x"})
	report := run(t, &fakeAgent{}, Task{
		ID: "t", Prompt: "p", Fixture: src,
		Setup:  []Command{{Argv: []string{"false"}}},
		Verify: []Check{{Kind: CheckFileContains, Path: "a.txt", Contains: "x"}},
	})
	if got := report.Results[0].Outcome; got != SetupFail {
		t.Fatalf("Outcome = %q, want setup_fail -- a broken fixture is not the agent's failure", got)
	}
}

// An agent that solved the task and then ran out its budget has solved the
// task; scoring that as a failure measures the budget.
func TestRunner_VerifiesEvenAfterATimeout(t *testing.T) {
	src := fixture(t, map[string]string{"a.txt": "before"})
	agent := &fakeAgent{act: func(root string) error {
		if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("after"), 0o644); err != nil {
			return err
		}
		return context.DeadlineExceeded
	}}
	report := &Report{}
	r := &Runner{Agent: agent}
	report, _ = r.Run(context.Background(), &Suite{Name: "s", Tasks: []Task{{
		ID: "t", Prompt: "p", Fixture: src, Timeout: Duration(time.Nanosecond),
		Verify: []Check{{Kind: CheckFileContains, Path: "a.txt", Contains: "after"}},
	}}})
	if got := report.Results[0].Outcome; got != Resolved {
		t.Fatalf("Outcome = %q, want resolved: the work was done before the deadline hit", got)
	}
}

func TestRunner_AnAgentThatBrokeIsErroredNotFailed(t *testing.T) {
	src := fixture(t, map[string]string{"a.txt": "x"})
	report := run(t, &fakeAgent{act: func(string) error { return errors.New("provider exploded") }}, Task{
		ID: "t", Prompt: "p", Fixture: src,
		Verify: []Check{{Kind: CheckFileContains, Path: "a.txt", Contains: "x"}},
	})
	res := report.Results[0]
	if res.Outcome != Errored {
		t.Fatalf("Outcome = %q, want errored", res.Outcome)
	}
	if !strings.Contains(res.Error, "provider exploded") {
		t.Fatalf("Error = %q", res.Error)
	}
}

// Averaging in a task that burned its budget failing measures how long
// failures take, which moves opposite to the thing being tracked.
func TestSummary_MeansAreOverResolvedTasksOnly(t *testing.T) {
	report := &Report{
		Suite:     "s",
		StartedAt: time.Now(),
		Results: []Result{
			{TaskID: "ok", Outcome: Resolved, Stats: session.Stats{Steps: 4}, Usage: Usage{PromptTokens: 1000}},
			{TaskID: "bad", Outcome: Failed, Stats: session.Stats{Steps: 150}, Usage: Usage{PromptTokens: 90000}},
		},
		FinishedAt: time.Now(),
	}
	s := report.Summary()
	if s.MeanSteps != 4 {
		t.Fatalf("MeanSteps = %.1f, want 4 -- the 150-step failure must not be averaged in", s.MeanSteps)
	}
	if s.MeanTokens != 1000 {
		t.Fatalf("MeanTokens = %.0f, want 1000", s.MeanTokens)
	}
	if s.ResolveRate != 0.5 {
		t.Fatalf("ResolveRate = %.2f, want 0.5", s.ResolveRate)
	}
}

// Unlike the means: a task that failed *because* its edits kept missing is
// the most important data point this metric has.
func TestSummary_FailedEditRateIncludesFailedTasks(t *testing.T) {
	report := &Report{
		Results: []Result{
			{Outcome: Resolved, Stats: session.Stats{FailedEdits: 1, ByTool: map[string]int{"edit_file": 4}}},
			{Outcome: Failed, Stats: session.Stats{FailedEdits: 5, ByTool: map[string]int{"edit_file": 6}}},
		},
	}
	s := report.Summary()
	if s.EditAttempts != 10 {
		t.Fatalf("EditAttempts = %d, want 10", s.EditAttempts)
	}
	if got := s.FailedEditRate; got < 0.59 || got > 0.61 {
		t.Fatalf("FailedEditRate = %.3f, want 0.6", got)
	}
}

func TestSummary_NoEditsIsNotAZeroPercentFailureRate(t *testing.T) {
	report := &Report{Results: []Result{{Outcome: Resolved, Stats: session.Stats{ByTool: map[string]int{"read_file": 3}}}}}
	if s := report.Summary(); s.EditAttempts != 0 {
		t.Fatalf("EditAttempts = %d", s.EditAttempts)
	}
	if !strings.Contains(report.String(), "n/a") {
		t.Fatalf("a run with no edits reported a failed-edit rate:\n%s", report.String())
	}
}

// A task with no checks always passes, which inflates the one number the
// harness exists to measure.
func TestLoadSuite_RejectsATaskWithNoVerification(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.json")
	raw, _ := json.Marshal(Suite{Name: "s", Tasks: []Task{{ID: "t", Prompt: "do it"}}})
	_ = os.WriteFile(path, raw, 0o644)

	if _, err := LoadSuite(path); err == nil || !strings.Contains(err.Error(), "verify") {
		t.Fatalf("LoadSuite err = %v, want a complaint about missing verify checks", err)
	}
}

func TestLoadSuite_RejectsATaskWithNoIDOrPrompt(t *testing.T) {
	dir := t.TempDir()
	for name, suite := range map[string]Suite{
		"no-id":     {Tasks: []Task{{Prompt: "p", Verify: []Check{{Kind: CheckFileAbsent, Path: "x"}}}}},
		"no-prompt": {Tasks: []Task{{ID: "t", Verify: []Check{{Kind: CheckFileAbsent, Path: "x"}}}}},
	} {
		path := filepath.Join(dir, name+".json")
		raw, _ := json.Marshal(suite)
		_ = os.WriteFile(path, raw, 0o644)
		if _, err := LoadSuite(path); err == nil {
			t.Errorf("%s: LoadSuite accepted it", name)
		}
	}
}

func TestDuration_ReadsHumanStrings(t *testing.T) {
	var d Duration
	if err := json.Unmarshal([]byte(`"90s"`), &d); err != nil {
		t.Fatal(err)
	}
	if time.Duration(d) != 90*time.Second {
		t.Fatalf("d = %s", time.Duration(d))
	}
	if got := d.Or(time.Hour); got != 90*time.Second {
		t.Fatalf("Or() = %s", got)
	}
	var zero Duration
	if got := zero.Or(time.Hour); got != time.Hour {
		t.Fatalf("zero.Or(1h) = %s", got)
	}
}

// The shipped suite is a file like any other and can rot.
func TestSmokeSuite_IsValid(t *testing.T) {
	path := filepath.Join("..", "..", "..", "evals", "smoke.json")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("no shipped suite at %s", path)
	}
	suite, err := LoadSuite(path)
	if err != nil {
		t.Fatalf("the shipped smoke suite does not load: %v", err)
	}
	if len(suite.Tasks) == 0 {
		t.Fatal("the shipped smoke suite has no tasks")
	}
	for _, task := range suite.Tasks {
		if task.Fixture == "" {
			continue
		}
		p := filepath.Join("..", "..", "..", task.Fixture)
		if _, err := os.Stat(p); err != nil {
			t.Errorf("task %q points at a fixture that does not exist: %s", task.ID, task.Fixture)
		}
	}
}
