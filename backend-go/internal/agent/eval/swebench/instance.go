// Package swebench adapts SWE-bench Verified instances onto the evaluation
// harness in internal/agent/eval.
//
// Part 4 of docs/agentic-loop-implementation-plan.md names SWE-bench Verified
// as the regression gate and describes exactly what was missing: "something
// that materializes an instance into a workspace directory and a verify
// command". That is what this is. The harness itself -- the task format, the
// runner, the scoring, the report, the Agent interface -- is unchanged and
// not duplicated; this package produces eval.Tasks and one registered
// eval.VerifyFunc.
//
// # Where the data comes from
//
// SWE-bench Verified is 500 instances distributed as parquet on HuggingFace
// (SWE-bench/SWE-bench_Verified), not as a file that ships with the
// benchmark's source. So it has to be fetched, and fetching at *run* time
// would make the gate depend on a third-party service being up and on the
// dataset not being revised underneath it -- a benchmark whose contents can
// change is not a regression gate.
//
// It is therefore fetched once and vendored as a pinned subset (see
// cmd/swebench-pin and evals/swebench/). The plan asks to "start with a small
// pinned subset (a handful of instances) to prove the plumbing before scaling
// toward the 50-100 instance regression gate", and the pinned file is how the
// subset grows without the harness changing.
//
// # What an instance actually ships
//
// More than the plan assumed, and it removes the hardest part of the job. As
// well as the repository, base commit, patch, test patch and the
// FAIL_TO_PASS/PASS_TO_PASS test lists, each instance carries:
//
//   - `image`: a prebuilt Docker image with the repository already checked
//     out at /testbed and its dependencies installed in a conda env. So the
//     per-instance environment does not have to be reconstructed from
//     `environment_setup_commit` and a version table -- which is the part
//     that would genuinely have needed a Python toolchain.
//   - `eval_script`: the exact shell script the benchmark runs to reset the
//     test files, apply the test patch and run the suite. Using the
//     instance's own script rather than a guessed test command is what keeps
//     this measuring SWE-bench rather than measuring an approximation of it.
package swebench

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Instance is one SWE-bench task, as the dataset describes it.
//
// A subset of the dataset's columns: the ones this adapter reads. `patch`
// (the gold solution) is deliberately *not* among them -- it is the answer,
// nothing here should be able to reach it by accident, and an adapter that
// loads it is one refactor away from an agent that can.
type Instance struct {
	ID   string `json:"instance_id"`
	Repo string `json:"repo"`

	BaseCommit string `json:"base_commit"`

	// Problem is the GitHub issue text, and it is the entire prompt the agent
	// gets. Not the hints, not the file list, not the test names.
	Problem string `json:"problem_statement"`

	// TestPatch adds the tests that decide the outcome. Applied by EvalScript
	// during verification, never in the agent's workspace: an agent that can
	// see the tests it will be scored on can write code shaped to them.
	TestPatch string `json:"test_patch"`

	// Image is the prebuilt environment. Empty means the instance predates
	// the dataset carrying one, and this adapter cannot run it -- refused
	// loudly at load rather than silently scored as a failure.
	Image string `json:"image"`

	// EvalScript is the benchmark's own test invocation for this instance.
	EvalScript string `json:"eval_script"`

	// FailToPass must fail before the fix and pass after. PassToPass must
	// pass in both states -- it is the regression half, and an instance
	// scored on FailToPass alone would accept a patch that fixed the issue by
	// breaking everything around it.
	FailToPass []string `json:"FAIL_TO_PASS"`
	PassToPass []string `json:"PASS_TO_PASS"`

	Version    string `json:"version"`
	Difficulty string `json:"difficulty"`

	// LogParserName is the dataset's name for the result format this
	// instance's suite emits (`parse_log_django`, `parse_log_astropy`, ...).
	// It is what decides whether this adapter can read the outcome at all --
	// see SupportedLogParsers.
	LogParserName string `json:"log_parser"`
}

