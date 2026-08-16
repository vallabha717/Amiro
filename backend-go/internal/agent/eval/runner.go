package eval

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"amiro/backend/internal/agent/session"
)

// Agent is what the harness drives. One method, because everything the
// harness needs is "solve this, in this directory, and tell me what you
// did" -- and keeping it to one method is what stops this package from
// importing the chat handler and inverting the dependency.
type Agent interface {
	// Solve runs one agent turn against workspaceRoot and returns the
	// structured record of it. The log is the deliverable, not the text:
	// the harness scores the workspace afterwards, not the agent's account
	// of itself.
	Solve(ctx context.Context, workspaceRoot, prompt, mode string) (*session.Log, Usage, error)
}

// Usage is what one task cost.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

func (u Usage) Total() int { return u.PromptTokens + u.CompletionTokens }

// Outcome is how one task ended.
type Outcome string

const (
	Resolved  Outcome = "resolved"
	Failed    Outcome = "failed"     // ran to completion, verification did not pass
	Errored   Outcome = "errored"    // the agent or the setup broke
	TimedOut  Outcome = "timed_out"  //
	SetupFail Outcome = "setup_fail" // the fixture is broken, not the agent
)

// Result is one task's scored run.
type Result struct {
	TaskID  string  `json:"task_id"`
	Outcome Outcome `json:"outcome"`

	// FailedChecks names what did not pass, in order. Empty on success.
	FailedChecks []string `json:"failed_checks,omitempty"`

	Stats session.Stats `json:"stats"`
	Usage Usage         `json:"usage"`

	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

// Runner executes a suite.
type Runner struct {
	Agent Agent

	// WorkDir is where task workspaces are created. Empty means the OS temp
	// directory. Kept configurable because a run's workspaces are the first
	// thing to look at when a task fails unexpectedly, and finding them
	// matters more than cleaning them up.
	WorkDir string

	// Keep leaves workspaces on disk after the run, for the same reason.
	Keep bool

	// Log receives progress. Nil discards it.
	Log io.Writer
}

// Run executes every task, in order, and returns the report.
//
// Sequentially, deliberately. Tasks share a machine, a model rate limit and
// often a language server; running them concurrently makes wall-clock
// numbers meaningless and makes a flaky task look like a broken one. The
// harness measures the agent, so it must not introduce variance of its own.
func (r *Runner) Run(ctx context.Context, suite *Suite) (*Report, error) {
	if r.Agent == nil {
		return nil, fmt.Errorf("eval: no agent")
	}
	report := &Report{Suite: suite.Name, StartedAt: time.Now()}

	for _, task := range suite.Tasks {
		select {
		case <-ctx.Done():
			return report, ctx.Err()
		default:
		}
		res := r.runOne(ctx, task)
		report.Results = append(report.Results, res)
		r.logf("%-28s %-10s %2d steps  %2d tool calls  %d failed edits\n",
			res.TaskID, res.Outcome, res.Stats.Steps, res.Stats.ToolCalls, res.Stats.FailedEdits)
	}

	report.FinishedAt = time.Now()
	return report, nil
}

func (r *Runner) runOne(ctx context.Context, task Task) Result {
	started := time.Now()
	res := Result{TaskID: task.ID}
	defer func() { res.DurationMS = time.Since(started).Milliseconds() }()

	root, err := r.setupWorkspace(task)
	if err != nil {
		res.Outcome, res.Error = SetupFail, err.Error()
		return res
	}
	if !r.Keep {
		defer func() { _ = os.RemoveAll(root) }()
	}

	taskCtx, cancel := context.WithTimeout(ctx, task.Timeout.Or(DefaultTaskTimeout))
	defer cancel()

	for _, cmd := range task.Setup {
		if err := runCommand(taskCtx, root, cmd); err != nil {
			res.Outcome, res.Error = SetupFail, err.Error()
			return res
		}
	}

	mode := task.Mode
	if mode == "" {
		mode = "auto"
	}
	log, usage, err := r.Agent.Solve(taskCtx, root, task.Prompt, mode)
	res.Stats = log.Summarize()
	res.Usage = usage

	if err != nil {
		if taskCtx.Err() != nil {
			res.Outcome = TimedOut
		} else {
			res.Outcome = Errored
		}
		res.Error = err.Error()
		// Verification still runs below on a timeout: an agent that solved
		// the task and then spent its remaining budget admiring the result
		// has solved the task, and scoring that as a failure measures the
		// budget rather than the agent.
		if res.Outcome == Errored {
			return res
		}
	}

	// Verification uses a fresh context: the task's deadline bounds the
	// agent, not the scoring. A test suite killed halfway through would
	// report the task unsolved regardless of whether it was.
	verifyCtx, verifyCancel := context.WithTimeout(ctx, 5*time.Minute)
	defer verifyCancel()

	for _, check := range task.Verify {
		if ok, err := runCheck(verifyCtx, root, check); !ok {
			desc := check.String()
			if err != nil {
				desc += " (" + err.Error() + ")"
			}
			res.FailedChecks = append(res.FailedChecks, desc)
		}
	}
	if len(res.FailedChecks) > 0 {
		if res.Outcome == "" {
			res.Outcome = Failed
		}
		return res
	}
	res.Outcome = Resolved
	res.Error = "" // it passed; whatever the agent reported on the way is not a failure
	return res
}

func (r *Runner) setupWorkspace(task Task) (string, error) {
	base := r.WorkDir
	if base == "" {
		base = os.TempDir()
	}
	root, err := os.MkdirTemp(base, "amiro-eval-"+sanitize(task.ID)+"-")
	if err != nil {
		return "", fmt.Errorf("eval: %w", err)
	}
	if task.Fixture == "" {
		return root, nil
	}
	if err := copyTree(task.Fixture, root); err != nil {
		_ = os.RemoveAll(root)
		return "", fmt.Errorf("eval: fixture %s: %w", task.Fixture, err)
	}
	return root, nil
}

func runCommand(ctx context.Context, root string, c Command) error {
	if len(c.Argv) == 0 {
		return fmt.Errorf("eval: empty command")
	}
	cmd := exec.CommandContext(ctx, c.Argv[0], c.Argv[1:]...)
	cmd.Dir = filepath.Join(root, c.Dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", strings.Join(c.Argv, " "), err, clip(string(out)))
	}
	return nil
}

func runCheck(ctx context.Context, root string, c Check) (bool, error) {
	switch c.Kind {
	case CheckCommand:
		if err := runCommand(ctx, root, Command{Argv: c.Argv}); err != nil {
			return false, err
		}
		return true, nil

	case CheckFileContains:
		raw, err := os.ReadFile(filepath.Join(root, c.Path))
		if err != nil {
			return false, err
		}
		if !strings.Contains(string(raw), c.Contains) {
			return false, fmt.Errorf("substring not found")
		}
		return true, nil

	case CheckFileAbsent:
		if _, err := os.Stat(filepath.Join(root, c.Path)); err == nil {
			return false, fmt.Errorf("exists")
		}
		return true, nil

	default:
		return false, fmt.Errorf("unknown check kind %q", c.Kind)
	}
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, raw, info.Mode().Perm())
	})
}

