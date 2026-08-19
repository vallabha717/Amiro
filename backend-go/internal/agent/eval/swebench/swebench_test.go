package swebench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"amiro/backend/internal/agent/eval"
)

func sample() Instance {
	return Instance{
		ID:            "astropy__astropy-12907",
		Repo:          "astropy/astropy",
		BaseCommit:    "d16bfe0",
		Problem:       "separability_matrix does not compute separability correctly",
		Image:         "swebench/sweb.eval.x86_64.astropy:latest",
		EvalScript:    "#!/bin/bash\npytest -rA\n",
		FailToPass:    []string{"a/b.py::test_one"},
		PassToPass:    []string{"a/b.py::test_two"},
		LogParserName: "parse_log_astropy",
	}
}

/* -------------------------------------------------------------- */
/* Instance decoding                                               */
/* -------------------------------------------------------------- */

// Both encodings are in circulation: the dataset viewer serves these as JSON
// arrays, the benchmark's own docs describe them as strings holding a JSON
// array. Getting it wrong yields zero tests, which resolves vacuously -- the
// worst possible failure for a benchmark.
func TestInstance_ReadsTestListsInEitherEncoding(t *testing.T) {
	asList := `{"instance_id":"x","FAIL_TO_PASS":["a::t1","a::t2"],"PASS_TO_PASS":["a::t3"]}`
	asString := `{"instance_id":"x","FAIL_TO_PASS":"[\"a::t1\", \"a::t2\"]","PASS_TO_PASS":"[\"a::t3\"]"}`

	for name, raw := range map[string]string{"list": asList, "string": asString} {
		t.Run(name, func(t *testing.T) {
			var in Instance
			if err := json.Unmarshal([]byte(raw), &in); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if len(in.FailToPass) != 2 || in.FailToPass[0] != "a::t1" {
				t.Errorf("FAIL_TO_PASS = %v", in.FailToPass)
			}
			if len(in.PassToPass) != 1 {
				t.Errorf("PASS_TO_PASS = %v", in.PassToPass)
			}
		})
	}
}

