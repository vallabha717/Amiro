// Package run owns the run directory: minting its id, creating its tree,
// writing run.json before anything is spawned, keeping logs/latest pointing
// at it, and pruning older runs.
//
// One run directory holds everything every surface produced. A run is
// either MINTED (this process is the orchestrator) or JOINED (this process
// was handed AMIRO_TEST_RUN_DIR by one). Both produce the same tree, which
// is what lets a bare `go test ./suites/backend/smoke` leave the same
// artifact trail as a full `amirotest run`.
package run

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"amiro/tests/harness/config"
	"amiro/tests/harness/logging"
	"amiro/tests/harness/selector"
)

// Selection is re-exported so that run.json's schema and the selector agree
// by construction rather than by a struct copied between them.
type Selection = selector.Selection

// Environment variables that carry a run across a process boundary.
//
// EnvRunID doubles as the config override for run.id, which is not a
// collision but the same fact stated once: the id of the run this process
// belongs to.
const (
	EnvRunDir    = "AMIRO_TEST_RUN_DIR"
	EnvRunID     = "AMIRO_TEST_RUN_ID"
	EnvStartedAt = "AMIRO_TEST_RUN_STARTED_AT"
	EnvBaseURL   = "AMIRO_TEST_BASE_URL"
	EnvSurface   = "AMIRO_TEST_SURFACE"
	// EnvSelection carries the resolved selection to child runners as JSON,
	// so a `go test` shard's summary can state what the whole run was asked
	// to do rather than reporting "everything".
	EnvSelection = "AMIRO_TEST_SELECTION"
	// EnvAttempt is which try a `go test` process is: unset or "1" for a
	// normal run, "2"+ when the orchestrator (cmd/amirotest/run.go) has
	// re-invoked it targeting only tests that failed on a previous
	// attempt, per run.retries. harness.Harness reads it once in New() and
	// records it on every TestResult, so a retried pass is never
	// indistinguishable from one that never failed -- see summary.go's
	// Retried section.
	EnvAttempt   = "AMIRO_TEST_ATTEMPT"
	ManifestName = "run.json"
	SummaryJSON  = "summary.json"
	SummaryMD    = "summary.md"
	LatestLink   = "latest"
)

// Run is one test run's identity and its directory.
type Run struct {
	ID        string
	Dir       string
	StartedAt time.Time
	// Joined is true when this process attached to a run another process
	// minted. A joined run never prunes, never rewrites run.json, and never
	// moves the `latest` symlink -- the orchestrator owns those.
	Joined bool

	Config *config.Result
	Log    *logging.Logger

	// Selection is what this run was asked to execute. Carried so the
	// summary can state it: "3 passed" means something different when the
	// selection was one feature than when it was everything.
	Selection Selection

	results *Results
}

// Open returns the run this process belongs to: joining one if the
// environment names it, minting one otherwise.
//
// This is the whole of the self-bootstrapping rule from
// docs/testing/03-selection.md, and it lives in one function so that
// harness.New and cmd/amirotest cannot drift on it.
func Open(cfg *config.Result, selection Selection) (*Run, error) {
	if dir := os.Getenv(EnvRunDir); dir != "" {
		return join(cfg, dir)
	}
	return Mint(cfg, selection)
}

func join(cfg *config.Result, dir string) (*Run, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(abs); err != nil {
		return nil, fmt.Errorf("%s names %s, which does not exist", EnvRunDir, abs)
	}
	id := os.Getenv(EnvRunID)
	if id == "" {
		id = filepath.Base(abs)
	}
	started := time.Now().UTC()
	if raw := os.Getenv(EnvStartedAt); raw != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			started = parsed
		}
	}
	log, err := logging.New(abs, id, started, logging.ParseLevel(cfg.Config.Logging.Level), logging.NewRedactor(&cfg.Config))
	if err != nil {
		return nil, err
	}
	sel := Selection{}
	if raw := os.Getenv(EnvSelection); raw != "" {
		_ = json.Unmarshal([]byte(raw), &sel)
	}
	return &Run{ID: id, Dir: abs, StartedAt: started, Joined: true, Config: cfg, Log: log,
		Selection: sel, results: NewResults()}, nil
}

