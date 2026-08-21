// Package harness is the single entry point every Go suite uses.
//
//	func TestListThreads_ReturnsOnlyTheCallersOwn(t *testing.T) {
//	    h := harness.New(t)
//	    alice := h.As("user")
//	    ...
//	}
//
// New(t) is the whole entry ceremony: it resolves config.yaml, joins or
// mints a run, honours the tag selection, provisions an isolated backend,
// seeds it, and registers every cleanup. It behaves identically whether it
// was invoked by `amirotest run` or by a bare `go test ./suites/backend/...`,
// which is what makes an editor's run-test gutter button work with zero
// setup -- and what gives an agent iterating on one failing test the full
// artifact trail without knowing the CLI exists.
package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/assert"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/cassette"
	"amiro/tests/harness/config"
	"amiro/tests/harness/fakeprovider"
	"amiro/tests/harness/logging"
	"amiro/tests/harness/pty"
	"amiro/tests/harness/run"
	"amiro/tests/harness/seed"
	"amiro/tests/harness/selector"
)

// The process-wide run. Resolved once: every test in a `go test` binary
// belongs to the same run and writes into the same directory.
var (
	processOnce sync.Once
	processRun  *run.Run
	processErr  error
)

// Harness is one test's world.
type Harness struct {
	T   *testing.T
	Ctx context.Context

	// Config is this test's resolved configuration, after any With()
	// overrides. It is a copy: an override in one test cannot leak into
	// another running in parallel.
	Config *config.Config
	Run    *run.Run
	Log    *logging.Logger

	Surface string
	Feature string
	Address string
	// TestID is the slugified address, and the directory name this test's
	// artifacts live under.
	TestID string

	BaseDir  string
	RepoRoot string

	opts    options
	started time.Time

	backendOnce sync.Once
	backend     *backend.Backend
	backendErr  error

	proxyOnce sync.Once
	proxy     *cassette.Proxy

	seedOnce  sync.Once
	seedState *seed.State
	seedErr   error

	ptyMu       sync.Mutex
	tuiSessions []*pty.Session

	// skipReason carries the message given to Skip, since t.Skip's own
	// message is not retrievable from testing.T afterwards -- finish()
	// needs it to record something other than "" when a test skips itself
	// partway through, after New() has already returned control.
	skipReason string

	// attempt is which try this is: 1 for a normal run, 2+ when
	// cmd/amirotest/run.go's orchestrator re-invokes just this test after a
	// failure, per run.retries. Read once from AMIRO_TEST_ATTEMPT so a
	// retried process's own result records which attempt it was, rather
	// than a bare pass that looks identical to one that never failed.
	attempt int
}

// New builds the harness for one test.
func New(t *testing.T, opts ...Option) *Harness {
	t.Helper()

	var o options
	for _, opt := range opts {
		opt(&o)
	}

	processOnce.Do(func() { processRun, processErr = openProcessRun() })
	if processErr != nil {
		// A configuration error means nothing was run, and every test in
		// the binary would report the same thing. Fatal on the first one is
		// the readable outcome.
		t.Fatalf("resolving the test configuration: %v", processErr)
	}

	surface, feature := o.surface, o.feature
	if surface == "" || feature == "" {
		derivedSurface, derivedFeature := deriveAddress()
		if surface == "" {
			surface = derivedSurface
		}
		if feature == "" {
			feature = derivedFeature
		}
	}
	address := surface + "/" + feature + "/" + t.Name()

	// A per-test copy, so With() cannot leak across parallel tests.
	cfg := processRun.Config.Config
	for _, override := range o.overrides {
		override(&cfg)
	}

	attempt := attemptFromEnv()
	testID := run.Slug(address)
	if attempt > 1 {
		// A retry gets its OWN artifact directory rather than overwriting
		// attempt 1's -- config.example.yaml's own doc for run.retries
		// promises "every attempt is kept as attempt-1/, attempt-2/, ...",
		// and a retry that silently clobbers the failing attempt's server
		// logs/PTY casts/http.ndjson is exactly the kind of race-hiding the
		// docs warn retries can become if done carelessly.
		testID = fmt.Sprintf("%s-attempt%d", testID, attempt)
	}

	h := &Harness{
		T:       t,
		Ctx:     context.Background(),
		Config:  &cfg,
		Run:     processRun,
		Log:     processRun.Log,
		Surface: surface,
		Feature: feature,
		Address: address,
		TestID:  testID,
		BaseDir: processRun.Config.BaseDir,
		opts:    o,
		started: time.Now(),
		attempt: attempt,
	}
	repoRoot, err := backend.FindRepoRoot(h.BaseDir)
	if err != nil {
		t.Fatalf("%v", err)
	}
	h.RepoRoot = repoRoot

	// Tag selection. Done before anything is provisioned: a test excluded
	// by tags should cost nothing.
	decision := selector.Decide(o.tags, selectionFor(&cfg))
	if !decision.Run {
		h.record(run.StatusSkipped, decision.Reason)
		t.Skip(decision.Reason)
	}

	h.Log.Emit(logging.Event{Surface: surface, Test: address, Kind: logging.KindTest, Msg: "started",
		Detail: map[string]any{"tags": o.tags, "id": h.TestID}})

	t.Cleanup(h.finish)
	return h
}