// Parser is the instance's result format, defaulting to plain pytest.
//
// A default rather than an error on absence: the dataset only started
// carrying this column recently, and an older pinned file is still runnable
// -- pytest's format is the majority case, and getting it wrong shows up as
// "no test results found" rather than as a silently wrong verdict.
func (i Instance) Parser() string {
	if strings.TrimSpace(i.LogParserName) == "" {
		return "parse_log_pytest"
	}
	return i.LogParserName
}

// UnmarshalJSON decodes an instance, tolerating both encodings the test lists
// appear in.
//
// The dataset viewer serves FAIL_TO_PASS/PASS_TO_PASS as JSON arrays; older
// exports, and the benchmark's own documentation, describe them as strings
// containing a JSON array. Both are real and in circulation. Accepting either
// costs a few lines here and saves a class of bug whose symptom is every
// instance scoring zero tests and therefore resolving vacuously.
func (i *Instance) UnmarshalJSON(raw []byte) error {
	type plain Instance // avoid recursing into this method
	var shadow struct {
		plain
		FailToPass json.RawMessage `json:"FAIL_TO_PASS"`
		PassToPass json.RawMessage `json:"PASS_TO_PASS"`
	}
	if err := json.Unmarshal(raw, &shadow); err != nil {
		return err
	}
	*i = Instance(shadow.plain)

	var err error
	if i.FailToPass, err = decodeTestList(shadow.FailToPass); err != nil {
		return fmt.Errorf("FAIL_TO_PASS: %w", err)
	}
	if i.PassToPass, err = decodeTestList(shadow.PassToPass); err != nil {
		return fmt.Errorf("PASS_TO_PASS: %w", err)
	}
	return nil
}

func decodeTestList(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	// The string-wrapped form.
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err != nil {
		return nil, fmt.Errorf("neither a list nor a string")
	}
	if strings.TrimSpace(encoded) == "" {
		return nil, nil
	}
	if err := json.Unmarshal([]byte(encoded), &list); err != nil {
		return nil, fmt.Errorf("string did not contain a JSON list: %w", err)
	}
	return list, nil
}

// Validate reports what would make this instance unrunnable.
//
// Checked at load rather than at run: every one of these failures would
// otherwise surface as the instance simply not resolving, which is
// indistinguishable in a report from an agent that tried and failed. A
// benchmark that reports its own broken inputs as agent failures reports the
// wrong number and hides the reason.
func (i Instance) Validate() error {
	switch {
	case strings.TrimSpace(i.ID) == "":
		return fmt.Errorf("swebench: instance has no instance_id")
	case strings.TrimSpace(i.Problem) == "":
		return fmt.Errorf("swebench: %s: empty problem_statement -- the agent would be asked to do nothing", i.ID)
	case strings.TrimSpace(i.Image) == "":
		return fmt.Errorf("swebench: %s: no image; this adapter runs the instance's prebuilt environment and cannot build one", i.ID)
	case strings.TrimSpace(i.EvalScript) == "":
		return fmt.Errorf("swebench: %s: no eval_script", i.ID)
	case len(i.FailToPass) == 0:
		// Without these there is nothing that distinguishes a solved instance
		// from an untouched one, so it would resolve on an empty patch.
		return fmt.Errorf("swebench: %s: no FAIL_TO_PASS tests -- it would resolve without any change", i.ID)
	}
	return nil
}

// LoadInstances reads a pinned subset file: a JSON array of instances.
func LoadInstances(path string) ([]Instance, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("swebench: %w", err)
	}
	var instances []Instance
	if err := json.Unmarshal(raw, &instances); err != nil {
		return nil, fmt.Errorf("swebench: %s: %w", path, err)
	}
	if len(instances) == 0 {
		return nil, fmt.Errorf("swebench: %s: no instances", path)
	}
	seen := map[string]bool{}
	for _, in := range instances {
		if err := in.Validate(); err != nil {
			return nil, err
		}
		if seen[in.ID] {
			return nil, fmt.Errorf("swebench: %s: duplicate instance %s", path, in.ID)
		}
		seen[in.ID] = true
	}
	return instances, nil
}
