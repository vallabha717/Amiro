package desktop

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"time"

	"amiro/tests/harness/backend"
	"amiro/tests/harness/logging"
	"amiro/tests/harness/process"
)

// LaunchSpec describes one `cargo tauri dev` (or bundled binary) launch.
type LaunchSpec struct {
	Log     *logging.Logger
	Surface string
	Test    string
	TestID  string

	// Binary overrides the default `cargo tauri dev`. Set by mode: bundled
	// to drive an installed app instead, and by tests that stand in a stub
	// for cargo so the handoff-parsing logic can be proven without it.
	Binary string
	Args   []string
	Dir    string
	Env    []string

	// AppDataDir, if set, is polled for the discovery lock once the port
	// handoff completes, and the read is recorded alongside it.
	AppDataDir string

	StartupTimeout time.Duration
}

// PortEvent is one line of ports.ndjson: the PORT= handoff Rust reads off
// the sidecar's stdout, or a discovery-lock read observed afterwards.
type PortEvent struct {
	Kind string    `json:"kind"` // "handoff" | "lock-read"
	At   time.Time `json:"at"`
	Port int       `json:"port,omitempty"`
	PID  int       `json:"pid,omitempty"`
}

// App is a launched Tauri process (real `cargo tauri dev`, or a stub
// standing in for it).
type App struct {
	proc      *process.Process
	Port      int
	PortsPath string
}

// Launch starts the process, waits for the PORT= handoff exactly the way
// Rust's own reader does (line by line, never assuming the first line --
// see process.WaitForLine's doc comment for why that rule exists), and
// records the handoff -- and, if AppDataDir is set, the discovery lock that
// follows it -- to ports.ndjson.
func Launch(ctx context.Context, spec LaunchSpec) (*App, error) {
	path := spec.Binary
	args := spec.Args
	if path == "" {
		path = "cargo"
		args = append([]string{"tauri", "dev"}, args...)
	}
	logDir := filepath.Join(spec.Surface, spec.TestID)
	proc, err := process.Start(spec.Log, process.Spec{
		Name: "tauri", Path: path, Args: args, Dir: spec.Dir, Env: spec.Env,
		LogDir: logDir, Surface: spec.Surface, Test: spec.Test,
	})
	if err != nil {
		return nil, err
	}

	timeout := spec.StartupTimeout
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	line, err := proc.WaitForLine(ctx, "PORT=", timeout)
	if err != nil {
		_ = proc.Stop(ctx)
		return nil, err
	}
	port, err := strconv.Atoi(line)
	if err != nil {
		_ = proc.Stop(ctx)
		return nil, fmt.Errorf("tauri sidecar printed PORT=%q, which is not a port", line)
	}

	portsPath := filepath.ToSlash(filepath.Join(logDir, "ports.ndjson"))
	spec.Log.NDJSON(portsPath, PortEvent{Kind: "handoff", At: time.Now(), Port: port})

	if spec.AppDataDir != "" {
		deadline := timeout
		if deadline > 10*time.Second {
			deadline = 10 * time.Second
		}
		_ = process.WaitFor(ctx, "discovery lock to appear in "+spec.AppDataDir, deadline, func() error {
			lock, found, err := backend.ReadLock(spec.AppDataDir)
			if err != nil {
				return err
			}
			if !found {
				return fmt.Errorf("no lock file yet")
			}
			spec.Log.NDJSON(portsPath, PortEvent{Kind: "lock-read", At: time.Now(), Port: lock.Port, PID: lock.PID})
			return nil
		})
	}

	return &App{proc: proc, Port: port, PortsPath: portsPath}, nil
}

// Process exposes the supervisor, for tests that assert on the process
// itself rather than the port it reported.
func (a *App) Process() *process.Process { return a.proc }

// Stop asks the process to exit, escalating to a kill after process.StopGrace.
func (a *App) Stop(ctx context.Context) error { return a.proc.Stop(ctx) }
