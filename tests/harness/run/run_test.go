package run

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness/config"
)

func result(t *testing.T, dir string) *config.Result {
	t.Helper()
	cfg := config.Defaults()
	cfg.Logging.Dir = filepath.Join(dir, "logs")
	return &config.Result{Config: cfg, BaseDir: dir}
}

func TestMint_WritesRunJSONBeforeAnythingIsSpawned(t *testing.T) {
	dir := t.TempDir()
	r, err := Mint(result(t, dir), Selection{Surfaces: []string{"backend"}})
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	defer r.Log.Close()

	// The manifest must exist the instant Mint returns. A run that dies
	// during startup is then still diagnosable, which is not true of a
	// manifest written at the end.
	m, err := ReadManifest(r.Dir)
	if err != nil {
		t.Fatalf("run.json was not written by Mint: %v", err)
	}
	if m.ID != r.ID {
		t.Errorf("run.json says %q, the run is %q", m.ID, r.ID)
	}
	if len(m.Tools) == 0 {
		t.Error("run.json records no toolchain state; a surface that skipped would not say why")
	}
	if m.Config.Providers.Mode != "replay" {
		t.Errorf("run.json's config is not the resolved one: mode = %q", m.Config.Providers.Mode)
	}
}

func TestMint_RunIDSortsChronologically(t *testing.T) {
	dir := t.TempDir()
	first, err := Mint(result(t, dir), Selection{})
	if err != nil {
		t.Fatal(err)
	}
	first.Log.Close()
	// Pruning relies on lexicographic order matching chronological order --
	// which is why the timestamp leads and is fixed-width, rather than
	// being appended to a random word.
	if !strings.HasPrefix(first.ID, first.StartedAt.Format("2006-01-02T15-04")) {
		t.Errorf("run id %q does not lead with its timestamp", first.ID)
	}
	if !looksLikeRunID(first.ID) {
		t.Errorf("run id %q is not recognised as one, so pruning would skip it", first.ID)
	}
}

func TestMint_PointsLatestAtTheNewestRun(t *testing.T) {
	dir := t.TempDir()
	r, err := Mint(result(t, dir), Selection{})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Log.Close()

	link := filepath.Join(dir, "logs", LatestLink)
	target, err := os.Readlink(link)
	if err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if target != r.ID {
		t.Errorf("logs/latest points at %q, want %q", target, r.ID)
	}
}