// Mint creates a fresh run directory, prunes old ones, points `latest` at
// it, and writes run.json.
//
// run.json is written HERE, before a single process is spawned. A run that
// dies during startup is then still diagnosable, which is not true of a
// manifest written at the end.
func Mint(cfg *config.Result, selection Selection) (*Run, error) {
	started := time.Now().UTC()
	id := cfg.Config.Run.ID
	if id == "" {
		suffix, err := randomSuffix()
		if err != nil {
			return nil, err
		}
		id = started.Format("2006-01-02T15-04-05Z") + "-" + suffix
	}

	logsDir := config.Resolve(cfg.BaseDir, cfg.Config.Logging.Dir)
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating %s: %w", logsDir, err)
	}
	// Pruning happens before the new directory exists so the new run is
	// never a candidate for its own pruning, whatever keepRuns is set to.
	if err := Prune(logsDir, cfg.Config.Logging.KeepRuns); err != nil {
		return nil, err
	}

	dir := filepath.Join(logsDir, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("creating run directory %s: %w", dir, err)
	}
	if err := linkLatest(logsDir, id); err != nil {
		// A filesystem without symlinks (or a Windows account without the
		// privilege) is a reason to lose a convenience, not a run.
		_ = err
	}

	log, err := logging.New(dir, id, started, logging.ParseLevel(cfg.Config.Logging.Level), logging.NewRedactor(&cfg.Config))
	if err != nil {
		return nil, err
	}

	r := &Run{ID: id, Dir: dir, StartedAt: started, Config: cfg, Log: log,
		Selection: selection, results: NewResults()}
	if err := r.WriteManifest(selection); err != nil {
		return nil, err
	}
	log.Emit(logging.Event{Surface: "run", Kind: logging.KindRun, Msg: "started", Detail: map[string]any{
		"runId":     id,
		"dir":       dir,
		"selection": selection.String(),
		"providers": cfg.Config.Providers.Mode,
	}})
	for _, w := range cfg.Warnings {
		log.Emit(logging.Event{Surface: "run", Kind: logging.KindConfig, Msg: "warning", Detail: map[string]any{
			"key": w.Key, "message": w.Message,
		}})
	}
	return r, nil
}

// Results is the accumulating result set. Exposed so suites can record into
// the same object the summary is rendered from.
func (r *Run) Results() *Results { return r.results }

// Env returns the variables a child process needs to join this run.
func (r *Run) Env() []string {
	env := []string{
		EnvRunDir + "=" + r.Dir,
		EnvRunID + "=" + r.ID,
		EnvStartedAt + "=" + r.StartedAt.Format(time.RFC3339Nano),
	}
	if raw, err := json.Marshal(r.Selection); err == nil {
		env = append(env, EnvSelection+"="+string(raw))
	}
	if r.Config != nil {
		if r.Config.Config.TUI.GoldenUpdate {
			env = append(env, "AMIRO_TEST_TUI_GOLDENUPDATE=true")
		}
		if r.Config.Config.Providers.Mode != "" {
			env = append(env, "AMIRO_TEST_PROVIDERS_MODE="+r.Config.Config.Providers.Mode)
		}
		if r.Config.Config.Run.StrictCassettes {
			env = append(env, "AMIRO_TEST_RUN_STRICTCASSETTES=true")
		}
		if r.Config.Config.Run.FailFast {
			env = append(env, "AMIRO_TEST_RUN_FAILFAST=true")
		}
		if r.Config.Config.Run.Parallel > 0 {
			env = append(env, fmt.Sprintf("AMIRO_TEST_RUN_PARALLEL=%d", r.Config.Config.Run.Parallel))
		}
		if r.Config.Config.Run.KeepArtifacts != "" {
			env = append(env, "AMIRO_TEST_RUN_KEEP_ARTIFACTS="+r.Config.Config.Run.KeepArtifacts)
		}
	}
	return env
}

// Close writes the summary and closes the log. A joined run writes nothing
// -- the orchestrator renders the summary once, over every process's
// results, rather than each shard overwriting the last.
func (r *Run) Close() error {
	defer r.Log.Close()
	if r.Joined {
		return nil
	}
	return r.WriteSummary()
}