// attemptFromEnv reads run.EnvAttempt, defaulting to 1 (a normal, first
// try) for anything unset, empty, or not a positive integer -- a retry
// invocation is the only thing that ever sets it to 2 or more.
func attemptFromEnv() int {
	v := os.Getenv(run.EnvAttempt)
	if v == "" {
		return 1
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return 1
	}
	return n
}

// openProcessRun resolves config and joins or mints the run.
func openProcessRun() (*run.Run, error) {
	res, err := config.Load(config.LoadOptions{})
	if err != nil {
		return nil, err
	}
	return run.Open(res, selectionFor(&res.Config))
}

// PlantSkill creates a SKILL.md under baseDir/<source>/skills/<name>/SKILL.md.
// source is e.g. ".agents", ".amiro", ".claude", ".codex".
// baseDir is typically be.Home or be.WorkspaceRoot.
func (h *Harness) PlantSkill(baseDir, source, name, description, body string) string {
	h.T.Helper()
	dir := filepath.Join(baseDir, source, "skills", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		h.T.Fatalf("PlantSkill mkdir %s: %v", dir, err)
	}
	content := fmt.Sprintf("---\nname: %s\ndescription: %s\n---\n%s\n", name, description, body)
	filePath := filepath.Join(dir, "SKILL.md")
	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		h.T.Fatalf("PlantSkill write %s: %v", filePath, err)
	}
	return dir
}

func selectionFor(cfg *config.Config) selector.Selection {
	return selector.Selection{
		Surfaces:    cfg.Run.Surfaces,
		Features:    cfg.Run.Features,
		TagsInclude: cfg.Run.Tags.Include,
		TagsExclude: cfg.Run.Tags.Exclude,
		Browsers:    cfg.UI.Browsers,
	}
}

// deriveAddress reads the surface and feature off the calling test file's
// path: .../tests/suites/<surface>/<feature>/x_test.go.
//
// The directory path IS the address (docs/testing/03-selection.md). Nothing
// has to be declared, and nothing can fall out of sync with something that
// is derived.
func deriveAddress() (surface, feature string) {
	for depth := 2; depth < 12; depth++ {
		_, file, _, ok := runtime.Caller(depth)
		if !ok {
			break
		}
		if !strings.HasSuffix(file, "_test.go") {
			continue
		}
		dir := filepath.Dir(file)
		feature = filepath.Base(dir)
		parent := filepath.Base(filepath.Dir(dir))
		if parent == "suites" {
			// suites/meta/x_test.go -- the feature IS the surface there.
			return feature, feature
		}
		return parent, feature
	}
	return "backend", "unknown"
}

