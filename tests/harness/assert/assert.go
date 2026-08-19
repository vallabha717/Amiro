// Package assert provides the comparison and waiting helpers every suite
// uses: golden files with normalisation, JSON subset matching, and
// deadline-bounded polling.
//
// There is no Sleep here, and there is not going to be one. A sleep is a
// race that has been rounded up rather than removed: too short and it
// flakes, too long and the suite crawls, and either way it is not evidence
// that the thing being waited for actually happened.
package assert

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// Eventually polls cond until it returns nil or the deadline passes.
//
// On timeout it reports the LAST error, not a bare "timed out" -- the last
// observed state is the whole diagnostic value, and a helper that discards
// it makes every timeout look identical.
func Eventually(t *testing.T, what string, within time.Duration, cond func() error) {
	t.Helper()
	deadline := time.Now().Add(within)
	interval := 10 * time.Millisecond
	var last error
	for {
		if last = cond(); last == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s\nlast attempt: %v", within, what, last)
		}
		time.Sleep(interval)
		if interval < 250*time.Millisecond {
			interval *= 2
		}
	}
}

// Never asserts cond keeps failing for the whole window -- the inverse
// check, for "this must NOT appear".
func Never(t *testing.T, what string, within time.Duration, cond func() error) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if err := cond(); err == nil {
			t.Fatalf("%s happened, and should not have", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Normalizer replaces values that legitimately differ between runs with
// stable placeholders, so a golden file can compare everything else.
//
// This is the load-bearing part of API goldens. Without it every golden
// fails on the first uuid.
type Normalizer struct {
	rules []rule
}

type rule struct {
	re   *regexp.Regexp
	with string
}

// DefaultNormalizer covers what varies in every Amiro response.
func DefaultNormalizer() *Normalizer {
	n := &Normalizer{}
	n.Add(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`, "<uuid>")
	n.Add(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})`, "<timestamp>")
	// Ports are OS-assigned per test, so any :NNNNN after a host is noise.
	n.Add(`(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}`, "$1:<port>")
	n.Add(`"durationMs":\s*\d+`, `"durationMs": <ms>`)
	// Token counts vary even in replay: prompts embed a date, and a
	// different date is a different tokenisation.
	n.Add(`"(promptTokens|completionTokens|totalTokens)":\s*\d+`, `"$1": <tokens>`)
	return n
}

func (n *Normalizer) Add(pattern, replacement string) *Normalizer {
	n.rules = append(n.rules, rule{re: regexp.MustCompile(pattern), with: replacement})
	return n
}

// AddLiteral replaces an exact string -- a run directory path, a generated
// token -- with a placeholder.
func (n *Normalizer) AddLiteral(literal, replacement string) *Normalizer {
	if literal == "" {
		return n
	}
	return n.Add(regexp.QuoteMeta(literal), replacement)
}

func (n *Normalizer) Apply(s string) string {
	for _, r := range n.rules {
		s = r.re.ReplaceAllString(s, r.with)
	}
	return s
}

// Golden compares got against testdata/<name>.golden.
//
// update rewrites the file instead of comparing. It is wired to
// `amirotest run --update-golden` and to tui.goldenUpdate, and never to CI:
// a golden update has to be visible in a diff and reviewed, or the golden
// stops meaning anything.
func Golden(t *testing.T, name string, got string, normalizer *Normalizer, update bool) {
	t.Helper()
	if normalizer != nil {
		got = normalizer.Apply(got)
	}
	path := filepath.Join("testdata", name+".golden")
	if update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("creating %s: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatalf("writing %s: %v", path, err)
		}
		t.Logf("golden updated: %s", path)
		return
	}
	if err := CompareGolden(path, got); err != nil {
		t.Fatal(err)
	}
}

// GoldenScreen compares a terminal screen frame against testdata/<name>.golden.
// On mismatch, it writes golden.diff to artifactDir and fails with a unified diff.
func GoldenScreen(t *testing.T, artifactDir, name, got string, update bool) {
	t.Helper()
	path := filepath.Join("testdata", name+".golden")
	if update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("creating %s: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatalf("writing %s: %v", path, err)
		}
		t.Logf("golden updated: %s", path)
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			diffMsg := fmt.Sprintf("golden file %s does not exist.\nRun with --update-golden to create it. It would contain:\n%s", path, got)
			if artifactDir != "" {
				_ = os.MkdirAll(artifactDir, 0o755)
				_ = os.WriteFile(filepath.Join(artifactDir, "golden.diff"), []byte(diffMsg), 0o644)
			}
			t.Fatal(diffMsg)
		}
		t.Fatalf("reading %s: %v", path, err)
	}
	if string(want) == got {
		return
	}
	d := Diff(string(want), got)
	if artifactDir != "" {
		_ = os.MkdirAll(artifactDir, 0o755)
		_ = os.WriteFile(filepath.Join(artifactDir, "golden.diff"), []byte(d), 0o644)
	}
	t.Fatalf("golden mismatch: %s\n%s", path, d)
}