func TestPrune_KeepsTheNewestNAndLeavesForeignDirectoriesAlone(t *testing.T) {
	logs := filepath.Join(t.TempDir(), "logs")
	if err := os.MkdirAll(logs, 0o755); err != nil {
		t.Fatal(err)
	}
	ids := []string{
		"2026-08-19T10-00-00Z-aaaaaa",
		"2026-08-19T11-00-00Z-bbbbbb",
		"2026-08-19T12-00-00Z-cccccc",
		"2026-08-19T13-00-00Z-dddddd",
	}
	for _, id := range ids {
		if err := os.MkdirAll(filepath.Join(logs, id), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Something a person put there. Not ours to delete.
	if err := os.MkdirAll(filepath.Join(logs, "keep-this-analysis"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := Prune(logs, 2); err != nil {
		t.Fatalf("Prune: %v", err)
	}
	for _, gone := range ids[:2] {
		if _, err := os.Stat(filepath.Join(logs, gone)); err == nil {
			t.Errorf("%s should have been pruned", gone)
		}
	}
	for _, kept := range ids[2:] {
		if _, err := os.Stat(filepath.Join(logs, kept)); err != nil {
			t.Errorf("%s should have been kept: %v", kept, err)
		}
	}
	if _, err := os.Stat(filepath.Join(logs, "keep-this-analysis")); err != nil {
		t.Error("Prune deleted a directory that does not look like a run id")
	}
}

func TestPrune_ZeroDisablesPruningEntirely(t *testing.T) {
	logs := filepath.Join(t.TempDir(), "logs")
	id := "2026-08-19T10-00-00Z-aaaaaa"
	if err := os.MkdirAll(filepath.Join(logs, id), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Prune(logs, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(logs, id)); err != nil {
		t.Error("keepRuns: 0 must mean \"delete nothing\"")
	}
}

// TestOpen_JoinsTheRunNamedByTheEnvironment is the self-bootstrapping rule:
// a child process shares the parent's run directory rather than minting its
// own, which is what makes one directory hold every surface's artifacts.
func TestOpen_JoinsTheRunNamedByTheEnvironment(t *testing.T) {
	dir := t.TempDir()
	parent, err := Mint(result(t, dir), Selection{})
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Log.Close()

	t.Setenv(EnvRunDir, parent.Dir)
	t.Setenv(EnvRunID, parent.ID)
	t.Setenv(EnvStartedAt, parent.StartedAt.Format(time.RFC3339Nano))

	child, err := Open(result(t, dir), Selection{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer child.Log.Close()

	if child.Dir != parent.Dir {
		t.Errorf("the child minted its own run %s instead of joining %s", child.Dir, parent.Dir)
	}
	if !child.Joined {
		t.Error("a joined run must know it is joined; only the orchestrator writes the summary")
	}
	if !child.StartedAt.Equal(parent.StartedAt) {
		t.Error("the child did not adopt the run's start time; relative timings would not line up")
	}
}

func TestRecordResult_SurvivesAProcessThatNeverWritesASummary(t *testing.T) {
	dir := t.TempDir()
	r, err := Mint(result(t, dir), Selection{})
	if err != nil {
		t.Fatal(err)
	}
	r.RecordResult(TestResult{Address: "backend/smoke/TestA", Surface: "backend", Status: StatusPassed, DurationMS: 12})
	r.RecordResult(TestResult{Address: "backend/smoke/TestB", Surface: "backend", Status: StatusFailed, Reason: "boom"})
	r.Log.Close()

	// The file, not the process's memory, is the record. A shard killed by a
	// timeout still contributes everything that finished.
	got, err := LoadResults(r.Dir)
	if err != nil {
		t.Fatalf("LoadResults: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("loaded %d results, want 2", len(got))
	}

	summary, err := ReadSummary(r.Dir)
	if err != nil {
		t.Fatalf("the summary was not refreshed on each result: %v", err)
	}
	if summary.Totals.Passed != 1 || summary.Totals.Failed != 1 {
		t.Errorf("totals = %+v", summary.Totals)
	}
	if summary.Status != "FAILED" {
		t.Errorf("status = %q, want FAILED", summary.Status)
	}
}

func TestRecordResult_ARetriedPassCountsOnceAndIsListedUnderRetried(t *testing.T) {
	dir := t.TempDir()
	r, err := Mint(result(t, dir), Selection{})
	if err != nil {
		t.Fatal(err)
	}
	r.RecordResult(TestResult{Address: "backend/smoke/TestFlaky", Surface: "backend", Attempt: 1, Status: StatusFailed, Reason: "boom"})
	r.RecordResult(TestResult{Address: "backend/smoke/TestFlaky", Surface: "backend", Attempt: 2, Status: StatusPassed})
	r.Log.Close()

	summary, err := ReadSummary(r.Dir)
	if err != nil {
		t.Fatalf("ReadSummary: %v", err)
	}
	// The verdict is attempt 2's: one pass, not one pass plus one failure.
	if summary.Totals.Passed != 1 || summary.Totals.Failed != 0 {
		t.Fatalf("totals = %+v, want 1 passed and 0 failed -- a retried pass must count once, "+
			"as its final verdict, not once per attempt", summary.Totals)
	}
	if summary.Status != "PASSED" {
		t.Errorf("status = %q, want PASSED", summary.Status)
	}
	// But the retry itself must never be invisible.
	if len(summary.Retried) != 1 || summary.Retried[0].Address != "backend/smoke/TestFlaky" {
		t.Fatalf("Retried = %+v, want one record for backend/smoke/TestFlaky", summary.Retried)
	}
	if len(summary.Retried[0].Attempts) != 2 {
		t.Fatalf("Retried[0].Attempts = %+v, want both attempts kept", summary.Retried[0].Attempts)
	}

	md := RenderMarkdown(*summary, r.Dir)
	for _, want := range []string{"## Retried", "backend/smoke/TestFlaky", "attempt 1: failed", "attempt 2: passed"} {
		if !strings.Contains(md, want) {
			t.Errorf("summary.md does not contain %q -- a retry must be loudly visible, never silently green:\n%s", want, md)
		}
	}
}

func TestRecordCost_SumsAcrossSurfacesAndIsZeroWhenNothingWasRecorded(t *testing.T) {
	dir := t.TempDir()
	r, err := Mint(result(t, dir), Selection{})
	if err != nil {
		t.Fatal(err)
	}

	total, err := TotalCost(r.Dir)
	if err != nil {
		t.Fatalf("TotalCost on a run with no cost entries: %v", err)
	}
	if total != 0 {
		t.Fatalf("total = %v, want 0 before anything is recorded", total)
	}

	r.RecordCost("backend", 0.42)
	r.RecordCost("tui", 0.08)
	r.RecordCost("backend", 0) // a fake/replay-mode test: always zero, still recorded
	r.Log.Close()

	total, err = TotalCost(r.Dir)
	if err != nil {
		t.Fatalf("TotalCost: %v", err)
	}
	if total < 0.499 || total > 0.501 {
		t.Fatalf("total = %v, want ~0.50", total)
	}

	summary, err := ReadSummary(r.Dir)
	if err != nil {
		t.Fatalf("ReadSummary: %v", err)
	}
	if summary.TotalCostUSD < 0.499 || summary.TotalCostUSD > 0.501 {
		t.Errorf("summary.TotalCostUSD = %v, want ~0.50", summary.TotalCostUSD)
	}
}

func TestLoadResults_SkipsAPartialLineRatherThanLosingTheFile(t *testing.T) {
	dir := t.TempDir()
	r, err := Mint(result(t, dir), Selection{})
	if err != nil {
		t.Fatal(err)
	}
	r.RecordResult(TestResult{Address: "backend/smoke/TestA", Status: StatusPassed})
	r.Log.Close()

	// Simulate a process killed mid-write.
	f, err := os.OpenFile(filepath.Join(r.Dir, ResultsFile), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"address":"backend/smoke/TestB","stat`); err != nil {
		t.Fatal(err)
	}
	f.Close()

	got, err := LoadResults(r.Dir)
	if err != nil {
		t.Fatalf("a truncated line must not fail the load: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("loaded %d results, want the 1 complete one", len(got))
	}
}

func TestSlug_IsStableAndFilesystemSafe(t *testing.T) {
	cases := map[string]string{
		"backend/chat/TestStream_EmitsTextDeltas": "backend-chat-TestStream_EmitsTextDeltas",
		"ui/chat/streams tokens into the bubble":  "ui-chat-streams-tokens-into-the-bubble",
		"tui/chat/TestApproval/sub case":          "tui-chat-TestApproval-sub-case",
	}
	for address, want := range cases {
		if got := Slug(address); got != want {
			t.Errorf("Slug(%q) = %q, want %q", address, got, want)
		}
	}
	// Stability is what makes diffing two runs' artifact trees trivial.
	if Slug("backend/chat/TestX") != Slug("backend/chat/TestX") {
		t.Error("Slug is not deterministic")
	}
}

func TestRenderMarkdown_NamesArtifactsForEveryFailure(t *testing.T) {
	s := Summary{
		RunID:     "run-1",
		StartedAt: time.Now().UTC(),
		Status:    "FAILED",
		Totals:    Totals{Passed: 1, Failed: 1},
		BySurface: map[string]Totals{"backend": {Passed: 1, Failed: 1}},
		Tests: []TestResult{
			{Address: "backend/smoke/TestA", Surface: "backend", Status: StatusPassed},
			{Address: "backend/smoke/TestB", Surface: "backend", Status: StatusFailed,
				Reason: "expected 200, got 500", Artifacts: []string{"backend/x/server.stderr.log"}},
		},
		SkipReasons: map[string]string{"desktop": "cargo not found"},
	}
	out := RenderMarkdown(s, "/runs/run-1")

	// An agent reading summary.md must be able to investigate without
	// guessing where files went.
	for _, want := range []string{
		"FAILED", "backend/smoke/TestB", "expected 200, got 500",
		"/runs/run-1/backend/x/server.stderr.log",
		"amirotest report --run run-1 --timeline",
		"cargo not found",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("summary.md does not contain %q:\n%s", want, out)
		}
	}
}

func TestRenderMarkdown_FlagsASkipWithNoRecordedReason(t *testing.T) {
	out := RenderMarkdown(Summary{
		RunID:  "run-1",
		Totals: Totals{Skipped: 1},
		Tests:  []TestResult{{Address: "backend/smoke/TestA", Status: StatusSkipped}},
	}, "/runs/run-1")
	if !strings.Contains(out, "bug in whatever skipped it") {
		t.Errorf("a reasonless skip should be called out, not printed as ordinary:\n%s", out)
	}
}

func TestDedupe_KeepsEveryAttemptButOnlyTheLastWriteOfEach(t *testing.T) {
	in := []TestResult{
		{Address: "a", Attempt: 1, Status: StatusFailed},
		{Address: "a", Attempt: 2, Status: StatusPassed},
		{Address: "a", Attempt: 2, Status: StatusPassed, DurationMS: 99}, // a re-render racing an append
	}
	out := dedupe(in)
	if len(out) != 2 {
		t.Fatalf("dedupe kept %d, want 2 (both attempts, one copy each)", len(out))
	}
	if out[1].DurationMS != 99 {
		t.Error("the later write of the same attempt should win")
	}
}

func TestEnv_PropagatesFlagsAndOverrides(t *testing.T) {
	dir := t.TempDir()
	res := result(t, dir)
	res.Config.TUI.GoldenUpdate = true
	res.Config.Providers.Mode = "fake"
	res.Config.Run.StrictCassettes = true
	res.Config.Run.FailFast = true
	res.Config.Run.Parallel = 4
	res.Config.Run.KeepArtifacts = "on-failure"

	r, err := Mint(res, Selection{UpdateGolden: true})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Log.Close()

	env := r.Env()
	envMap := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		envMap[k] = v
	}

	if envMap["AMIRO_TEST_TUI_GOLDENUPDATE"] != "true" {
		t.Errorf("AMIRO_TEST_TUI_GOLDENUPDATE = %q, want true", envMap["AMIRO_TEST_TUI_GOLDENUPDATE"])
	}
	if envMap["AMIRO_TEST_PROVIDERS_MODE"] != "fake" {
		t.Errorf("AMIRO_TEST_PROVIDERS_MODE = %q, want fake", envMap["AMIRO_TEST_PROVIDERS_MODE"])
	}
	if envMap["AMIRO_TEST_RUN_STRICTCASSETTES"] != "true" {
		t.Errorf("AMIRO_TEST_RUN_STRICTCASSETTES = %q, want true", envMap["AMIRO_TEST_RUN_STRICTCASSETTES"])
	}
	if envMap["AMIRO_TEST_RUN_FAILFAST"] != "true" {
		t.Errorf("AMIRO_TEST_RUN_FAILFAST = %q, want true", envMap["AMIRO_TEST_RUN_FAILFAST"])
	}
	if envMap["AMIRO_TEST_RUN_PARALLEL"] != "4" {
		t.Errorf("AMIRO_TEST_RUN_PARALLEL = %q, want 4", envMap["AMIRO_TEST_RUN_PARALLEL"])
	}
	if envMap["AMIRO_TEST_RUN_KEEP_ARTIFACTS"] != "on-failure" {
		t.Errorf("AMIRO_TEST_RUN_KEEP_ARTIFACTS = %q, want on-failure", envMap["AMIRO_TEST_RUN_KEEP_ARTIFACTS"])
	}
}
