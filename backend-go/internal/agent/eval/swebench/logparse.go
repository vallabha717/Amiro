package swebench

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// TestStatus is what the suite reported for one test.
type TestStatus string

const (
	StatusPassed  TestStatus = "PASSED"
	StatusFailed  TestStatus = "FAILED"
	StatusError   TestStatus = "ERROR"
	StatusSkipped TestStatus = "SKIPPED"

	// StatusMissing means the log said nothing about this test at all.
	//
	// A separate value from FAILED, and the distinction is the whole reason
	// this parser is trustworthy. "The test ran and failed" and "the test
	// never ran, or ran and this parser could not see it" are opposite
	// diagnoses: the first is a real result about the agent's patch, the
	// second is a result about the harness. Collapsing them would let a
	// parser that silently stopped understanding a repo's output report every
	// instance as an agent failure, and the number would look plausible.
	StatusMissing TestStatus = "MISSING"
)

// Result formats, and which ones this adapter can read.
//
// The benchmark's own evaluation ships a per-repository log parser (the
// dataset's `log_parser` column names it) because each project's test runner
// formats results differently. Reimplementing every one of those in Go would
// be a large pile of code whose failure mode is quiet mis-scoring.
//
// Two formats cover most of the benchmark, and this reads both:
//
//   - **pytest**, whose test ids contain `::`. Ten of the twelve repositories
//     in SWE-bench Verified emit it: astropy, flask, matplotlib, pylint,
//     pytest, requests, scikit-learn, seaborn, sphinx and xarray -- 194 of
//     the 500 instances.
//   - **unittest**, whose ids read `test_name (module.Class)`. This is
//     django, which alone is 231 instances. Supporting it is not optional for
//     a gate that means anything: a subset drawn only from the pytest
//     repositories would be 39% of the benchmark and would exclude the single
//     most-represented project in it.
//
// Together that is 425 of 500. The remaining 75 are sympy, whose runner has
// a format of its own, and they are declined **by name** rather than
// attempted -- an instance whose log this cannot read produces no recognized
// results, which scores as unresolved and is indistinguishable in a report
// from an agent that failed. Same choice edit_file's syntax gate makes: cover
// what can be covered precisely, and decline the rest out loud.
var SupportedLogParsers = map[string]bool{
	// pytest family
	"parse_log_astropy":    true,
	"parse_log_flask":      true,
	"parse_log_matplotlib": true,
	"parse_log_pylint":     true,
	"parse_log_pytest":     true,
	"parse_log_requests":   true,
	"parse_log_scikit":     true,
	"parse_log_seaborn":    true,
	"parse_log_sphinx":     true,
	"parse_log_xarray":     true,

	// unittest family
	"parse_log_django": true,

	// sympy's runner reports in neither shape.
	"parse_log_sympy": false,
}

// pytestStatuses are the leading tokens pytest prints in verbose mode.
var pytestStatuses = map[string]TestStatus{
	"PASSED":  StatusPassed,
	"FAILED":  StatusFailed,
	"ERROR":   StatusError,
	"SKIPPED": StatusSkipped,
	"XFAIL":   StatusPassed, // an expected failure that failed is a pass
	"XPASS":   StatusPassed,
}

// ParseLog extracts per-test statuses from a test log, reading both the
// pytest and the unittest form.
//
// One pass over both formats rather than a format selected by the instance's
// `log_parser` name: the two are unambiguous (a pytest id contains `::`, a
// unittest id ends in `(module.Class)`), the eval script for a repository can
// legitimately emit both when it runs more than one suite, and a parser that
// had to be told which format to expect would silently produce nothing when
// that guess was wrong.
//
// A test named more than once keeps its *worst* status. A test that appears as
// both PASSED and ERROR -- a teardown failure after a passing body, which is a
// real pytest pattern -- has not passed, and taking the last line seen would
// make the answer depend on the order the runner happened to print in.
func ParseLog(log string) map[string]TestStatus {
	out := map[string]TestStatus{}

	record := func(name string, status TestStatus) {
		name = strings.TrimSpace(name)
		if name == "" {
			return
		}
		if prev, ok := out[name]; ok && severity(prev) >= severity(status) {
			return
		}
		out[name] = status
	}

	// pending holds a unittest test name whose status has not arrived yet.
	// unittest prints the name, then the test's docstring, then `... ok` on a
	// later line -- so for any test that has a docstring the name and the
	// verdict are on different lines. Dropping those would silently lose every
	// documented test in django, which is most of them.
	pending := ""

	for _, raw := range strings.Split(log, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}

		if name, status, ok := parseUnittestLine(line, pending); ok {
			record(name, status)
			pending = ""
			continue
		}
		if name, ok := parseUnittestPending(line); ok {
			pending = name
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		// Leading-status form: "PASSED tests/test_x.py::test_a"
		if status, ok := pytestStatuses[fields[0]]; ok && strings.Contains(fields[1], "::") {
			record(fields[1], status)
			continue
		}
		// Trailing-status form: "tests/test_x.py::test_a PASSED [ 50%]"
		if status, ok := pytestStatuses[fields[1]]; ok && strings.Contains(fields[0], "::") {
			record(fields[0], status)
			continue
		}
	}
	return out
}