// finish records the outcome and tears everything down. Registered by New
// via t.Cleanup, so it runs whether the test passed, failed or panicked.
func (h *Harness) finish() {
	status := run.StatusPassed
	reason := ""
	if h.T.Failed() {
		status = run.StatusFailed
		reason = "see the test log; artifacts under " + h.Log.Path(filepath.Join(h.Surface, h.TestID))
	}
	if h.T.Skipped() {
		status = run.StatusSkipped
		if h.skipReason != "" {
			reason = h.skipReason
		}
	}

	h.ptyMu.Lock()
	for _, s := range h.tuiSessions {
		_ = s.Close()
	}
	h.ptyMu.Unlock()

	if h.backend != nil {
		// A teardown failure is a real failure: a leaked backend holding a
		// port breaks a later, unrelated test, and reporting it there
		// instead of here costs an hour of confusion.
		if err := h.backend.Stop(h.Ctx); err != nil {
			h.T.Errorf("backend teardown: %v", err)
			status = run.StatusFailed
			if reason != "" {
				reason += "\n"
			}
			reason += "teardown: " + err.Error()
		}
	}
	if h.proxy != nil {
		report := h.proxy.Cost().Report()
		costPath := filepath.Join(h.Dir(), "providers", "cost.json")
		_ = h.proxy.Cost().WriteJSON(costPath)
		h.proxy.Close()
		// Zero in fake/replay mode (CostTracker only accumulates for
		// live/record, see cassette/cost.go), so this is a no-op run-wide
		// unless real spend actually happened.
		h.Run.RecordCost(h.Surface, report.EstimatedCostUSD)
	}
	h.record(status, reason)
}

func (h *Harness) record(status, reason string) {
	h.Run.RecordResult(run.TestResult{
		Address:    h.Address,
		ID:         h.TestID,
		Surface:    h.Surface,
		Feature:    h.Feature,
		Name:       h.T.Name(),
		Status:     status,
		DurationMS: time.Since(h.started).Milliseconds(),
		Attempt:    h.attempt,
		Reason:     reason,
		Tags:       h.opts.tags,
		Artifacts:  h.artifacts(),
	})
	h.Log.Emit(logging.Event{Surface: h.Surface, Test: h.Address, Kind: logging.KindTest,
		Msg: status, Detail: map[string]any{"reason": reason}})
}

func (h *Harness) artifacts() []string {
	var out []string
	if h.backend != nil {
		base := filepath.ToSlash(filepath.Join("backend", h.TestID))
		out = append(out, base+"/server.stdout.log", base+"/server.stderr.log", base+"/http.ndjson")
	}
	h.ptyMu.Lock()
	hasPTY := len(h.tuiSessions) > 0 || h.Surface == "tui"
	h.ptyMu.Unlock()
	if hasPTY {
		base := filepath.ToSlash(filepath.Join(h.Surface, h.TestID))
		out = append(out, base+"/tui.stdout.log")
		if h.Config.TUI.RecordCasts {
			out = append(out, base+"/session.cast")
		}
		out = append(out, base+"/keys.ndjson")
		if _, err := os.Stat(filepath.Join(h.Dir(), "golden.diff")); err == nil {
			out = append(out, base+"/golden.diff")
		}
	}
	return out
}

// Proxy returns (and starts once) the cassette/fake provider proxy for this test.
func (h *Harness) Proxy() *cassette.Proxy {
	h.proxyOnce.Do(func() {
		cassetteDir := config.Resolve(h.BaseDir, h.Config.Providers.CassetteDir)
		h.proxy = cassette.NewProxy(cassette.ProxyOptions{
			Mode:              h.Config.Providers.Mode,
			StrictCassettes:   h.Config.Run.StrictCassettes,
			CassetteDir:       cassetteDir,
			PreferredCassette: h.opts.cassetteName,
			OnMiss: func(method, path string, body []byte) {
				h.Emit(logging.KindCassette, "miss", map[string]any{
					"method": method, "path": path, "degradedTo": "fake",
				})
			},
		})
		if h.opts.fakeConfig != nil {
			h.opts.fakeConfig(h.proxy.Fake())
		}
	})
	return h.proxy
}

// Fake returns the underlying scripted fakeprovider server.
func (h *Harness) Fake() *fakeprovider.Server {
	return h.Proxy().Fake()
}

// Backend starts (once) and returns this test's isolated server.
//
// Lazy so that a test needing only the config or the run directory pays
// nothing for one. Every caller after the first gets the same instance.
func (h *Harness) Backend() *backend.Backend {
	h.T.Helper()
	if h.opts.noBackend {
		h.T.Fatalf("harness.NoBackend() was set, but this test called Backend()")
	}
	h.backendOnce.Do(func() {
		h.backend, h.backendErr = backend.Start(h.Ctx, backend.Options{
			RepoRoot:  h.RepoRoot,
			BaseDir:   h.BaseDir,
			Config:    h.Config,
			Log:       h.Log,
			TestID:    h.TestID,
			Surface:   h.Surface,
			Address:   h.Address,
			BuildTags: h.opts.buildTags,
		})
	})
	if h.backendErr != nil {
		h.T.Fatalf("starting the backend: %v", h.backendErr)
	}
	return h.backend
}

