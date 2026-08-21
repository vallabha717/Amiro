package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"amiro/tests/harness/apiclient"
	"amiro/tests/harness/backend"
	"amiro/tests/harness/logging"
	"amiro/tests/harness/process"
	"amiro/tests/harness/run"
	"amiro/tests/harness/seed"
)

type backendRecord struct {
	PID             int       `json:"pid"`
	Port            int       `json:"port"`
	TestID          string    `json:"testId"`
	AppDataDir      string    `json:"appDataDir"`
	Workspace       string    `json:"workspace"`
	DBDSN           string    `json:"dbDsn"`
	StartedAt       time.Time `json:"startedAt"`
	FakeProviderPID int       `json:"fakeProviderPid,omitempty"`
}

// startFakeProvider spawns a detached fakeprovider process (see
// cmdInternalFakeProvider) and waits for its URL= handoff line, mirroring
// the PORT= handoff cmd/server itself uses.
func startFakeProvider(ctx context.Context, log *logging.Logger, testID, surface, reply string) (*process.Process, string, error) {
	self, err := os.Executable()
	if err != nil {
		return nil, "", fmt.Errorf("locating amirotest's own executable to spawn the fake provider: %w", err)
	}

	fpArgs := []string{"internal-fakeprovider"}
	if reply != "" {
		fpArgs = append(fpArgs, "--reply", reply)
	}

	p, err := process.Start(log, process.Spec{
		Name:    "fakeprovider",
		Path:    self,
		Args:    fpArgs,
		Env:     process.InheritSafe(),
		LogDir:  filepath.Join(surface, testID),
		Surface: surface,
		Test:    surface + "/backend/" + testID + "/fakeprovider",
	})
	if err != nil {
		return nil, "", err
	}

	line, err := p.WaitForLine(ctx, "URL=", 10*time.Second)
	if err != nil {
		_ = p.Stop(ctx)
		return nil, "", fmt.Errorf("waiting for the fake provider's URL=: %w", err)
	}
	return p, line, nil
}

var backendRegistryMu sync.Mutex

func cmdBackend(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "amirotest backend: expected 'start' or 'stop'")
		return exitConfig
	}

	sub, rest := args[0], args[1:]
	switch sub {
	case "start":
		return cmdBackendStart(rest)
	case "stop":
		return cmdBackendStop(rest)
	case "sweep":
		return cmdBackendSweep(rest)
	default:
		fmt.Fprintf(os.Stderr, "amirotest backend: unknown action %q (expected 'start', 'stop', or 'sweep')\n", sub)
		return exitConfig
	}
}