// unittestName matches `test_something (module.Class)`, optionally followed by
// more text. That parenthesised form is exactly how SWE-bench names django's
// tests in FAIL_TO_PASS, so the captured string is used verbatim as the key.
var unittestName = regexp.MustCompile(`^([A-Za-z_]\w*)\s+\(([\w.]+)\)(.*)$`)

// unittestSummary matches the block header unittest prints after the run:
// "FAIL: test_something (module.Class)".
var unittestSummary = regexp.MustCompile(`^(FAIL|ERROR):\s+([A-Za-z_]\w*)\s+\(([\w.]+)\)`)

var unittestStatuses = map[string]TestStatus{
	"ok":         StatusPassed,
	"FAIL":       StatusFailed,
	"ERROR":      StatusError,
	"skipped":    StatusSkipped,
	"expected":   StatusPassed, // "expected failure"
	"unexpected": StatusFailed, // "unexpected success"
}

// parseUnittestLine reads a unittest result line, using pending as the test
// name when this line carries only the verdict (the docstring case).
func parseUnittestLine(line, pending string) (string, TestStatus, bool) {
	if m := unittestSummary.FindStringSubmatch(line); m != nil {
		status := StatusFailed
		if m[1] == "ERROR" {
			status = StatusError
		}
		return fmt.Sprintf("%s (%s)", m[2], m[3]), status, true
	}

	if m := unittestName.FindStringSubmatch(line); m != nil {
		name := fmt.Sprintf("%s (%s)", m[1], m[2])
		if status, ok := verdictAfterEllipsis(m[3]); ok {
			return name, status, true
		}
		return "", "", false
	}

	// A continuation line: the name came earlier, this is "<docstring> ... ok".
	if pending != "" {
		if status, ok := verdictAfterEllipsis(line); ok {
			return pending, status, true
		}
	}
	return "", "", false
}

// parseUnittestPending recognizes a bare test name whose verdict is still to
// come on a later line.
func parseUnittestPending(line string) (string, bool) {
	m := unittestName.FindStringSubmatch(line)
	if m == nil {
		return "", false
	}
	if _, ok := verdictAfterEllipsis(m[3]); ok {
		return "", false // it carried its own verdict; not pending
	}
	return fmt.Sprintf("%s (%s)", m[1], m[2]), true
}

// verdictAfterEllipsis reads the word following unittest's "..." separator.
func verdictAfterEllipsis(rest string) (TestStatus, bool) {
	idx := strings.Index(rest, "...")
	if idx < 0 {
		return "", false
	}
	fields := strings.Fields(rest[idx+3:])
	if len(fields) == 0 {
		return "", false
	}
	status, ok := unittestStatuses[fields[0]]
	return status, ok
}

func severity(s TestStatus) int {
	switch s {
	case StatusPassed:
		return 0
	case StatusSkipped:
		return 1
	case StatusFailed:
		return 2
	case StatusError:
		return 3
	}
	return 4
}

// Score decides whether one instance's run resolved it, and explains itself
// when it did not.
//
// The definition is the benchmark's: every FAIL_TO_PASS test passes, and
// every PASS_TO_PASS test still passes. Both halves matter -- an instance
// scored on FAIL_TO_PASS alone would accept a patch that fixed the reported
// issue by breaking the code around it.
//
// A skipped test is not a passing test. Skips are how a suite reports that it
// declined to run something, and counting one as a pass is how a patch that
// disables the test that was failing scores as a fix.
func Score(log string, failToPass, passToPass []string) (bool, []string) {
	statuses := ParseLog(log)

	var problems []string
	check := func(group string, tests []string) {
		var bad []string
		for _, name := range tests {
			status, ok := statuses[name]
			if !ok {
				status = StatusMissing
			}
			if status != StatusPassed {
				bad = append(bad, fmt.Sprintf("%s [%s]", name, status))
			}
		}
		if len(bad) == 0 {
			return
		}
		sort.Strings(bad)
		// Capped: an instance with 2,480 PASS_TO_PASS tests that all broke
		// would otherwise write a report nobody can read to find the one line
		// that matters.
		shown := bad
		suffix := ""
		if len(shown) > 5 {
			shown, suffix = shown[:5], fmt.Sprintf(" (and %d more)", len(bad)-5)
		}
		problems = append(problems, fmt.Sprintf("%s: %s%s", group, strings.Join(shown, ", "), suffix))
	}

	check("FAIL_TO_PASS", failToPass)
	check("PASS_TO_PASS", passToPass)

	// Nothing recognized at all is reported as its own failure rather than as
	// "every test failed". The likely cause is a build error before the suite
	// ran, or a log format this parser does not understand, and both are
	// facts about the run rather than about the patch.
	if len(statuses) == 0 {
		return false, []string{"no test results found in the log -- the suite may not have run, or its output format is not supported"}
	}
	return len(problems) == 0, problems
}