// Client returns an unauthenticated API client against this test's backend.
func (h *Harness) Client() *apiclient.Client {
	h.T.Helper()
	be := h.Backend()
	return apiclient.New(apiclient.Options{
		BaseURL:      be.URL,
		Token:        be.Token,
		Log:          h.Log,
		NDJSONPath:   filepath.ToSlash(filepath.Join("backend", h.TestID, "http.ndjson")),
		Surface:      h.Surface,
		Address:      h.Address,
		LogBodies:    h.Config.Logging.HTTPBodies,
		MaxBodyBytes: h.Config.Logging.MaxBodyBytes,
	})
}

// Seeded applies the default seed (plus any Seeds() options) once and
// returns the resulting state.
//
// Called implicitly by As(). A test that opted out with NoSeed() and then
// calls this gets a clear failure rather than a surprise database.
func (h *Harness) Seeded() *seed.State {
	h.T.Helper()
	h.seedOnce.Do(func() {
		if h.opts.noSeed {
			h.seedErr = fmt.Errorf("harness.NoSeed() was set, so no accounts exist; register them in the test itself")
			return
		}
		proxyURL := h.Proxy().URL
		seeds := append([]seed.Seed{seed.Default}, h.opts.seeds...)
		h.seedState, h.seedErr = seed.ApplyWithProxy(h.Ctx, h.Client(), h.Config, proxyURL, seeds...)
	})
	if h.seedErr != nil {
		h.T.Fatalf("seeding: %v", h.seedErr)
	}
	return h.seedState
}

// As returns a client authenticated as one of the seeded identities:
// "admin", "user" or "other".
func (h *Harness) As(identity string) *apiclient.Client {
	h.T.Helper()
	state := h.Seeded()
	id := state.Identity(identity)
	if id == nil {
		h.T.Fatalf("no seeded identity %q (have: admin, user, other)", identity)
	}
	return id.Client()
}

// Identity returns the seeded account record -- id, email, role, token.
func (h *Harness) Identity(key string) *seed.Identity {
	h.T.Helper()
	id := h.Seeded().Identity(key)
	if id == nil {
		h.T.Fatalf("no seeded identity %q", key)
	}
	return id
}

// Dir is this test's artifact directory inside the run tree. Anything a
// test writes belongs here and nowhere else.
func (h *Harness) Dir() string {
	return h.Log.Path(filepath.Join(h.Surface, h.TestID))
}

// RunDir is the whole run's directory.
func (h *Harness) RunDir() string { return h.Run.Dir }

// Skip marks this test skipped with an explicit, recorded reason and then
// calls t.Skip.
//
// Anything that decides not to run partway through a test -- after New()
// has already returned control, unlike a tag exclusion New() itself
// decides -- must go through this rather than a bare t.Skip. Go's
// testing.T does not expose the message a skip was given, so a bare
// t.Skip after New() has returned would have finish() record a skip with
// no reason -- which the summary then reports as "no reason recorded --
// this is a bug in whatever skipped it", correctly, since an unrecorded
// skip reason is exactly that: a suite that can go quietly green while
// running nothing is the one failure mode this harness exists to prevent.
func (h *Harness) Skip(reason string) {
	h.T.Helper()
	h.skipReason = reason
	h.T.Skip(reason)
}

// Emit puts a line on the merged timeline from inside a test.
func (h *Harness) Emit(kind, msg string, detail map[string]any) {
	h.Log.Emit(logging.Event{Surface: h.Surface, Test: h.Address, Kind: kind, Msg: msg, Detail: detail})
}

// TUIBinary builds or locates the amiro binary.
func (h *Harness) TUIBinary() string {
	h.T.Helper()
	bin, err := backend.Build(h.Ctx, h.Log, backend.BuildSpec{
		RepoRoot: h.RepoRoot,
		Package:  "./cmd/amiro",
		Name:     "amiro",
		Tags:     h.opts.buildTags,
		Override: h.Config.TUI.Binary,
	})
	if err != nil {
		h.T.Fatalf("building amiro binary: %v", err)
	}
	return bin
}

// PTYSessionOption configures a PTY session.
type PTYSessionOption func(*ptySessionOptions)

