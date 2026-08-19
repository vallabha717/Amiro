package swebench

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"amiro/backend/internal/agent/eval"
)

// CheckSWEBench is the check kind this package registers on the runner.
const CheckSWEBench eval.CheckKind = "swebench"

// DefaultTimeout bounds one instance's agent turn.
//
// Longer than the harness default: a SWE-bench instance means orienting in an
// unfamiliar repository of real size before any edit is possible, which is
// the work the benchmark is actually about. The plan's own framing -- "a real
// repo task needs 30-150 steps" -- is a description of this.
const DefaultTimeout = 30 * time.Minute

// promptTemplate frames the issue for the agent.
//
// Deliberately thin. Everything beyond "here is the issue, the repo is here,
// fix it" is scaffold tuning, and tuning the prompt is a way to move the
// benchmark number without improving the agent -- which is the thing a
// regression gate exists to detect, not to do.
//
// What it does say is the two things the agent cannot find out for itself and
// would otherwise waste steps discovering: that the tests deciding the
// outcome are not in the tree, and that it should not go looking for them.
const promptTemplate = `Resolve the following issue in the %s repository. The repository is checked out in your workspace.

--- ISSUE ---
%s
--- END ISSUE ---

Make the smallest change to the source that fixes the issue described above.

The tests that decide whether this is fixed are not in the workspace -- they are added afterwards from the project's own test suite. Do not write new tests, and do not modify existing ones: only changes to the library source count. Verify your reasoning by reading the code, not by guessing at test names.`

// Options configure suite construction.
type Options struct {
	// CacheDir holds one materialized checkout per instance, reused across
	// runs. Empty means a directory under the OS temp dir.
	//
	// Worth caching because materializing means pulling and unpacking a
	// multi-gigabyte image; worth keying by instance because two instances of
	// one repository sit at different base commits.
	CacheDir string

	// Timeout per instance. Zero means DefaultTimeout.
	Timeout time.Duration

	// AllowUnsupportedLogParser runs instances whose result format this
	// package cannot parse. Off by default, and the default is the honest
	// one: such an instance produces a log with no recognizable results,
	// which scores as unresolved and is indistinguishable in a report from an
	// agent that failed.
	AllowUnsupportedLogParser bool
}

// Adapter turns pinned instances into a runnable suite.
type Adapter struct {
	opts      Options
	instances []Instance
	byID      map[string]Instance

	// mu guards materialization: the runner is sequential today, so this is
	// insurance against that changing rather than a live contention point.
	mu sync.Mutex
}

// NewAdapter validates the instances and prepares a suite builder.
func NewAdapter(instances []Instance, opts Options) (*Adapter, error) {
	if opts.CacheDir == "" {
		opts.CacheDir = filepath.Join(os.TempDir(), "amiro-swebench-cache")
	}
	if opts.Timeout == 0 {
		opts.Timeout = DefaultTimeout
	}

	a := &Adapter{opts: opts, instances: instances, byID: make(map[string]Instance, len(instances))}
	for _, in := range instances {
		if err := in.Validate(); err != nil {
			return nil, err
		}
		if !opts.AllowUnsupportedLogParser {
			if supported, known := SupportedLogParsers[in.Parser()]; known && !supported {
				return nil, fmt.Errorf(
					"swebench: %s uses log parser %q, whose output format this adapter cannot read; "+
						"it would score as unresolved for a reason that has nothing to do with the agent. "+
						"Drop it from the pinned subset, or set AllowUnsupportedLogParser to run it anyway",
					in.ID, in.Parser())
			}
		}
		a.byID[in.ID] = in
	}
	return a, nil
}

// Instances returns the adapter's instances, in file order.
func (a *Adapter) Instances() []Instance { return a.instances }

// checkoutDir is where an instance's materialized tree lives. Deterministic,
// so Suite can name it before Prepare has filled it.
func (a *Adapter) checkoutDir(id string) string {
	return filepath.Join(a.opts.CacheDir, sanitize(id))
}

