package assert

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEventually_SucceedsAsSoonAsTheConditionHolds(t *testing.T) {
	calls := 0
	started := time.Now()
	Eventually(t, "the third call", time.Second, func() error {
		calls++
		if calls < 3 {
			return errNotYet
		}
		return nil
	})
	// A poll, not a sleep: it must return on the attempt that succeeds, not
	// after a fixed wait.
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Errorf("took %s for a condition that held on the third poll", elapsed)
	}
}

var errNotYet = errNotYetType{}

type errNotYetType struct{}

func (errNotYetType) Error() string { return "not yet" }

func TestNormalizer_ReplacesEverythingThatVariesBetweenRuns(t *testing.T) {
	n := DefaultNormalizer()
	input := `{
  "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  "createdAt": "2026-08-19T14:32:05.123Z",
  "url": "http://127.0.0.1:54321/storage/abc",
  "durationMs": 1487,
  "usage": {"totalTokens": 918}
}`
	got := n.Apply(input)
	for _, want := range []string{"<uuid>", "<timestamp>", "127.0.0.1:<port>", "<ms>", "<tokens>"} {
		if !strings.Contains(got, want) {
			t.Errorf("normaliser did not produce %s:\n%s", want, got)
		}
	}
	// Without this, every golden fails on the first uuid.
	if strings.Contains(got, "3f2504e0") {
		t.Error("the uuid survived normalisation")
	}
	// Two runs must normalise to the same text -- that is the whole point.
	other := n.Apply(strings.ReplaceAll(input, "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
		"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
	if got != other {
		t.Errorf("two runs normalise differently:\n%s\n---\n%s", got, other)
	}
}

func TestNormalizer_AddLiteralMasksARunSpecificPath(t *testing.T) {
	n := DefaultNormalizer().AddLiteral("/tmp/run-abc123", "<runDir>")
	got := n.Apply("workspace at /tmp/run-abc123/backend/x/workspace")
	if strings.Contains(got, "run-abc123") {
		t.Errorf("the literal was not replaced: %s", got)
	}
	if !strings.Contains(got, "<runDir>/backend/x/workspace") {
		t.Errorf("unexpected result: %s", got)
	}
}

func TestJSONSubset_IgnoresFieldsTheTestDidNotAskAbout(t *testing.T) {
	// Subset rather than equality on purpose: asserting on a whole response
	// couples a test to fields it does not care about, and every added
	// optional field then breaks tests that had nothing to do with it.
	got := []byte(`{"id":"a1","title":"hello","userId":"u1","createdAt":"2026-01-01T00:00:00Z"}`)
	JSONSubset(t, map[string]any{"title": "hello", "userId": "u1"}, got)
}

func TestJSONSubset_ChecksNestedObjectsAndArrayPrefixes(t *testing.T) {
	got := []byte(`{"users":[{"email":"a@x","role":"admin"},{"email":"b@x","role":"user"}],"total":2}`)
	JSONSubset(t, map[string]any{
		"total": 2,
		"users": []any{map[string]any{"role": "admin"}},
	}, got)
}

func TestDiff_ShowsTheFirstDifferingLine(t *testing.T) {
	out := Diff("alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n")
	if !strings.Contains(out, "-   2 beta") || !strings.Contains(out, "+   2 BETA") {
		t.Errorf("diff does not locate the change:\n%s", out)
	}
	if strings.Contains(out, "alpha") {
		t.Errorf("diff includes identical lines, which buries the change:\n%s", out)
	}
}

func TestGolden_WritesOnUpdateAndComparesOtherwise(t *testing.T) {
	t.Chdir(t.TempDir())

	// First pass: create it. Second pass: compare against what was written.
	Golden(t, "example", "the expected output\n", nil, true)
	Golden(t, "example", "the expected output\n", nil, false)

	// A mismatch must fail, with a diff that locates the change.
	err := CompareGolden(filepath.Join("testdata", "example.golden"), "something else\n")
	if err == nil {
		t.Fatal("a golden mismatch did not fail")
	}
	for _, want := range []string{"golden mismatch", "example.golden", "-   1 the expected output", "+   1 something else"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the failure message is missing %q:\n%v", want, err)
		}
	}
}

func TestCompareGolden_MissingFileSaysWhatItWouldContain(t *testing.T) {
	t.Chdir(t.TempDir())
	err := CompareGolden(filepath.Join("testdata", "never-created.golden"), "would-be content\n")
	if err == nil {
		t.Fatal("a missing golden file did not fail")
	}
	// Actionable, not merely accurate: the message names the flag that
	// creates the file and shows what would go in it.
	for _, want := range []string{"--update-golden", "would-be content"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the failure message is missing %q:\n%v", want, err)
		}
	}
}

func TestGoldenUpdate_RewritesRatherThanComparing(t *testing.T) {
	t.Chdir(t.TempDir())
	path := filepath.Join("testdata", "rewrite.golden")

	Golden(t, "rewrite", "first\n", nil, true)
	Golden(t, "rewrite", "second\n", nil, true)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "second\n" {
		t.Errorf("golden holds %q after a second update", data)
	}
	// Which is exactly why --update-golden is never set in CI or in a
	// committed config: with it on, no rendering assertion can fail.
	if err := CompareGolden(path, "first\n"); err == nil {
		t.Error("the golden was not actually rewritten")
	}
}
