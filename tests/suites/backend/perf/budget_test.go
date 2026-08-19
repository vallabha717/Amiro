// Package perf_test holds Phase 7 section 3's performance budgets.
//
// The phase document is explicit about what these are and are not:
// "Coarse, generous, and asserted -- not a benchmark suite, a regression
// alarm. Numbers are placeholders to be calibrated against a reference
// runner in this phase and then held... Budgets are `slow`-tagged and run
// nightly, not on every push -- machine variance would make them a flake
// source in the merge gate. Results are recorded per run so a trend is
// visible, and a regression is reported as a delta against the last 10
// runs rather than a hard threshold alone."
// (docs/testing/phases/phase-07-cross-surface.md §3)
//
// Every test here therefore carries harness.Tags("slow"), which the default
// configuration excludes (harness/config/defaults.go: run.tags.exclude =
// live, slow, flaky). To actually RUN them:
//
//	AMIRO_TEST_RUN_TAGS_EXCLUDE= AMIRO_TEST_RUN_TAGS_INCLUDE=slow \
//	  go test ./suites/backend/perf/... -v
//
// The empty exclude list is required: selector.Decide gives exclusion
// priority over inclusion, so `--tag slow` against the default exclusion is
// a contradiction that resolves to "skipped".
//
// Measurement discipline. Every budget goes through record(), which does
// three things in one place so no test can measure without recording or
// record without asserting:
//
//  1. appends the measurement to the run's own perf/budgets.ndjson, so the
//     artifact trail of any single run carries its numbers;
//  2. appends it to a cross-run trend file (see trendPath) and computes a
//     delta against up to the last trendWindow recorded values;
//  3. asserts the hard threshold, and separately WARNS on a trend
//     regression -- warning rather than failing, because "coarse, generous"
//     rules out failing a nightly job on machine variance alone.
package perf_test

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/config"
)

// The budget names. These are the keys the trend file is indexed by, so
// renaming one silently starts a new trend rather than continuing an old
// one -- hence constants rather than string literals at the call sites.
const (
	budgetColdStart     = "backend.cold_start_to_healthy"
	budgetTUIEmbedded   = "tui.launch_to_first_frame.embedded"
	budgetTUIAttached   = "tui.launch_to_first_frame.attached"
	budgetDashboardTTFB = "dashboard.html_time_to_first_byte"
	budgetFirstToken    = "chat.first_streamed_token"
	budgetThreadList    = "thread.list_500"
	budgetRepomap       = "agent.repomap_large_workspace"
	budgetMemoryRSS     = "backend.rss_after_100_turns"
)

// The targets, transcribed verbatim from the phase document's table. Kept
// beside the names so the whole budget table is readable in one place.
const (
	limitColdStart   = 2 * time.Second
	limitTUIEmbedded = 3 * time.Second
	limitTUIAttached = 1 * time.Second
	limitDashboard   = 2 * time.Second
	limitFirstToken  = 500 * time.Millisecond
	limitThreadList  = 300 * time.Millisecond
	limitRepomap     = 5 * time.Second

	// limitMemoryRSS is "< 500MB RSS". Recorded in bytes and compared in
	// bytes; the trend file's ElapsedMS field carries megabytes for this one
	// budget, which is why it is named Value in the JSON rather than being
	// pretended to be a duration.
	limitMemoryRSSBytes = 500 << 20
)

// trendWindow is how many previously recorded runs a regression is measured
// against: "a regression is reported as a delta against the last 10 runs".
const trendWindow = 10

// trendRegressionFactor is how far past the trend's median a measurement
// has to land before it is called a regression. 1.5x is deliberately loose:
// a nightly budget job on a shared runner sees far more than 20% variance
// from scheduling alone, and an alarm that cries wolf gets muted.
const trendRegressionFactor = 1.5

// trendRegressionFloor suppresses the alarm for measurements small enough
// that a 1.5x ratio is noise. 20ms past the median is the smallest delta
// worth a human's attention on any of these budgets.
const trendRegressionFloor = 20.0

// sample is one line of the trend file.
//
// Value is a float and Unit names what it is, rather than a time.Duration,
// because one of these budgets is a memory figure. A schema that could only
// hold milliseconds would have forced the RSS budget out of the trend
// mechanism entirely, which is the one budget where a trend matters most --
// a leak shows up as drift long before it crosses 500MB.
type sample struct {
	Budget string    `json:"budget"`
	Value  float64   `json:"value"`
	Unit   string    `json:"unit"`
	Limit  float64   `json:"limit"`
	RunID  string    `json:"runId"`
	At     time.Time `json:"at"`
	GOOS   string    `json:"goos"`
	Arch   string    `json:"arch"`
	NumCPU int       `json:"numCpu"`
	// Note carries anything a reader needs to interpret the number: which
	// proxy was measured, what the fake provider does not model.
	Note string `json:"note,omitempty"`
}