// Every one of these would otherwise surface as "the agent did not solve it",
// which is the wrong number reported for the wrong reason.
func TestInstance_ValidateRejectsUnrunnableInstances(t *testing.T) {
	cases := map[string]func(*Instance){
		"no image":       func(i *Instance) { i.Image = "" },
		"no eval script": func(i *Instance) { i.EvalScript = "" },
		"no problem":     func(i *Instance) { i.Problem = "" },
		// The sharpest one: with no FAIL_TO_PASS nothing distinguishes a
		// solved instance from an untouched one, so it resolves on an empty
		// patch and silently inflates the resolve rate.
		"no fail_to_pass": func(i *Instance) { i.FailToPass = nil },
	}
	for name, break_ := range cases {
		t.Run(name, func(t *testing.T) {
			in := sample()
			break_(&in)
			if err := in.Validate(); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
	if err := sample().Validate(); err != nil {
		t.Fatalf("a complete instance was rejected: %v", err)
	}
}

func TestLoadInstances_RejectsDuplicates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pin.json")
	raw, _ := json.Marshal([]Instance{sample(), sample()})
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadInstances(path); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("err = %v, want a duplicate complaint", err)
	}
}

/* -------------------------------------------------------------- */
/* Log parsing                                                     */
/* -------------------------------------------------------------- */

func TestParseLog_ReadsPytestInBothOrderings(t *testing.T) {
	log := `
PASSED astropy/tests/test_a.py::test_one
astropy/tests/test_a.py::test_two PASSED [ 50%]
FAILED astropy/tests/test_a.py::test_three
astropy/tests/test_a.py::test_four SKIPPED [ 90%]
`
	got := ParseLog(log)
	want := map[string]TestStatus{
		"astropy/tests/test_a.py::test_one":   StatusPassed,
		"astropy/tests/test_a.py::test_two":   StatusPassed,
		"astropy/tests/test_a.py::test_three": StatusFailed,
		"astropy/tests/test_a.py::test_four":  StatusSkipped,
	}
	for name, status := range want {
		if got[name] != status {
			t.Errorf("%s = %q, want %q", name, got[name], status)
		}
	}
}

// django is 231 of the 500 instances -- nearly half the benchmark -- and it
// reports in unittest's format, not pytest's.
func TestParseLog_ReadsUnittest(t *testing.T) {
	log := `
test_date_subtraction (expressions.tests.FTimeDeltaTests) ... ok
test_broken (expressions.tests.FTimeDeltaTests) ... FAIL
test_missing_dep (expressions.tests.FTimeDeltaTests) ... skipped 'no db'
test_crash (expressions.tests.FTimeDeltaTests) ... ERROR
`
	got := ParseLog(log)
	for name, want := range map[string]TestStatus{
		"test_date_subtraction (expressions.tests.FTimeDeltaTests)": StatusPassed,
		"test_broken (expressions.tests.FTimeDeltaTests)":           StatusFailed,
		"test_missing_dep (expressions.tests.FTimeDeltaTests)":      StatusSkipped,
		"test_crash (expressions.tests.FTimeDeltaTests)":            StatusError,
	} {
		if got[name] != want {
			t.Errorf("%s = %q, want %q", name, got[name], want)
		}
	}
}

// unittest prints the test's docstring between the name and the verdict, so
// for any documented test the two are on different lines. Most of django's
// tests are documented; missing this would lose most of the benchmark's
// largest project.
func TestParseLog_ReadsAUnittestVerdictSplitAcrossLinesByADocstring(t *testing.T) {
	log := `
test_documented (expressions.tests.FTests)
Subtracting a date from a datetime should work ... ok
`
	if got := ParseLog(log)["test_documented (expressions.tests.FTests)"]; got != StatusPassed {
		t.Errorf("status = %q, want PASSED", got)
	}
}

func TestParseLog_ReadsTheUnittestFailureSummary(t *testing.T) {
	log := `
======================================================================
FAIL: test_thing (expressions.tests.FTests)
----------------------------------------------------------------------
ERROR: test_other (expressions.tests.FTests)
`
	got := ParseLog(log)
	if got["test_thing (expressions.tests.FTests)"] != StatusFailed {
		t.Errorf("FAIL summary not read: %v", got)
	}
	if got["test_other (expressions.tests.FTests)"] != StatusError {
		t.Errorf("ERROR summary not read: %v", got)
	}
}

// A pytest test can pass its body and then blow up in teardown, printing both
// PASSED and ERROR for one id. Taking the last line seen would make the
// verdict depend on print order.
func TestParseLog_KeepsTheWorstStatusForATestNamedTwice(t *testing.T) {
	log := "PASSED a.py::test_x\nERROR a.py::test_x\n"
	if got := ParseLog(log)["a.py::test_x"]; got != StatusError {
		t.Errorf("status = %q, want ERROR", got)
	}
}

/* -------------------------------------------------------------- */
/* Scoring                                                         */
/* -------------------------------------------------------------- */

func TestScore_RequiresBothGroups(t *testing.T) {
	f2p := []string{"a.py::fixed"}
	p2p := []string{"a.py::regression"}

	both := "PASSED a.py::fixed\nPASSED a.py::regression\n"
	if ok, why := Score(both, f2p, p2p); !ok {
		t.Errorf("a run where everything passed scored unresolved: %v", why)
	}

	// The half that is easy to forget: a patch that fixes the reported issue
	// by breaking the code around it has not resolved the instance.
	broke := "PASSED a.py::fixed\nFAILED a.py::regression\n"
	if ok, why := Score(broke, f2p, p2p); ok {
		t.Error("a patch that broke PASS_TO_PASS scored as resolved")
	} else if !strings.Contains(strings.Join(why, " "), "PASS_TO_PASS") {
		t.Errorf("the reason does not name the group: %v", why)
	}
}

// Skips are how a suite says it declined to run something. Counting one as a
// pass is how a patch that disables the failing test scores as a fix.
func TestScore_DoesNotCountASkipAsAPass(t *testing.T) {
	if ok, _ := Score("SKIPPED a.py::fixed\n", []string{"a.py::fixed"}, nil); ok {
		t.Error("a skipped FAIL_TO_PASS test scored as resolved")
	}
}

// The distinction the whole parser is built around: "ran and failed" and
// "never ran / could not be read" are different diagnoses, and one of them is
// about the harness rather than the agent.
func TestScore_ReportsAMissingTestAsMissingRatherThanFailed(t *testing.T) {
	_, why := Score("PASSED a.py::something_else\n", []string{"a.py::fixed"}, nil)
	if !strings.Contains(strings.Join(why, " "), string(StatusMissing)) {
		t.Errorf("a test absent from the log was not reported as MISSING: %v", why)
	}
}

// A log with nothing recognizable usually means the build broke before the
// suite ran. Reporting that as "every test failed" points the reader at the
// agent when the problem is upstream of it.
func TestScore_DistinguishesAnUnreadableLogFromFailures(t *testing.T) {
	ok, why := Score("Traceback (most recent call last):\nImportError\n", []string{"a.py::fixed"}, nil)
	if ok {
		t.Fatal("scored resolved on a log with no results")
	}
	if !strings.Contains(strings.Join(why, " "), "no test results found") {
		t.Errorf("reason = %v, want it to say the suite produced no results", why)
	}
}

/* -------------------------------------------------------------- */
/* Suite construction                                              */
/* -------------------------------------------------------------- */

func TestAdapter_BuildsOrdinaryHarnessTasks(t *testing.T) {
	a, err := NewAdapter([]Instance{sample()}, Options{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	suite := a.Suite("test")
	if len(suite.Tasks) != 1 {
		t.Fatalf("tasks = %d", len(suite.Tasks))
	}
	task := suite.Tasks[0]

	if task.ID != sample().ID {
		t.Errorf("id = %q", task.ID)
	}
	// The isolation property the plan calls out by name: the workspace rides
	// Task.Fixture, which the runner copies into a fresh temp directory per
	// task. An instance that mutates its checkout must not affect later runs.
	if task.Fixture == "" {
		t.Error("the task has no fixture, so the runner would hand the agent an empty workspace")
	}
	if len(task.Verify) != 1 || task.Verify[0].Kind != CheckSWEBench {
		t.Errorf("verify = %+v, want one swebench check", task.Verify)
	}
	if task.Verify[0].Path != sample().ID {
		t.Errorf("the check does not name its instance: %+v", task.Verify[0])
	}
}

// The prompt is the issue and nothing else. A prompt carrying the gold patch,
// the changed file list, or the test names would measure the harness's
// generosity rather than the agent.
func TestAdapter_PromptCarriesTheIssueAndNotTheAnswer(t *testing.T) {
	in := sample()
	a, err := NewAdapter([]Instance{in}, Options{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	prompt := a.Suite("t").Tasks[0].Prompt

	if !strings.Contains(prompt, in.Problem) {
		t.Error("the prompt does not contain the issue")
	}
	for _, leak := range append(append([]string{}, in.FailToPass...), in.PassToPass...) {
		if strings.Contains(prompt, leak) {
			t.Errorf("the prompt leaks a test name the agent is scored on: %q", leak)
		}
	}
	if strings.Contains(prompt, in.TestPatch) && in.TestPatch != "" {
		t.Error("the prompt leaks the test patch")
	}
}

// An instance this adapter cannot score must be refused at load. Run anyway,
// it produces an unreadable log, scores unresolved, and looks exactly like an
// agent that failed.
func TestNewAdapter_RefusesAnInstanceWhoseLogItCannotRead(t *testing.T) {
	in := sample()
	in.LogParserName = "parse_log_sympy"

	if _, err := NewAdapter([]Instance{in}, Options{CacheDir: t.TempDir()}); err == nil {
		t.Fatal("expected a refusal for an unsupported log parser")
	}
	// ...and runnable anyway when the caller says so explicitly.
	if _, err := NewAdapter([]Instance{in}, Options{
		CacheDir:                  t.TempDir(),
		AllowUnsupportedLogParser: true,
	}); err != nil {
		t.Fatalf("AllowUnsupportedLogParser did not allow it: %v", err)
	}
}

func TestAdapter_RegistersItsScorerOnTheRunner(t *testing.T) {
	a, err := NewAdapter([]Instance{sample()}, Options{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var r eval.Runner
	a.Register(&r)
	if _, ok := r.Checks[CheckSWEBench]; !ok {
		t.Fatal("the swebench check kind is not registered, so every task would fail as an unknown check")
	}
}

// The vendored subset is data that ships with the repository, so a bad commit
// of it should fail the ordinary test run rather than the next benchmark run
// -- which is an hour of model spend later, and possibly on someone else's
// machine.
func TestPinnedSubset_LoadsAndBuildsASuite(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "evals", "swebench", "verified-subset.json")
	instances, err := LoadInstances(path)
	if err != nil {
		t.Fatalf("the committed subset does not load: %v", err)
	}
	a, err := NewAdapter(instances, Options{CacheDir: t.TempDir()})
	if err != nil {
		t.Fatalf("the committed subset does not build a suite: %v", err)
	}
	suite := a.Suite("pinned")
	if len(suite.Tasks) != len(instances) {
		t.Fatalf("tasks = %d, instances = %d", len(suite.Tasks), len(instances))
	}

	// Breadth is a property of the subset worth asserting: a gate drawn from
	// one project measures how well the agent knows that project. SWE-bench
	// Verified is 46% django, so a subset that drifted toward a single repo
	// would be easy to produce by accident and hard to notice.
	repos := map[string]bool{}
	for _, in := range instances {
		repos[in.Repo] = true
	}
	if len(repos) < 3 {
		t.Errorf("the pinned subset spans only %d repositories: %v", len(repos), repos)
	}
}