// Suite builds the eval.Suite. Prepare must have run first.
//
// The tasks are ordinary harness tasks -- the runner needs no knowledge of
// SWE-bench to run them, which was the requirement. In particular the
// workspace rides `Task.Fixture`, the harness's existing "copied into a fresh
// temporary workspace per task" path, rather than any new mechanism. That
// property is load-bearing here for exactly the reason runner.go already
// gives for the smoke suite: an instance that mutates its own checkout would
// otherwise pass on the first run and fail every time after. What this
// package changes is where the fixture's bytes come from, never how they are
// isolated.
func (a *Adapter) Suite(name string) *eval.Suite {
	suite := &eval.Suite{Name: name}
	for _, in := range a.instances {
		suite.Tasks = append(suite.Tasks, eval.Task{
			ID:      in.ID,
			Prompt:  fmt.Sprintf(promptTemplate, in.Repo, strings.TrimSpace(in.Problem)),
			Fixture: a.checkoutDir(in.ID),
			Timeout: eval.Duration(a.opts.Timeout),
			// Auto: an unattended harness has nobody to answer an approval
			// prompt, and a run that stalls on one looks like a failed task.
			Mode: "auto",
			Verify: []eval.Check{{
				Kind:     CheckSWEBench,
				Path:     in.ID, // how the scorer finds its instance
				Describe: fmt.Sprintf("%s: FAIL_TO_PASS and PASS_TO_PASS both pass in the instance's own container", in.ID),
			}},
		})
	}
	return suite
}

// Prepare materializes every instance's checkout into the cache.
//
// Separate from Suite and from the run because it is the slow, network-bound,
// failure-prone part, and doing it up front means a suite either starts or
// says why -- rather than failing on instance 7 of 50 after an hour of model
// spend.
func (a *Adapter) Prepare(ctx context.Context) error {
	if err := Available(ctx); err != nil {
		return err
	}
	for _, in := range a.instances {
		if err := a.materialize(ctx, in); err != nil {
			return err
		}
	}
	return nil
}

func (a *Adapter) materialize(ctx context.Context, in Instance) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	dir := a.checkoutDir(in.ID)
	// A marker file rather than "the directory exists": a materialization
	// interrupted halfway leaves a directory that looks complete and is not,
	// and the symptom would be an agent working in a truncated repository.
	marker := filepath.Join(dir, ".amiro-materialized")
	if raw, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(raw)) == in.BaseCommit {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("swebench: %w", err)
	}
	if err := Materialize(ctx, in, dir); err != nil {
		return err
	}
	// Written last, and containing the base commit: a cache entry left by an
	// older pin of the same instance id at a different commit must not be
	// mistaken for this one.
	return os.WriteFile(marker, []byte(in.BaseCommit), 0o644)
}

// Verify is the eval.VerifyFunc registered for CheckSWEBench.
//
// It reads the workspace and nothing else: the patch is whatever git says the
// agent left behind, and the verdict is whatever the instance's own test
// suite says about that patch in the instance's own container. This is
// TestRunner_ScoresByTheWorkspaceNotByWhatTheAgentSays applied to SWE-bench.
func (a *Adapter) Verify(ctx context.Context, root string, c eval.Check) (bool, error) {
	in, ok := a.byID[c.Path]
	if !ok {
		return false, fmt.Errorf("swebench: no instance %q", c.Path)
	}

	patch, err := PatchFrom(ctx, root)
	if err != nil {
		return false, err
	}

	log, err := RunEval(ctx, in, patch)
	if err != nil {
		return false, err
	}

	if strings.Contains(log, patchFailedMarker) {
		// Named distinctly rather than folded into "tests failed". A patch
		// that will not apply is a scaffold or edit-format problem -- the
		// exact thing the plan's failed-edit metric exists to surface -- and
		// reporting it as a wrong answer hides it in the resolve rate.
		return false, fmt.Errorf("the agent's patch did not apply to a pristine checkout")
	}

	passed, problems := Score(log, in.FailToPass, in.PassToPass)
	if passed {
		return true, nil
	}
	return false, fmt.Errorf("%s", strings.Join(problems, "; "))
}

// Register wires this adapter into a runner.
func (a *Adapter) Register(r *eval.Runner) {
	if r.Checks == nil {
		r.Checks = map[eval.CheckKind]eval.VerifyFunc{}
	}
	r.Checks[CheckSWEBench] = a.Verify
}