// trendFileName is the cross-run record, kept in logs/ beside the run
// directories rather than inside one.
//
// logs/ is where every run already writes, harness/run.Prune only ever
// deletes entries that parse as a run id (looksLikeRunID), and the whole
// directory is gitignored -- so a plain file here survives pruning, is
// never committed, and needs no new configuration key. A nightly CI job
// that wants a trend across machines must cache/restore this one file
// between runs; without that, each fresh runner starts with an empty trend
// and gets threshold-only assertions, which is a degradation rather than a
// failure.
//
// Two known ways to lose the history, both acceptable and both degrading to
// threshold-only rather than to a failure: `amirotest clean --all` removes
// the whole logs directory, and a fresh clone has never had one.
const trendFileName = "perf-trend.ndjson"

func trendPath(h *harness.Harness) string {
	return filepath.Join(config.Resolve(h.BaseDir, h.Config.Logging.Dir), trendFileName)
}

// readTrend returns the previously recorded values for one budget, oldest
// first, capped at the last trendWindow.
//
// A missing or unreadable file is not an error: the first run on a machine
// legitimately has no history, and a trend mechanism that failed the test
// when it had nothing to compare against would make a fresh checkout red.
func readTrend(path, budget string) []sample {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []sample
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var s sample
		if err := json.Unmarshal([]byte(line), &s); err != nil {
			// One torn line must not lose the rest of the history, for the
			// same reason run.LoadResults tolerates one: a killed process
			// is exactly the case this file has to survive.
			continue
		}
		if s.Budget == budget {
			out = append(out, s)
		}
	}
	if len(out) > trendWindow {
		out = out[len(out)-trendWindow:]
	}
	return out
}

// appendTrend adds one line to the trend file.
//
// O_APPEND with a single short write: POSIX makes that atomic with respect
// to other appenders, which is what keeps two parallel `go test` packages
// from interleaving a torn record. Deliberately no flock -- harness/logging
// owns the only advisory-lock helper in this tree and it is unexported, and
// duplicating it here to protect a 200-byte append would be building for a
// hazard that O_APPEND already covers.
func appendTrend(path string, s sample) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	line, err := json.Marshal(s)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(line, '\n'))
	return err
}

// median of a sorted-in-place copy. Median rather than mean because one
// pathological run -- a cold build cache, a runner that got descheduled --
// should not poison the baseline the next ten runs are judged against.
func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	cp := append([]float64(nil), values...)
	sort.Float64s(cp)
	mid := len(cp) / 2
	if len(cp)%2 == 1 {
		return cp[mid]
	}
	return (cp[mid-1] + cp[mid]) / 2
}

// recordDuration is record() for the seven budgets measured in time.
func recordDuration(h *harness.Harness, budget string, measured, limit time.Duration, note string) {
	h.T.Helper()
	// Both value and limit are converted the same way, through microseconds.
	// Using limit.Milliseconds() here instead truncated a sub-millisecond
	// limit to 0, and record() treats a zero limit as "no threshold" -- so a
	// deliberately impossible budget silently passed. Found by mutating this
	// file to prove the repomap budget was non-vacuous, which is exactly the
	// failure such a mutation is supposed to catch.
	record(h, sample{
		Budget: budget,
		Value:  float64(measured.Microseconds()) / 1000, // ms, sub-ms resolution kept
		Unit:   "ms",
		Limit:  float64(limit.Microseconds()) / 1000,
		Note:   note,
	})
}

// record appends, compares and asserts. The single door every budget goes
// through, so "measured but never asserted" is not expressible.
func record(h *harness.Harness, s sample) {
	h.T.Helper()

	s.RunID = h.Run.ID
	s.At = time.Now().UTC()
	s.GOOS = runtime.GOOS
	s.Arch = runtime.GOARCH
	s.NumCPU = runtime.NumCPU()

	path := trendPath(h)
	// Read BEFORE appending, so the current run is compared against history
	// rather than against itself.
	history := readTrend(path, s.Budget)

	// Two records, deliberately. The run's own directory gets one so a
	// single run's artifacts are self-contained; the trend file gets one so
	// the next run has something to compare against.
	h.Log.NDJSON(filepath.ToSlash(filepath.Join(h.Surface, h.TestID, "perf", "budgets.ndjson")), s)
	if err := appendTrend(path, s); err != nil {
		// A trend that cannot be written is worth saying out loud -- it
		// silently turns every future run into a threshold-only check --
		// but it is not a reason to fail a budget that was met.
		h.T.Logf("perf: could not append to the trend file %s: %v", path, err)
	}

	report := fmt.Sprintf("%s = %s (budget %s)",
		s.Budget, formatValue(s.Value, s.Unit), formatValue(s.Limit, s.Unit))

	// The trend delta, always reported whether or not it is a regression:
	// "Results are recorded per run so a trend is visible".
	var prior []float64
	for _, p := range history {
		prior = append(prior, p.Value)
	}
	trendNote := "no prior runs recorded -- threshold only"
	regressed := false
	if len(prior) > 0 {
		base := median(prior)
		delta := s.Value - base
		pct := 0.0
		if base > 0 {
			pct = delta / base * 100
		}
		trendNote = fmt.Sprintf("median of last %d runs = %s, delta %+.1f%s (%+.1f%%)",
			len(prior), formatValue(base, s.Unit), delta, s.Unit, pct)
		regressed = base > 0 && s.Value > base*trendRegressionFactor && delta > trendRegressionFloor
	}

	h.Emit("perf", "budget", map[string]any{
		"budget": s.Budget, "value": s.Value, "unit": s.Unit, "limit": s.Limit,
		"trend": trendNote, "regressed": regressed, "priorRuns": len(prior),
	})
	h.T.Logf("PERF %s\n     trend: %s", report, trendNote)

	if regressed {
		// A WARNING, not a failure. The phase document asks for a
		// regression to be "reported as a delta against the last 10 runs
		// rather than a hard threshold alone" -- reported, and the hard
		// threshold below is what is asserted. Failing a nightly job on a
		// 1.5x swing that is still inside budget would make the alarm
		// useless within a week on any shared runner.
		h.T.Logf("PERF REGRESSION WARNING: %s is %.1fx the median of the last %d runs (%s). "+
			"Still within budget, so this is not a failure -- but it is the delta the nightly job exists to surface.",
			s.Budget, s.Value/median(prior), len(prior), trendNote)
	}

	if s.Limit > 0 && s.Value > s.Limit {
		h.T.Errorf("PERF BUDGET EXCEEDED: %s\n     %s\n     recorded to %s", report, trendNote, path)
	}
}

