package backend

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"amiro/tests/harness/config"
	"amiro/tests/harness/logging"
	"amiro/tests/harness/process"
)

// TokenHeader is the shared secret's header name. The legacy spelling is
// still accepted by the server and is sent alongside, because the suite
// tests the server as shipped rather than as it would ideally be.
const (
	TokenHeader       = "X-Amiro-Token"
	LegacyTokenHeader = "X-BetterChatbot-Token"
)

// Options describe one backend instance.
type Options struct {
	// RepoRoot holds backend-go/; BaseDir is tests/.
	RepoRoot string
	BaseDir  string
	Config   *config.Config
	Log      *logging.Logger

	// TestID is the artifact directory name (the slugified address);
	// Address is the full surface/feature/name.
	TestID  string
	Surface string
	Address string

	// BuildTags are passed through to `go build`. The UI surface needs
	// "embedui"; the backend surface does not.
	BuildTags []string
}

// Backend is a running server, isolated to one test.
type Backend struct {
	URL   string
	Port  int
	Token string

	AppDataDir    string
	WorkspaceRoot string
	Home          string
	Dir           string
	DB            *Database

	proc *process.Process
	log  *logging.Logger
	opts Options
	http *http.Client
}

// Start provisions everything one test needs and spawns the server:
// a fresh app-data directory, a fresh database, a copied workspace, a temp
// HOME, a fresh auth token, and an OS-assigned port.
//
// It returns only once /health has answered 200. "Started" and "ready" are
// separate facts and this function does not return between them.
func Start(ctx context.Context, opts Options) (*Backend, error) {
	if opts.Log == nil {
		return nil, fmt.Errorf("backend.Start: a logger is required")
	}
	cfg := opts.Config

	testDir := opts.Log.Path(filepath.Join("backend", opts.TestID))
	appData := filepath.Join(testDir, "appdata")
	home := filepath.Join(testDir, "home")
	workspace := filepath.Join(testDir, "workspace")
	for _, d := range []string{appData, home, workspace,
		filepath.Join(home, ".config"), filepath.Join(home, ".local", "share"), filepath.Join(home, ".cache")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}

	fixture, err := ResolveWorkspaceFixture(opts.BaseDir, config.Resolve(opts.BaseDir, cfg.Backend.WorkspaceRoot))
	if err != nil {
		return nil, err
	}
	if err := CopyWorkspace(fixture, workspace); err != nil {
		return nil, fmt.Errorf("copying workspace fixture: %w", err)
	}

	db, err := NewDatabase(ctx, cfg, testDir, opts.TestID)
	if err != nil {
		return nil, err
	}

	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	// The token is minted per test and therefore never appears in
	// config.yaml, so the redactor has to be told about it explicitly or it
	// would sit in the clear in every logged request.
	opts.Log.Redactor().Add(token)

	binary, err := Build(ctx, opts.Log, BuildSpec{
		RepoRoot: opts.RepoRoot,
		Package:  "./cmd/server",
		Name:     "server",
		Tags:     opts.BuildTags,
		Override: config.Resolve(opts.BaseDir, cfg.Backend.Binary),
	})
	if err != nil {
		_ = db.Drop()
		return nil, err
	}

	b := &Backend{
		Token:         token,
		AppDataDir:    appData,
		WorkspaceRoot: workspace,
		Home:          home,
		Dir:           testDir,
		DB:            db,
		log:           opts.Log,
		opts:          opts,
		http:          &http.Client{Timeout: 30 * time.Second},
	}

	proc, err := process.Start(opts.Log, process.Spec{
		Name:    "server",
		Path:    binary,
		Args:    nil,
		Dir:     workspace,
		Env:     Env(cfg, Paths{AppDataDir: appData, WorkspaceRoot: workspace, Home: home, DatabaseDSN: db.DSN}, token),
		LogDir:  filepath.Join("backend", opts.TestID),
		Surface: opts.Surface,
		Test:    opts.Address,
	})
	if err != nil {
		_ = db.Drop()
		return nil, err
	}
	b.proc = proc

	timeout := cfg.Backend.StartupTimeout.Duration()
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	portLine, err := proc.WaitForLine(ctx, "PORT=", timeout)
	if err != nil {
		_ = proc.Stop(ctx)
		_ = db.Drop()
		return nil, err
	}
	port, err := strconv.Atoi(portLine)
	if err != nil {
		_ = proc.Stop(ctx)
		_ = db.Drop()
		return nil, fmt.Errorf("server printed PORT=%q, which is not a port", portLine)
	}
	b.Port = port
	b.URL = "http://" + net.JoinHostPort(loopbackFor(cfg.Backend.BindHost), strconv.Itoa(port))

	if err := b.waitHealthy(ctx, timeout); err != nil {
		_ = proc.Stop(ctx)
		_ = db.Drop()
		return nil, err
	}

	opts.Log.Emit(logging.Event{Surface: opts.Surface, Test: opts.Address, Kind: logging.KindProcess,
		Msg: "backend ready", Detail: map[string]any{
			"url": b.URL, "pid": proc.Pid(), "driver": db.Driver, "appDataDir": appData,
		}})
	if runtime.GOOS == "darwin" {
		// go-keyring uses /usr/bin/security on macOS, which no environment
		// variable can redirect. Stripping DBUS_* is a real fix on Linux
		// and CI; here it is not, so say so rather than let a test believe
		// it is isolated when it is not.
		opts.Log.Emit(logging.Event{Surface: opts.Surface, Test: opts.Address, Kind: logging.KindProcess,
			Msg: "keyring not isolated", Detail: map[string]any{
				"reason": "go-keyring uses /usr/bin/security on darwin; a test that writes provider keys touches the real login keychain",
			}})
	}
	return b, nil
}

