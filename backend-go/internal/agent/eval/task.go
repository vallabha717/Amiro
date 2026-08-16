// Package eval is the regression harness Part 4 of
// docs/agentic-loop-implementation-plan.md calls for: run the agent against
// fixed tasks, score them the same way every time, and report the metrics
// that say whether a scaffold change helped.
//
// # What this is, and what it is not
//
// The plan names SWE-bench Verified as the gate. This is not that, and the
// difference matters: a SWE-bench instance needs a pinned repository
// checkout and a container to run the project's own test suite in, which is
// a Python-and-Docker dependency the plan itself acknowledges. What lives
// here is the *harness* -- the task format, the runner, the scoring and the
// report -- with an Agent interface at the boundary. Pointing it at
// SWE-bench means writing an adapter that materializes an instance into a
// workspace directory and a verify command, not rewriting any of this.
//
// It is runnable today against local fixture tasks, which is the thing that
// actually catches scaffold regressions during development: "did my change
// to the edit format make edit_file fail more often" is answerable in
// seconds against a handful of fixtures and in an hour against SWE-bench.
//
// # The metrics, and why these four
//
// Resolve rate alone hides everything interesting. A change that makes the
// agent resolve the same number of tasks using half the steps is a large
// win that resolve rate reports as nothing, and a change that raises the
// failed-edit rate is a regression that resolve rate will only show once it
// has gotten bad enough to lose tasks outright. The plan singles out failed
// edit rate as "the sharpest signal on whether the ACI is working" -- it is
// the metric that moves first, which is exactly what a regression gate
// needs. It comes from the event log (internal/agent/session), which is why
// that had to exist before this could.
//
// # Trust
//
// A task file names commands to run. This package executes them. That is
// appropriate for a developer tool invoked deliberately from a terminal on
// task files the developer wrote, and it is why nothing in the request path
// imports this package: it deliberately has none of the permission
// machinery internal/agent/permission exists to provide, because the person
// running it is the person who wrote the commands.
package eval

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// Task is one scored problem.
type Task struct {
	ID     string `json:"id"`
	Prompt string `json:"prompt"`

	// Fixture is a directory copied into a fresh temporary workspace before
	// the run. Copied, never used in place: a task that mutates its own
	// fixture is one that passes on the first run and fails afterwards, and
	// diagnosing that costs far more than the copy does.
	Fixture string `json:"fixture"`

	// Setup runs in the workspace before the agent, for anything the
	// fixture cannot express as files (installing dependencies, git init).
	Setup []Command `json:"setup,omitempty"`

	// Verify decides whether the task was solved. Every check must pass.
	Verify []Check `json:"verify"`

	// Timeout bounds one task. Zero means DefaultTaskTimeout.
	Timeout Duration `json:"timeout,omitempty"`

	// Mode is the permission mode to run under. Empty means "auto" -- an
	// unattended harness has nobody to answer an approval prompt, and a run
	// that silently stalls on one would look like a task the agent simply
	// failed. Set it to "plan" deliberately to test that plan mode refuses.
	Mode string `json:"mode,omitempty"`
}

// Command is a program and its arguments. A list, never a shell string:
// a task file is data, and a string handed to `sh -c` makes quoting bugs
// into silent behaviour changes.
type Command struct {
	Argv []string `json:"argv"`
	Dir  string   `json:"dir,omitempty"`
}

// CheckKind is how one verification is performed.
type CheckKind string

const (
	// CheckCommand passes when a command exits zero. This is the real one:
	// it is how SWE-bench scores, and it is the only check that tests
	// behaviour rather than text.
	CheckCommand CheckKind = "command"

	// CheckFileContains passes when a file exists and contains a substring.
	// A weaker check, for fixtures with no runnable suite. Named honestly:
	// it verifies that something was written, not that it works.
	CheckFileContains CheckKind = "file_contains"

	// CheckFileAbsent passes when a path does not exist -- for asserting an
	// agent did *not* do something, which is how plan mode is tested.
	CheckFileAbsent CheckKind = "file_absent"
)

// Check is one verification.
type Check struct {
	Kind     CheckKind `json:"kind"`
	Argv     []string  `json:"argv,omitempty"`
	Path     string    `json:"path,omitempty"`
	Contains string    `json:"contains,omitempty"`

	// Describe is a human sentence for the report. Without it a failure
	// reads as `check 2 failed`, which tells whoever is looking at CI
	// nothing about what the agent was supposed to have done.
	Describe string `json:"describe,omitempty"`
}

func (c Check) String() string {
	if c.Describe != "" {
		return c.Describe
	}
	switch c.Kind {
	case CheckCommand:
		return strings.Join(c.Argv, " ")
	case CheckFileContains:
		return fmt.Sprintf("%s contains %q", c.Path, c.Contains)
	case CheckFileAbsent:
		return fmt.Sprintf("%s does not exist", c.Path)
	}
	return string(c.Kind)
}

// DefaultTaskTimeout bounds one task end to end. Generous, because a real
// task legitimately runs many model calls; the point is that a wedged run
// costs one task rather than the suite.
const DefaultTaskTimeout = 10 * time.Minute

// Duration is a time.Duration that reads from JSON as "5m" rather than as
// a count of nanoseconds. A task file is written by a person.
type Duration time.Duration

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		parsed, err := time.ParseDuration(s)
		if err != nil {
			return fmt.Errorf("eval: bad duration %q: %w", s, err)
		}
		*d = Duration(parsed)
		return nil
	}
	var n int64
	if err := json.Unmarshal(b, &n); err != nil {
		return fmt.Errorf("eval: duration must be a string like \"5m\"")
	}
	*d = Duration(time.Duration(n) * time.Second)
	return nil
}

func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

func (d Duration) Or(fallback time.Duration) time.Duration {
	if d == 0 {
		return fallback
	}
	return time.Duration(d)
}

// Suite is a named set of tasks.
type Suite struct {
	Name  string `json:"name"`
	Tasks []Task `json:"tasks"`
}

// LoadSuite reads a suite from a JSON file.
func LoadSuite(path string) (*Suite, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("eval: %w", err)
	}
	var s Suite
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("eval: %s: %w", path, err)
	}
	for i, t := range s.Tasks {
		if strings.TrimSpace(t.ID) == "" {
			return nil, fmt.Errorf("eval: %s: task %d has no id", path, i)
		}
		if strings.TrimSpace(t.Prompt) == "" {
			return nil, fmt.Errorf("eval: %s: task %q has no prompt", path, t.ID)
		}
		if len(t.Verify) == 0 {
			// A task with no verification is a task that always passes,
			// which is worse than a missing task: it inflates the resolve
			// rate the whole harness exists to measure.
			return nil, fmt.Errorf("eval: %s: task %q has no verify checks", path, t.ID)
		}
	}
	return &s, nil
}
