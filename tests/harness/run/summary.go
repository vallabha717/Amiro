package run

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Status of one test.
const (
	StatusPassed  = "passed"
	StatusFailed  = "failed"
	StatusSkipped = "skipped"
)

// TestResult is one entry in summary.json.
//
// Address is the stable identity from docs/testing/03-selection.md --
// surface/feature/name -- so two runs' results can be diffed directly. ID is
// its slug, and is the directory name its artifacts live under.
type TestResult struct {
	Address    string `json:"address"`
	ID         string `json:"id"`
	Surface    string `json:"surface"`
	Feature    string `json:"feature"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	DurationMS int64  `json:"durationMs"`
	Attempt    int    `json:"attempt,omitempty"`
	// Reason carries the skip reason or the failure message. A skipped test
	// with no reason is a bug in whatever skipped it: an invisible skip is
	// how a suite reports green while running nothing.
	Reason    string   `json:"reason,omitempty"`
	Artifacts []string `json:"artifacts,omitempty"`
	Tags      []string `json:"tags,omitempty"`
}

// Results accumulates test outcomes. Safe for concurrent use: `go test`
// runs a surface's features in parallel, and every one of them records here.
type Results struct {
	mu      sync.Mutex
	entries []TestResult
}

func NewResults() *Results { return &Results{} }

func (r *Results) Add(t TestResult) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, t)
}

func (r *Results) All() []TestResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := append([]TestResult(nil), r.entries...)
	sort.Slice(out, func(i, j int) bool { return out[i].Address < out[j].Address })
	return out
}

// Merge folds in results another process wrote, so the orchestrator's
// summary covers `go test` shards and Playwright alike.
func (r *Results) Merge(other []TestResult) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, other...)
}

// ResultsFile is the append-only record every process writes its outcomes
// to, one JSON object per line.
//
// It exists so that no process is REQUIRED to survive to the end for its
// results to count. A `go test` binary with no TestMain, a shard killed by
// a timeout, the Playwright reporter -- each appends as it goes, and the
// summary is rendered from the file rather than from any one process's
// memory. A crashed run still summarises everything that finished.
const ResultsFile = "results.ndjson"

// RecordResult appends one outcome and refreshes the summary.
//
// The summary is re-rendered on every result rather than once at the end,
// because "once at the end" does not happen when a run is interrupted --
// and an interrupted run is exactly when someone wants to read what got as
// far as passing.
func (r *Run) RecordResult(t TestResult) {
	r.Log.NDJSON(ResultsFile, t)
	r.results.Add(t)
	_ = r.WriteSummary()
}

// LoadResults reads every recorded outcome from the run directory.
func LoadResults(dir string) ([]TestResult, error) {
	f, err := os.Open(filepath.Join(dir, ResultsFile))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	var out []TestResult
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var t TestResult
		if err := json.Unmarshal(line, &t); err != nil {
			// One malformed line must not lose the other hundred. A
			// partial write from a killed process is exactly the case this
			// file has to survive.
			continue
		}
		out = append(out, t)
	}
	return out, sc.Err()
}

// Summary is summary.json: the whole run's outcome.
type Summary struct {
	RunID      string            `json:"runId"`
	StartedAt  time.Time         `json:"startedAt"`
	FinishedAt time.Time         `json:"finishedAt"`
	DurationMS int64             `json:"durationMs"`
	Status     string            `json:"status"`
	Selection  string            `json:"selection"`
	Providers  string            `json:"providers"`
	Totals     Totals            `json:"totals"`
	BySurface  map[string]Totals `json:"bySurface"`
	Tests      []TestResult      `json:"tests"`
	// SkipReasons aggregates why whole surfaces were skipped -- "cargo not
	// found" belongs in the summary, not only in a log line.
	SkipReasons map[string]string `json:"skipReasons,omitempty"`
	// Retried lists every address that ran more than once, full attempt
	// history included, regardless of the final verdict. Totals/BySurface
	// count only each address's LAST attempt -- the actual verdict -- so a
	// retried pass counts as one pass, not one pass plus one failure. This
	// field is what keeps that retry from disappearing: it is rendered
	// unconditionally by RenderMarkdown whenever non-empty, so "3 passed"
	// can never silently mean "1 of those needed a retry to get there."
	Retried []RetryRecord `json:"retried,omitempty"`
	// TotalCostUSD is the sum of CostFile -- non-zero only in live/record
	// mode. Always present so a summary.md reader sees $0.00 explicitly
	// rather than wondering whether cost was tracked at all.
	TotalCostUSD float64 `json:"totalCostUsd"`
}

// RetryRecord is one test's full attempt history, address plus every
// TestResult recorded for it in attempt order.
type RetryRecord struct {
	Address  string       `json:"address"`
	Attempts []TestResult `json:"attempts"`
}

type Totals struct {
	Passed     int   `json:"passed"`
	Failed     int   `json:"failed"`
	Skipped    int   `json:"skipped"`
	DurationMS int64 `json:"durationMs"`
}

func (t Totals) Total() int { return t.Passed + t.Failed + t.Skipped }

// skipReasons is set by the orchestrator for surface-level skips.
var skipReasons = struct {
	mu sync.Mutex
	m  map[string]string
}{m: map[string]string{}}

// SkipSurface records that a whole surface did not run, and why.
func SkipSurface(surface, reason string) {
	skipReasons.mu.Lock()
	defer skipReasons.mu.Unlock()
	skipReasons.m[surface] = reason
}

// Summarise builds the summary from the accumulated results.
func (r *Run) Summarise() Summary {
	// Read from disk rather than memory: several processes contribute to
	// one run, and only the file has all of them.
	tests, err := LoadResults(r.Dir)
	if err != nil || len(tests) == 0 {
		tests = r.results.All()
	}
	tests = dedupe(tests)
	totalCost, _ := TotalCost(r.Dir)
	finished := time.Now().UTC()
	s := Summary{
		TotalCostUSD: totalCost,
		RunID:        r.ID,
		StartedAt:    r.StartedAt,
		FinishedAt:   finished,
		DurationMS:   finished.Sub(r.StartedAt).Milliseconds(),
		Selection:    r.Selection.String(),
		Providers:    r.Config.Config.Providers.Mode,
		Totals:       Totals{},
		BySurface:    map[string]Totals{},
		Tests:        tests,
		SkipReasons:  map[string]string{},
	}
	skipReasons.mu.Lock()
	for k, v := range skipReasons.m {
		s.SkipReasons[k] = v
	}
	skipReasons.mu.Unlock()

	// Group by address. Totals count only the LAST attempt per address --
	// the actual verdict -- never every attempt: a test that failed once
	// and passed on retry is one pass, not one pass and one failure. Every
	// address with more than one attempt also becomes a RetryRecord, which
	// RenderMarkdown surfaces unconditionally, so the retry is visible
	// even though the top-line numbers read as a clean pass.
	byAddress := map[string][]TestResult{}
	var order []string
	for _, t := range tests {
		if _, seen := byAddress[t.Address]; !seen {
			order = append(order, t.Address)
		}
		byAddress[t.Address] = append(byAddress[t.Address], t)
	}
	for _, addr := range order {
		attempts := byAddress[addr]
		if len(attempts) > 1 {
			s.Retried = append(s.Retried, RetryRecord{Address: addr, Attempts: attempts})
		}
		last := attempts[len(attempts)-1]
		bucket := s.BySurface[last.Surface]
		switch last.Status {
		case StatusPassed:
			s.Totals.Passed++
			bucket.Passed++
		case StatusFailed:
			s.Totals.Failed++
			bucket.Failed++
		default:
			s.Totals.Skipped++
			bucket.Skipped++
		}
		bucket.DurationMS += last.DurationMS
		s.BySurface[last.Surface] = bucket
	}
	s.Totals.DurationMS = s.DurationMS
	if s.Totals.Failed > 0 {
		s.Status = "FAILED"
	} else {
		s.Status = "PASSED"
	}
	return s
}

// WriteSummary renders summary.json and summary.md.
func (r *Run) WriteSummary() error {
	s := r.Summarise()
	if err := r.Log.WriteJSON(SummaryJSON, s); err != nil {
		return err
	}
	if err := r.Log.WriteFile(SummaryMD, []byte(RenderMarkdown(s, r.Dir))); err != nil {
		return err
	}
	return nil
}

// RenderMarkdown produces summary.md: readable in a terminal, pasteable
// into a PR, and -- the part that matters for an agent reading it -- every
// failure names the artifacts that explain it, by path.
func RenderMarkdown(s Summary, runDir string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Amiro test run %s\n\n", s.RunID)
	fmt.Fprintf(&b, "**%s** · %d passed · %d failed · %d skipped · %s\n",
		s.Status, s.Totals.Passed, s.Totals.Failed, s.Totals.Skipped, humanDuration(s.DurationMS))
	sel := s.Selection
	if sel == "" {
		sel = "everything"
	}
	fmt.Fprintf(&b, "Started %s · selection: %s · providers: %s · spend: $%.2f\n\n",
		s.StartedAt.Format(time.RFC3339), sel, s.Providers, s.TotalCostUSD)

	if len(s.BySurface) > 0 {
		b.WriteString("| Surface | Passed | Failed | Skipped | Duration |\n")
		b.WriteString("|---------|--------|--------|---------|----------|\n")
		surfaces := make([]string, 0, len(s.BySurface))
		for k := range s.BySurface {
			surfaces = append(surfaces, k)
		}
		sort.Strings(surfaces)
		for _, name := range surfaces {
			t := s.BySurface[name]
			row := fmt.Sprintf("| %-7s | %6d | %6d | %7d | %8s |", name, t.Passed, t.Failed, t.Skipped, humanDuration(t.DurationMS))
			if reason := s.SkipReasons[name]; reason != "" {
				row += "  ← " + reason
			}
			b.WriteString(row + "\n")
		}
		b.WriteString("\n")
	}
	for surface, reason := range s.SkipReasons {
		if _, ran := s.BySurface[surface]; !ran {
			fmt.Fprintf(&b, "- **%s** did not run: %s\n", surface, reason)
		}
	}

	final := lastAttemptPerAddress(s.Tests)

	if len(s.Retried) > 0 {
		b.WriteString("\n## Retried\n\n")
		b.WriteString("Every retry is listed here regardless of outcome -- a pass after a retry is " +
			"counted above as a pass, but it is never indistinguishable from one that never failed.\n\n")
		for _, rr := range s.Retried {
			fmt.Fprintf(&b, "### %s\n", rr.Address)
			for _, a := range rr.Attempts {
				line := fmt.Sprintf("  attempt %d: %s", a.Attempt, a.Status)
				if a.Reason != "" {
					line += " -- " + strings.TrimSpace(a.Reason)
				}
				b.WriteString(line + "\n")
			}
			b.WriteString("\n")
		}
	}

	var failures []TestResult
	for _, t := range final {
		if t.Status == StatusFailed {
			failures = append(failures, t)
		}
	}
	if len(failures) > 0 {
		b.WriteString("\n## Failures\n\n")
		for _, t := range failures {
			fmt.Fprintf(&b, "### %s\n", t.Address)
			if t.Reason != "" {
				fmt.Fprintf(&b, "%s\n", strings.TrimSpace(t.Reason))
			}
			for _, a := range t.Artifacts {
				fmt.Fprintf(&b, "  %s\n", filepath.Join(runDir, a))
			}
			fmt.Fprintf(&b, "  timeline  amirotest report --run %s --timeline --test '%s'\n\n", s.RunID, t.Address)
		}
	}

	var skipped []TestResult
	for _, t := range final {
		if t.Status == StatusSkipped {
			skipped = append(skipped, t)
		}
	}
	if len(skipped) > 0 {
		b.WriteString("\n## Skipped\n\n")
		for _, t := range skipped {
			reason := t.Reason
			if reason == "" {
				reason = "no reason recorded -- this is a bug in whatever skipped it"
			}
			fmt.Fprintf(&b, "- `%s` — %s\n", t.Address, reason)
		}
	}

	fmt.Fprintf(&b, "\nArtifacts: %s\n", runDir)
	return b.String()
}

// lastAttemptPerAddress keeps only the highest-attempt TestResult for each
// address -- the actual verdict, once retries are accounted for. tests is
// assumed sorted by (address, attempt) ascending, which is dedupe's own
// output order and Summarise's own s.Tests order.
func lastAttemptPerAddress(tests []TestResult) []TestResult {
	byAddress := map[string]TestResult{}
	var order []string
	for _, t := range tests {
		if _, seen := byAddress[t.Address]; !seen {
			order = append(order, t.Address)
		}
		byAddress[t.Address] = t
	}
	out := make([]TestResult, 0, len(order))
	for _, addr := range order {
		out = append(out, byAddress[addr])
	}
	return out
}

func humanDuration(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	if d < time.Second {
		return fmt.Sprintf("%dms", ms)
	}
	if d < time.Minute {
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	return fmt.Sprintf("%dm %ds", int(d.Minutes()), int(d.Seconds())%60)
}

// ReadSummary loads summary.json from a run directory.
func ReadSummary(dir string) (*Summary, error) {
	raw, err := os.ReadFile(filepath.Join(dir, SummaryJSON))
	if err != nil {
		return nil, err
	}
	var s Summary
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Slug turns a test address into the directory name its artifacts live
// under: backend/chat/TestStream -> backend-chat-TestStream.
//
// Stable across runs by construction, which is what makes diffing two runs'
// artifact trees trivial.
func Slug(address string) string {
	var b strings.Builder
	for _, r := range address {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := b.String()
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	return strings.Trim(out, "-")
}

// dedupe keeps the last outcome recorded for each (address, attempt).
//
// A retried test appends a second line; both are kept, because attempt-2
// passing after attempt-1 failed is information. Two lines for the SAME
// attempt can only be a re-render racing an append, and the later one wins.
func dedupe(in []TestResult) []TestResult {
	type key struct {
		address string
		attempt int
	}
	last := map[key]int{}
	for i, t := range in {
		last[key{t.Address, t.Attempt}] = i
	}
	out := make([]TestResult, 0, len(last))
	for i, t := range in {
		if last[key{t.Address, t.Attempt}] == i {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Address != out[j].Address {
			return out[i].Address < out[j].Address
		}
		return out[i].Attempt < out[j].Attempt
	})
	return out
}