func randomSuffix() (string, error) {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// linkLatest repoints logs/latest. Replaced rather than updated in place,
// because a symlink cannot be atomically retargeted and a stale link is
// worse than a missing one.
func linkLatest(logsDir, id string) error {
	link := filepath.Join(logsDir, LatestLink)
	if err := os.Remove(link); err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.Symlink(id, link)
}

// Prune deletes run directories beyond the newest keep. keep <= 0 disables
// pruning entirely.
func Prune(logsDir string, keep int) error {
	if keep <= 0 {
		return nil
	}
	entries, err := os.ReadDir(logsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var runs []string
	for _, e := range entries {
		if !e.IsDir() || e.Name() == LatestLink {
			continue
		}
		// Only directories that look like run ids are candidates. Anything
		// else in logs/ was put there by a person and is not ours to delete.
		if !looksLikeRunID(e.Name()) {
			continue
		}
		runs = append(runs, e.Name())
	}
	// Run ids sort lexicographically into chronological order by
	// construction -- that is why the timestamp leads and uses a fixed
	// width, rather than being appended to a random word.
	sort.Strings(runs)
	if len(runs) <= keep {
		return nil
	}
	for _, name := range runs[:len(runs)-keep] {
		if err := os.RemoveAll(filepath.Join(logsDir, name)); err != nil {
			return fmt.Errorf("pruning %s: %w", name, err)
		}
	}
	return nil
}

func looksLikeRunID(name string) bool {
	// 2026-08-19T14-32-05Z-a1b2c3
	if len(name) < len("2006-01-02T15-04-05Z") {
		return false
	}
	_, err := time.Parse("2006-01-02T15-04-05Z", name[:len("2006-01-02T15-04-05Z")])
	return err == nil
}

// Manifest is run.json: everything needed to interpret this run later,
// without re-reading config.yaml (which may have changed since).
type Manifest struct {
	ID         string    `json:"id"`
	StartedAt  time.Time `json:"startedAt"`
	Selection  Selection `json:"selection"`
	Host       Host      `json:"host"`
	Git        Git       `json:"git"`
	Tools      []Tool    `json:"tools"`
	ConfigFrom []string  `json:"configFrom"`

	EnvApplied       []string         `json:"envApplied,omitempty"`
	DroppedProviders []string         `json:"droppedProviders,omitempty"`
	MissingVars      []string         `json:"missingVars,omitempty"`
	Warnings         []config.Problem `json:"warnings,omitempty"`

	// Config is redacted: every secret is a fingerprint. run.json is the
	// answer to "what was this run configured with?", and it must be safe
	// to paste into an issue.
	Config config.Config `json:"config"`
}

type Host struct {
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	NumCPU  int    `json:"numCpu"`
	Version string `json:"goVersion"`
}

type Git struct {
	SHA    string `json:"sha,omitempty"`
	Branch string `json:"branch,omitempty"`
	Dirty  bool   `json:"dirty"`
}

type Tool struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	Path    string `json:"path,omitempty"`
	Found   bool   `json:"found"`
}

// WriteManifest renders run.json.
func (r *Run) WriteManifest(selection Selection) error {
	m := Manifest{
		ID:        r.ID,
		StartedAt: r.StartedAt,
		Selection: selection,
		Host: Host{
			OS:      runtime.GOOS,
			Arch:    runtime.GOARCH,
			NumCPU:  runtime.NumCPU(),
			Version: runtime.Version(),
		},
		Git:              gitState(r.Config.BaseDir),
		Tools:            DetectTools(),
		ConfigFrom:       r.Config.Sources,
		EnvApplied:       r.Config.EnvApplied,
		DroppedProviders: r.Config.DroppedProviders,
		MissingVars:      r.Config.MissingVars,
		Warnings:         r.Config.Warnings,
		Config:           r.Config.Config.Redacted(),
	}
	return r.Log.WriteJSON(ManifestName, m)
}

// ReadManifest loads run.json from a run directory, for `amirotest report`
// and for the Playwright side, which reads it rather than re-resolving the
// configuration in TypeScript.
func ReadManifest(dir string) (*Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Join(dir, ManifestName), err)
	}
	return &m, nil
}

func gitState(dir string) Git {
	var g Git
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	g.SHA = run("rev-parse", "HEAD")
	g.Branch = run("rev-parse", "--abbrev-ref", "HEAD")
	g.Dirty = run("status", "--porcelain") != ""
	return g
}

// DetectTools reports the toolchain state. This is what `amirotest doctor`
// prints and what run.json records, so a run that skipped the desktop
// surface says why in a file rather than only on a terminal that scrolled.
//
// Cached: five subprocesses is a measurable cost when a `go test` binary
// mints several runs, and a toolchain does not change under a running
// process.
func DetectTools() []Tool {
	toolsOnce.Do(func() { detectedTools = detectTools() })
	return append([]Tool(nil), detectedTools...)
}

var (
	toolsOnce     sync.Once
	detectedTools []Tool
)

func detectTools() []Tool {
	specs := []struct {
		name string
		args []string
	}{
		{"go", []string{"version"}},
		{"node", []string{"--version"}},
		{"pnpm", []string{"--version"}},
		{"cargo", []string{"--version"}},
		{"git", []string{"--version"}},
	}
	tools := make([]Tool, 0, len(specs))
	for _, s := range specs {
		t := Tool{Name: s.name}
		path, err := exec.LookPath(s.name)
		if err != nil {
			tools = append(tools, t)
			continue
		}
		t.Found = true
		t.Path = path
		if out, err := exec.Command(path, s.args...).Output(); err == nil {
			t.Version = firstLine(string(out))
		}
		tools = append(tools, t)
	}
	return tools
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}