func formatValue(v float64, unit string) string {
	switch unit {
	case "ms":
		if v >= 1000 {
			return strconv.FormatFloat(v/1000, 'f', 2, 64) + "s"
		}
		return strconv.FormatFloat(v, 'f', 1, 64) + "ms"
	default:
		return strconv.FormatFloat(v, 'f', 1, 64) + unit
	}
}

// rssBytes reads a process's resident set size out of /proc/<pid>/status.
//
// Linux-only by construction. The alternative -- shelling out to ps -- is
// not obviously more portable and is definitely slower, and the one budget
// that needs this is explicitly a Linux/CI-runner concern. Callers gate on
// runtime.GOOS themselves so the skip carries a reason.
func rssBytes(pid int) (int64, error) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "status"))
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		rest, ok := strings.CutPrefix(line, "VmRSS:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 1 {
			return 0, fmt.Errorf("/proc/%d/status: unreadable VmRSS line %q", pid, line)
		}
		kb, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			return 0, fmt.Errorf("/proc/%d/status: VmRSS %q is not a number", pid, fields[0])
		}
		return kb * 1024, nil
	}
	return 0, fmt.Errorf("/proc/%d/status has no VmRSS line", pid)
}

// requireLinux skips with a recorded reason on anything without /proc.
func requireLinux(h *harness.Harness, what string) {
	h.T.Helper()
	if runtime.GOOS != "linux" {
		h.Skip(what + " is measured by reading /proc/<pid>/status, which exists only on Linux; " +
			"closing this on another platform means a per-OS RSS reader in harness/process")
	}
}

// countGoFiles counts .go files under root, so a test can prove it is
// looking at the workspace fixture it thinks it is.
func countGoFiles(t *testing.T, root string) int {
	t.Helper()
	count := 0
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".go") {
			count++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	return count
}

// mkdir is os.MkdirAll with the mode every other directory in this tree uses.
func mkdir(path string) error { return os.MkdirAll(path, 0o755) }

// readFull drains r into buf, returning how much it got. io.ReadFull would
// fail on a short read, which is the normal case for an HTML document
// smaller than the buffer.
func readFull(r io.Reader, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := r.Read(buf[total:])
		total += n
		if err != nil {
			if err == io.EOF {
				return total, nil
			}
			return total, err
		}
	}
	return total, nil
}

// readLockBytes returns sidecar.lock.json's exact contents.
//
// Compared byte for byte rather than field by field: appwiring.WriteLock
// rewrites the whole file, so any second writer changes something, and the
// test does not need to know which field to notice.
func readLockBytes(t *testing.T, appDataDir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(appDataDir, "sidecar.lock.json"))
	if err != nil {
		t.Fatalf("reading the discovery lock in %s: %v", appDataDir, err)
	}
	return string(data)
}

// assertLockWritten fails unless a discovery lock naming a real port
// exists -- the evidence that an embedded backend actually started.
func assertLockWritten(t *testing.T, appDataDir string) {
	t.Helper()
	var lock struct {
		PID  int `json:"pid"`
		Port int `json:"port"`
	}
	if err := json.Unmarshal([]byte(readLockBytes(t, appDataDir)), &lock); err != nil {
		t.Fatalf("parsing the discovery lock in %s: %v", appDataDir, err)
	}
	if lock.PID == 0 || lock.Port == 0 {
		t.Fatalf("the discovery lock in %s names no running backend (%+v); nothing was embedded",
			appDataDir, lock)
	}
}