func cmdBackendStart(args []string) int {
	fs := flag.NewFlagSet("backend start", flag.ContinueOnError)
	var common commonFlags
	common.register(fs)
	asJSON := fs.Bool("json", false, "output backend details as JSON")
	testID := fs.String("test-id", "", "unique test identifier for isolation")
	surface := fs.String("surface", "ui", "target surface")
	noSeed := fs.Bool("no-seed", false, "skip default seeding")
	tags := fs.String("tags", "", "comma-separated build tags (defaults to 'embedui' for ui surface)")
	fake := fs.Bool("fake", true, "seed a detached fake LLM provider so chat turns get a real "+
		"assistant reply instead of erroring with no keys configured (matches harness.Fake() for Go suites)")
	fakeReply := fs.String("fake-reply", "", "canned assistant reply text; empty uses the fake provider's own default")

	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	res, code := loadConfig(common)
	if code != exitOK {
		return code
	}

	var r *run.Run
	var err error
	if dir := os.Getenv(run.EnvRunDir); dir != "" {
		r, err = run.Open(res, run.Selection{})
	} else {
		r, err = run.Mint(res, run.Selection{})
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest backend start: %v\n", err)
		return exitInfra
	}
	defer r.Log.Close()

	id := *testID
	if id == "" {
		suffix, _ := randomHex(4)
		id = fmt.Sprintf("test-%s-%s", time.Now().Format("150405"), suffix)
	}

	repoRoot, err := backend.FindRepoRoot(res.BaseDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest backend start: finding repo root: %v\n", err)
		return exitInfra
	}

	var buildTags []string
	if *tags != "" {
		buildTags = strings.Split(*tags, ",")
	} else if *surface == "ui" {
		buildTags = []string{"embedui"}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	b, err := backend.Start(ctx, backend.Options{
		RepoRoot:  repoRoot,
		BaseDir:   res.BaseDir,
		Config:    &res.Config,
		Log:       r.Log,
		TestID:    id,
		Surface:   *surface,
		Address:   *surface + "/backend/" + id,
		BuildTags: buildTags,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "amirotest backend start: failed to start backend: %v\n", err)
		return exitInfra
	}

	client := apiclient.New(apiclient.Options{
		BaseURL:      b.URL,
		Token:        b.Token,
		Log:          r.Log,
		NDJSONPath:   filepath.ToSlash(filepath.Join("backend", id, "http.ndjson")),
		Surface:      *surface,
		Address:      *surface + "/backend/" + id,
		LogBodies:    res.Config.Logging.HTTPBodies,
		MaxBodyBytes: res.Config.Logging.MaxBodyBytes,
	})

	var fakeProviderPID int
	var proxyURL string
	if *fake && !*noSeed {
		fpProc, url, err := startFakeProvider(ctx, r.Log, id, *surface, *fakeReply)
		if err != nil {
			_ = b.Stop(ctx)
			fmt.Fprintf(os.Stderr, "amirotest backend start: starting fake provider: %v\n", err)
			return exitInfra
		}
		fakeProviderPID = fpProc.Pid()
		proxyURL = url
	}

	accountsOut := map[string]map[string]any{}
	if !*noSeed {
		state, err := seed.ApplyWithProxy(ctx, client, &res.Config, proxyURL, seed.Default)
		if err != nil {
			_ = b.Stop(ctx)
			fmt.Fprintf(os.Stderr, "amirotest backend start: seeding failed: %v\n", err)
			return exitInfra
		}
		for key, idt := range state.Accounts {
			accountsOut[key] = map[string]any{
				"id":       idt.UserID,
				"name":     idt.Name,
				"email":    idt.Email,
				"password": idt.Password,
				"token":    idt.Token,
				"role":     idt.Role,
			}
		}
	}

	// Register in backends.json for crash-resilient cleanup
	record := backendRecord{
		PID:             b.Process().Pid(),
		Port:            b.Port,
		TestID:          id,
		AppDataDir:      b.AppDataDir,
		Workspace:       b.WorkspaceRoot,
		DBDSN:           b.DB.DSN,
		StartedAt:       time.Now().UTC(),
		FakeProviderPID: fakeProviderPID,
	}
	_ = registerRunningBackend(r.Dir, record)

	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return encodeOrFail(enc, map[string]any{
			"baseUrl":         b.URL,
			"port":            b.Port,
			"token":           b.Token,
			"pid":             b.Process().Pid(),
			"appDataDir":      b.AppDataDir,
			"home":            b.Home,
			"workspace":       b.WorkspaceRoot,
			"dbDsn":           b.DB.DSN,
			"testId":          id,
			"runDir":          r.Dir,
			"runId":           r.ID,
			"accounts":        accountsOut,
			"fakeProviderPid": fakeProviderPID,
		})
	}

	fmt.Printf("URL=%s PORT=%d PID=%d TOKEN=%s TEST_ID=%s\n", b.URL, b.Port, b.Process().Pid(), b.Token, id)
	return exitOK
}