func (r *Runner) logf(format string, args ...any) {
	if r.Log == nil {
		return
	}
	fmt.Fprintf(r.Log, format, args...)
}

func sanitize(s string) string {
	var b strings.Builder
	for _, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' {
			b.WriteRune(c)
		} else {
			b.WriteRune('-')
		}
	}
	return b.String()
}

func clip(s string) string {
	const max = 2000
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n... (truncated)"
}

// Report aggregates a run.
type Report struct {
	Suite      string    `json:"suite"`
	Results    []Result  `json:"results"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
}

// Summary is the four numbers Part 4 of the plan says to track, plus the
// denominators needed to read them honestly.
type Summary struct {
	Tasks    int `json:"tasks"`
	Resolved int `json:"resolved"`
	Failed   int `json:"failed"`
	Errored  int `json:"errored"`

	ResolveRate float64 `json:"resolve_rate"`

	// MeanSteps is over *resolved* tasks only. Averaging in a task that
	// burned its whole step budget failing measures how long failures take,
	// which moves in the opposite direction from the thing being tracked --
	// a scaffold change that turns slow failures into fast ones would show
	// up as steps getting worse.
	MeanSteps float64 `json:"mean_steps_resolved"`

	MeanTokens float64 `json:"mean_tokens_resolved"`

	// FailedEditRate is failed edits per edit attempt, across every task
	// including the failures -- unlike the means above, because a task that
	// failed *because* its edits kept missing is the most important data
	// point this metric has.
	FailedEditRate float64 `json:"failed_edit_rate"`
	EditAttempts   int     `json:"edit_attempts"`

	DurationMS int64 `json:"duration_ms"`
}

// editingTools mirrors session.editingTools. Duplicated deliberately: this
// is the harness's definition of what counts toward the metric it reports,
// and it should not change silently because the log package widened its
// own idea of an edit.
var editingTools = map[string]bool{"edit_file": true, "multi_edit": true}

func (r *Report) Summary() Summary {
	s := Summary{Tasks: len(r.Results), DurationMS: r.FinishedAt.Sub(r.StartedAt).Milliseconds()}

	totalSteps, totalTokens, edits, failedEdits := 0, 0, 0, 0
	for _, res := range r.Results {
		switch res.Outcome {
		case Resolved:
			s.Resolved++
			totalSteps += res.Stats.Steps
			totalTokens += res.Usage.Total()
		case Failed:
			s.Failed++
		default:
			s.Errored++
		}
		for tool, n := range res.Stats.ByTool {
			if editingTools[tool] {
				edits += n
			}
		}
		failedEdits += res.Stats.FailedEdits
	}

	s.EditAttempts = edits
	if edits > 0 {
		s.FailedEditRate = float64(failedEdits) / float64(edits)
	}
	if s.Tasks > 0 {
		s.ResolveRate = float64(s.Resolved) / float64(s.Tasks)
	}
	if s.Resolved > 0 {
		s.MeanSteps = float64(totalSteps) / float64(s.Resolved)
		s.MeanTokens = float64(totalTokens) / float64(s.Resolved)
	}
	return s
}

// String renders the report for a terminal.
func (r *Report) String() string {
	s := r.Summary()
	var b strings.Builder

	fmt.Fprintf(&b, "\n%s -- %d/%d resolved (%.0f%%)\n", r.Suite, s.Resolved, s.Tasks, s.ResolveRate*100)
	fmt.Fprintf(&b, "  mean steps (resolved):  %.1f\n", s.MeanSteps)
	fmt.Fprintf(&b, "  mean tokens (resolved): %.0f\n", s.MeanTokens)
	if s.EditAttempts > 0 {
		fmt.Fprintf(&b, "  failed edit rate:       %.1f%% (%d attempts)\n", s.FailedEditRate*100, s.EditAttempts)
	} else {
		fmt.Fprintf(&b, "  failed edit rate:       n/a (no edits attempted)\n")
	}
	fmt.Fprintf(&b, "  wall clock:             %s\n", time.Duration(s.DurationMS)*time.Millisecond)

	var problems []Result
	for _, res := range r.Results {
		if res.Outcome != Resolved {
			problems = append(problems, res)
		}
	}
	if len(problems) > 0 {
		sort.SliceStable(problems, func(a, b int) bool { return problems[a].TaskID < problems[b].TaskID })
		b.WriteString("\nnot resolved:\n")
		for _, res := range problems {
			fmt.Fprintf(&b, "  %-28s %s\n", res.TaskID, res.Outcome)
			for _, c := range res.FailedChecks {
				fmt.Fprintf(&b, "      failed: %s\n", c)
			}
			if res.Error != "" {
				fmt.Fprintf(&b, "      error:  %s\n", clip(res.Error))
			}
		}
	}
	return b.String()
}