type ptySessionOptions struct {
	args       []string
	env        []string
	dir        string
	appDataDir string
	home       string
	width      int
	height     int
	term       string
}

func PTYArgs(args ...string) PTYSessionOption {
	return func(o *ptySessionOptions) { o.args = append(o.args, args...) }
}

func PTYEnv(env ...string) PTYSessionOption {
	return func(o *ptySessionOptions) { o.env = append(o.env, env...) }
}

func PTYDir(dir string) PTYSessionOption {
	return func(o *ptySessionOptions) { o.dir = dir }
}

func PTYAppDataDir(dir string) PTYSessionOption {
	return func(o *ptySessionOptions) { o.appDataDir = dir }
}

func PTYHome(home string) PTYSessionOption {
	return func(o *ptySessionOptions) { o.home = home }
}

func PTYDims(w, h int) PTYSessionOption {
	return func(o *ptySessionOptions) { o.width = w; o.height = h }
}

// PTY starts a child amiro process in a PTY with test isolation.
func (h *Harness) PTY(opts ...PTYSessionOption) *pty.Session {
	h.T.Helper()
	var o ptySessionOptions
	for _, opt := range opts {
		opt(&o)
	}

	appDataDir := o.appDataDir
	if appDataDir == "" {
		appDataDir = filepath.Join(h.Dir(), "appdata")
		_ = os.MkdirAll(appDataDir, 0o755)
	}
	workspaceRoot := o.dir
	if workspaceRoot == "" {
		workspaceRoot = filepath.Join(h.Dir(), "workspace")
		_ = os.MkdirAll(workspaceRoot, 0o755)
	}
	home := o.home
	if home == "" {
		home = filepath.Join(h.Dir(), "home")
		_ = os.MkdirAll(home, 0o755)
	}

	paths := backend.Paths{
		AppDataDir:    appDataDir,
		WorkspaceRoot: workspaceRoot,
		Home:          home,
		DatabaseDSN:   filepath.Join(h.Dir(), "db", "amiro.db"),
	}
	_ = os.MkdirAll(filepath.Join(h.Dir(), "db"), 0o755)

	keysFile := filepath.Join(appDataDir, "keys.json")
	keysMap := make(map[string]string)
	if data, err := os.ReadFile(keysFile); err == nil {
		_ = json.Unmarshal(data, &keysMap)
	}
	keysMap["openai"] = "fake-openai-key"
	keysMap["anthropic"] = "fake-anthropic-key"

	token := ""
	if h.seedState != nil {
		if id := h.seedState.Identity("admin"); id != nil {
			token = id.Token
		}
	} else if h.backend != nil {
		state := h.Seeded()
		if id := state.Identity("admin"); id != nil {
			token = id.Token
		}
	}
	if token != "" {
		keysMap["amiro:session"] = token
	}
	if len(keysMap) > 0 {
		data, _ := json.Marshal(keysMap)
		_ = os.WriteFile(keysFile, data, 0o600)
	}

	env := backend.Env(h.Config, paths, "test-tui-token")
	env = append(env, o.env...)

	width := o.width
	if width <= 0 {
		width = h.Config.TUI.Terminal.Width
	}
	height := o.height
	if height <= 0 {
		height = h.Config.TUI.Terminal.Height
	}
	term := o.term
	if term == "" {
		term = h.Config.TUI.Terminal.Term
	}

	sess, err := pty.Start(h.Ctx, h.Log, pty.Options{
		Name:        "tui",
		Binary:      h.TUIBinary(),
		Args:        o.args,
		Dir:         workspaceRoot,
		Env:         env,
		Width:       width,
		Height:      height,
		Term:        term,
		RecordCasts: h.Config.TUI.RecordCasts,
		LogDir:      filepath.ToSlash(filepath.Join(h.Surface, h.TestID)),
		Surface:     h.Surface,
		Test:        h.Address,
	})
	if err != nil {
		h.T.Fatalf("starting TUI under PTY: %v", err)
	}

	h.ptyMu.Lock()
	h.tuiSessions = append(h.tuiSessions, sess)
	h.ptyMu.Unlock()

	return sess
}

// GoldenScreen compares a terminal screen against testdata/<name>.golden.
func (h *Harness) GoldenScreen(name, frame string) {
	h.T.Helper()
	assert.GoldenScreen(h.T, h.Dir(), name, frame, h.Config.TUI.GoldenUpdate)
}