// loopbackFor maps a bind host to an address a client can actually reach.
// 0.0.0.0 means "every interface", which is not itself a destination.
func loopbackFor(bindHost string) string {
	switch bindHost {
	case "", "0.0.0.0":
		return "127.0.0.1"
	case "::":
		return "::1"
	default:
		return bindHost
	}
}

func (b *Backend) waitHealthy(ctx context.Context, timeout time.Duration) error {
	return process.WaitFor(ctx, "GET "+b.URL+"/health to return 200", timeout, func() error {
		if b.proc.Exited() {
			return fmt.Errorf("server exited with status %d before becoming healthy", b.proc.ExitCode())
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.URL+"/health", nil)
		if err != nil {
			return err
		}
		b.Authorize(req)
		resp, err := b.http.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("status %d", resp.StatusCode)
		}
		return nil
	})
}

// Authorize adds the shared-secret headers a sidecar-mode server requires
// on every request, /health included.
func (b *Backend) Authorize(req *http.Request) {
	req.Header.Set(TokenHeader, b.Token)
	req.Header.Set(LegacyTokenHeader, b.Token)
}

// Stop shuts the server down and asserts it really went away.
//
// Both assertions are returned rather than logged: a leaked backend is a
// test failure. Ignoring it means the next test fails instead, somewhere
// unrelated to the cause.
func (b *Backend) Stop(ctx context.Context) error {
	if b.proc == nil {
		return nil
	}
	port := b.Port
	if err := b.proc.Stop(ctx); err != nil {
		return err
	}
	var firstErr error
	if err := b.proc.AssertStopped(); err != nil {
		firstErr = err
	}
	if err := process.AssertPortFree(loopbackFor(b.opts.Config.Backend.BindHost), port, 5*time.Second); err != nil && firstErr == nil {
		firstErr = err
	}
	if err := b.DB.Drop(); err != nil && firstErr == nil {
		firstErr = err
	}
	b.log.Emit(logging.Event{Surface: b.opts.Surface, Test: b.opts.Address, Kind: logging.KindProcess,
		Msg: "backend stopped", Detail: map[string]any{"port": port, "exitCode": b.proc.ExitCode()}})
	return firstErr
}

// Process exposes the supervisor, for tests that assert on the process
// itself (signals, orphans, stdout) rather than on the API.
func (b *Backend) Process() *process.Process { return b.proc }

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