func cmdBackendStop(args []string) int {
	fs := flag.NewFlagSet("backend stop", flag.ContinueOnError)
	pid := fs.Int("pid", 0, "process PID to stop")
	runDir := fs.String("run-dir", "", "run directory containing backends.json")
	if err := fs.Parse(args); err != nil || *pid <= 0 {
		fmt.Fprintln(os.Stderr, "amirotest backend stop: --pid <PID> is required")
		return exitConfig
	}

	dir := *runDir
	if dir == "" {
		dir = os.Getenv(run.EnvRunDir)
	}

	rec, _ := lookupRunningBackend(dir, *pid)

	// Attempt graceful shutdown
	p, err := os.FindProcess(*pid)
	if err == nil {
		_ = p.Signal(syscall.SIGTERM)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = process.WaitFor(ctx, fmt.Sprintf("process %d to terminate", *pid), 2*time.Second, func() error {
			if err := p.Signal(syscall.Signal(0)); err != nil {
				return nil
			}
			return fmt.Errorf("still running")
		})
		_ = p.Kill()
	}

	if rec != nil && rec.Port > 0 {
		_ = process.AssertPortFree("127.0.0.1", rec.Port, 3*time.Second)
	}

	if rec != nil && rec.FakeProviderPID > 0 {
		stopFakeProvider(rec.FakeProviderPID)
	}

	_ = unregisterRunningBackend(dir, *pid)
	return exitOK
}

// stopFakeProvider sends SIGTERM then SIGKILL to a detached fake-provider
// process by PID, best-effort -- there is no port or health check to wait
// on, just a process that should stop existing.
func stopFakeProvider(pid int) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = p.Signal(syscall.SIGTERM)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = process.WaitFor(ctx, fmt.Sprintf("fake provider %d to terminate", pid), 2*time.Second, func() error {
		if err := p.Signal(syscall.Signal(0)); err != nil {
			return nil
		}
		return fmt.Errorf("still running")
	})
	_ = p.Kill()
}

func cmdBackendSweep(args []string) int {
	fs := flag.NewFlagSet("backend sweep", flag.ContinueOnError)
	runDir := fs.String("run-dir", "", "run directory containing backends.json")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	dir := *runDir
	if dir == "" {
		dir = os.Getenv(run.EnvRunDir)
	}
	if dir == "" {
		return exitOK
	}

	records := loadAllRunningBackends(dir)
	for _, rec := range records {
		if p, err := os.FindProcess(rec.PID); err == nil {
			if err := p.Signal(syscall.Signal(0)); err == nil {
				_ = p.Signal(syscall.SIGTERM)
				_ = p.Kill()
			}
		}
		if rec.FakeProviderPID > 0 {
			stopFakeProvider(rec.FakeProviderPID)
		}
	}
	_ = os.Remove(filepath.Join(dir, "backends.json"))
	return exitOK
}

func backendsRegistryPath(runDir string) string {
	if runDir == "" {
		return ""
	}
	return filepath.Join(runDir, "backends.json")
}

func registerRunningBackend(runDir string, rec backendRecord) error {
	path := backendsRegistryPath(runDir)
	if path == "" {
		return nil
	}
	backendRegistryMu.Lock()
	defer backendRegistryMu.Unlock()

	records := loadAllRunningBackends(runDir)
	records = append(records, rec)
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func lookupRunningBackend(runDir string, pid int) (*backendRecord, error) {
	records := loadAllRunningBackends(runDir)
	for _, r := range records {
		if r.PID == pid {
			return &r, nil
		}
	}
	return nil, nil
}

func unregisterRunningBackend(runDir string, pid int) error {
	path := backendsRegistryPath(runDir)
	if path == "" {
		return nil
	}
	backendRegistryMu.Lock()
	defer backendRegistryMu.Unlock()

	records := loadAllRunningBackends(runDir)
	var remaining []backendRecord
	for _, r := range records {
		if r.PID != pid {
			remaining = append(remaining, r)
		}
	}
	data, err := json.MarshalIndent(remaining, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func loadAllRunningBackends(runDir string) []backendRecord {
	path := backendsRegistryPath(runDir)
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var records []backendRecord
	_ = json.Unmarshal(data, &records)
	return records
}

func randomHex(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