// CompareGolden is Golden's comparison, separated out so it is testable
// without the contortions needed to observe a t.Fatalf from another test.
//
// The error text is the failure message a developer reads, so it carries
// what to DO -- the path, the diff, and the flag that rewrites the file --
// rather than only what went wrong.
func CompareGolden(path, got string) error {
	want, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("golden file %s does not exist.\nRun with --update-golden to create it. It would contain:\n%s", path, got)
		}
		return fmt.Errorf("reading %s: %w", path, err)
	}
	if string(want) == got {
		return nil
	}
	return fmt.Errorf("golden mismatch: %s\n%s", path, Diff(string(want), got))
}

// GoldenJSON is Golden for a JSON document, compared after re-indenting so
// that key order and whitespace cannot cause a false mismatch.
func GoldenJSON(t *testing.T, name string, got []byte, normalizer *Normalizer, update bool) {
	t.Helper()
	Golden(t, name, indentJSON(t, got), normalizer, update)
}

func indentJSON(t *testing.T, raw []byte) string {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("response is not JSON: %v\nbody: %s", err, raw)
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatalf("re-encoding: %v", err)
	}
	return string(out) + "\n"
}

// Diff renders a readable unified-ish diff of two strings.
//
// Line-based and deliberately simple: an exact minimal diff is not worth a
// dependency here, and what a reader needs is the first line that differs
// plus context, which this gives.
func Diff(want, got string) string {
	wantLines := strings.Split(want, "\n")
	gotLines := strings.Split(got, "\n")
	var b strings.Builder
	b.WriteString("--- want\n+++ got\n")
	max := len(wantLines)
	if len(gotLines) > max {
		max = len(gotLines)
	}
	shown := 0
	for i := 0; i < max; i++ {
		var w, g string
		if i < len(wantLines) {
			w = wantLines[i]
		}
		if i < len(gotLines) {
			g = gotLines[i]
		}
		if w == g {
			continue
		}
		if shown >= 40 {
			fmt.Fprintf(&b, "... and %d more differing lines\n", countDiff(wantLines, gotLines)-shown)
			break
		}
		if i < len(wantLines) {
			fmt.Fprintf(&b, "-%4d %s\n", i+1, w)
		}
		if i < len(gotLines) {
			fmt.Fprintf(&b, "+%4d %s\n", i+1, g)
		}
		shown++
	}
	return b.String()
}

func countDiff(a, b []string) int {
	max := len(a)
	if len(b) > max {
		max = len(b)
	}
	n := 0
	for i := 0; i < max; i++ {
		var x, y string
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			n++
		}
	}
	return n
}

// JSONSubset asserts every key in want appears in got with the same value.
//
// Subset rather than equality on purpose: asserting on a whole response
// couples a test to fields it does not care about, and every added optional
// field then breaks tests that had nothing to do with it. Where full
// equality IS the point, use GoldenJSON.
func JSONSubset(t *testing.T, want any, got []byte) {
	t.Helper()
	var gotVal any
	if err := json.Unmarshal(got, &gotVal); err != nil {
		t.Fatalf("response is not JSON: %v\nbody: %s", err, got)
	}
	wantRaw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("encoding expectation: %v", err)
	}
	var wantVal any
	if err := json.Unmarshal(wantRaw, &wantVal); err != nil {
		t.Fatalf("encoding expectation: %v", err)
	}
	if err := subset(wantVal, gotVal, "$"); err != nil {
		t.Fatalf("JSON subset mismatch: %v\nfull response:\n%s", err, indentJSON(t, got))
	}
}

func subset(want, got any, path string) error {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: expected an object, got %T", path, got)
		}
		keys := make([]string, 0, len(w))
		for k := range w {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			gv, present := g[k]
			if !present {
				return fmt.Errorf("%s.%s: missing", path, k)
			}
			if err := subset(w[k], gv, path+"."+k); err != nil {
				return err
			}
		}
		return nil
	case []any:
		g, ok := got.([]any)
		if !ok {
			return fmt.Errorf("%s: expected an array, got %T", path, got)
		}
		if len(g) < len(w) {
			return fmt.Errorf("%s: expected at least %d elements, got %d", path, len(w), len(g))
		}
		for i := range w {
			if err := subset(w[i], g[i], fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
		return nil
	default:
		if fmt.Sprint(want) != fmt.Sprint(got) {
			return fmt.Errorf("%s: want %v, got %v", path, want, got)
		}
		return nil
	}
}

// FileExists asserts that path exists on disk.
func FileExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file %s to exist: %v", path, err)
	}
}

