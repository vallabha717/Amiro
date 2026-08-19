// Package process is the supervisor every spawned thing goes through.
//
// Four guarantees, each of which exists because its absence produces a
// specific bad day (docs/testing/01-architecture.md):
//
//   - stdio is streamed to disk AS PRODUCED, never buffered until exit. A
//     hung process is exactly when its log matters, and a logger that
//     flushes on clean shutdown is empty in that case.
//   - readiness is a PREDICATE with a deadline, never a sleep. A sleep is
//     either too short (flake) or too long (a slow suite), and it is never
//     evidence that the thing is actually up.
//   - children run in their own process GROUP, so killing the parent kills
//     what it spawned. Tauri spawns the Go sidecar; without this, stopping
//     Tauri leaks a backend that still holds a port.
//   - teardown ASSERTS: the process exited, and its port is free. A leaked
//     backend is reported as a failure, not ignored until it breaks an
//     unrelated test twenty minutes later.
package process

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"amiro/tests/harness/logging"
)

// StopGrace is how long a process gets to exit on its own after SIGTERM
// before it is killed. Matches cmd/server's own 5s shutdown budget, so a
// backend that takes its full grace period to drain is not killed mid-drain
// and reported as a crash.
const StopGrace = 5 * time.Second

// Spec describes a process to start.
type Spec struct {
	// Name identifies the process in logs and events: "server", "amiro",
	// "tauri". It is also the stem of its stdio log files.
	Name string
	Path string
	Args []string
	Dir  string
	// Env REPLACES the environment rather than extending it. Every spawned
	// binary in this suite gets an explicitly built environment -- a test
	// that inherits the developer's AMIRO_APP_DATA_DIR is a test that
	// writes to their real database.
	Env []string

	// LogDir is where stdio goes, relative to the run directory, e.g.
	// "backend/backend-chat-TestStream".
	LogDir string
	// Surface and Test label the events this process emits.
	Surface string
	Test    string

	// Stdin, if set, becomes the child's standard input. Nil (the default)
	// leaves exec.Cmd's own behaviour, which connects the child to the null
	// device -- reading it returns EOF immediately. That default matters:
	// desktop/orphans wires a real pipe here specifically so it can close
	// the write end and prove the sidecar notices its parent's pipe
	// closing, exactly as it would when Tauri's process dies. Anything that
	// does not set this is unaffected.
	Stdin io.Reader
}

// Process is a running child.
type Process struct {
	spec Spec
	cmd  *exec.Cmd
	log  *logging.Logger

	stdoutLines chan string
	stderrLines chan string

	closers []io.Closer

	mu       sync.Mutex
	waitErr  error
	waited   bool
	waitDone chan struct{}
}

// Start spawns the process and begins streaming its output.
//
// It returns as soon as the process is running. Readiness is a separate,
// explicit step -- see WaitForLine and WaitFor -- because "started" and
// "ready to serve" are different facts and conflating them is how a suite
// acquires a race it then papers over with a sleep.
func Start(log *logging.Logger, spec Spec) (*Process, error) {
	if spec.Name == "" {
		return nil, errors.New("process.Start: Spec.Name is required (it names the log files)")
	}
	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	cmd.Stdin = spec.Stdin
	setProcessGroup(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("%s: stdout pipe: %w", spec.Name, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("%s: stderr pipe: %w", spec.Name, err)
	}

	p := &Process{
		spec:        spec,
		cmd:         cmd,
		log:         log,
		stdoutLines: make(chan string, 256),
		stderrLines: make(chan string, 256),
		waitDone:    make(chan struct{}),
	}

	outFile, err := log.Stream(spec.LogDir + "/" + spec.Name + ".stdout.log")
	if err != nil {
		return nil, err
	}
	errFile, err := log.Stream(spec.LogDir + "/" + spec.Name + ".stderr.log")
	if err != nil {
		return nil, err
	}
	p.closers = append(p.closers, outFile, errFile)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting %s: %w", spec.Path, err)
	}

	go p.pump(stdout, outFile, p.stdoutLines)
	go p.pump(stderr, errFile, p.stderrLines)
	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		p.waitErr, p.waited = err, true
		p.mu.Unlock()
		close(p.waitDone)
	}()

	spawnDetail := map[string]any{"name": spec.Name, "path": spec.Path, "pid": cmd.Process.Pid}
	if len(spec.Args) > 0 {
		spawnDetail["args"] = spec.Args
	}
	log.Emit(logging.Event{Surface: spec.Surface, Test: spec.Test, Kind: logging.KindProcess,
		Msg: "spawn", Detail: spawnDetail})
	return p, nil
}

// StartWithPTY spawns a process attached to a PTY slave, streaming master output
// to disk and any extra sinks (such as virtual terminal buffers and cast recorders).
func StartWithPTY(log *logging.Logger, spec Spec, master, slave *os.File, extraSinks ...io.Writer) (*Process, error) {
	if spec.Name == "" {
		return nil, errors.New("process.StartWithPTY: Spec.Name is required")
	}
	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = spec.Env
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	setProcessGroup(cmd)

	p := &Process{
		spec:        spec,
		cmd:         cmd,
		log:         log,
		stdoutLines: make(chan string, 256),
		stderrLines: make(chan string, 256),
		waitDone:    make(chan struct{}),
	}

	outFile, err := log.Stream(spec.LogDir + "/" + spec.Name + ".stdout.log")
	if err != nil {
		return nil, err
	}
	p.closers = append(p.closers, outFile)

	var sinks []io.Writer
	sinks = append(sinks, outFile)
	sinks = append(sinks, extraSinks...)
	combinedSink := io.MultiWriter(sinks...)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting %s with PTY: %w", spec.Path, err)
	}

	// Close slave in parent after Start so only the child holds it.
	_ = slave.Close()

	go p.pump(master, combinedSink, p.stdoutLines)
	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		p.waitErr, p.waited = err, true
		p.mu.Unlock()
		close(p.waitDone)
	}()

	spawnDetail := map[string]any{"name": spec.Name, "path": spec.Path, "pid": cmd.Process.Pid, "pty": true}
	if len(spec.Args) > 0 {
		spawnDetail["args"] = spec.Args
	}
	log.Emit(logging.Event{Surface: spec.Surface, Test: spec.Test, Kind: logging.KindProcess,
		Msg: "spawn", Detail: spawnDetail})
	return p, nil
}


// pump copies one stream to its log file line by line while also offering
// each line to any readiness predicate waiting on it.
//
// The tee is the point: the log file gets everything, unconditionally,
// whether or not anyone is reading lines. A readiness check that consumed
// the stream would produce a log missing exactly the startup output someone
// later needs.
func (p *Process) pump(r io.Reader, sink io.Writer, lines chan<- string) {
	defer close(lines)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		line := sc.Text()
		_, _ = io.WriteString(sink, line+"\n")
		select {
		case lines <- line:
		default:
			// Nobody is reading, and the log already has it. Dropping here
			// rather than blocking is what keeps a chatty process from
			// stalling on a full channel once its readiness check is done.
		}
	}
}

// Pid returns the child's process id.
func (p *Process) Pid() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

// WaitForLine scans stdout for the first line carrying prefix and returns
// the remainder, with a deadline.
//
// This is how the backend's port is learned: cmd/server prints "PORT=<n>".
// It scans LINE BY LINE and never assumes the first line -- Bifrost writes
// its own startup logging to stdout ahead of the PORT= line, so a reader
// that took line one would find a log message and conclude the backend had
// failed. src-tauri/src/lib.rs and backend-go/tests/e2e already scan; this
// is the third implementation of the same rule and the last one.
func (p *Process) WaitForLine(ctx context.Context, prefix string, timeout time.Duration) (string, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case line, ok := <-p.stdoutLines:
			if !ok {
				return "", fmt.Errorf("%s closed stdout before printing a %s line%s",
					p.spec.Name, prefix, p.diagnostics())
			}
			if rest, found := strings.CutPrefix(strings.TrimSpace(line), prefix); found {
				p.log.Emit(logging.Event{Surface: p.spec.Surface, Test: p.spec.Test, Kind: logging.KindProcess,
					Msg: "ready", Detail: map[string]any{"name": p.spec.Name, "matched": prefix, "value": rest}})
				return rest, nil
			}
		case <-p.waitDone:
			// Drain whatever is still buffered before declaring failure: a
			// process that printed PORT= and exited immediately afterwards
			// has still told us the port.
			for line := range p.stdoutLines {
				if rest, found := strings.CutPrefix(strings.TrimSpace(line), prefix); found {
					return rest, nil
				}
			}
			return "", fmt.Errorf("%s exited before printing a %s line%s", p.spec.Name, prefix, p.diagnostics())
		case <-deadline.C:
			return "", fmt.Errorf("%s did not print a %s line within %s%s", p.spec.Name, prefix, timeout, p.diagnostics())
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

// diagnostics appends the process's own log paths to an error, so the
// failure message says where to look rather than only what went wrong.
func (p *Process) diagnostics() string {
	return fmt.Sprintf("\n  stdout: %s\n  stderr: %s",
		p.log.Path(p.spec.LogDir+"/"+p.spec.Name+".stdout.log"),
		p.log.Path(p.spec.LogDir+"/"+p.spec.Name+".stderr.log"))
}

// Stop asks the process to exit, escalating to a kill after StopGrace, and
// then asserts that it actually did.
func (p *Process) Stop(ctx context.Context) error {
	if p.cmd.Process == nil {
		return nil
	}
	select {
	case <-p.waitDone:
		p.closeStreams()
		return nil
	default:
	}

	terminate(p.cmd)
	select {
	case <-p.waitDone:
		p.log.Emit(logging.Event{Surface: p.spec.Surface, Test: p.spec.Test, Kind: logging.KindProcess,
			Msg: "stopped", Detail: map[string]any{"name": p.spec.Name, "graceful": true}})
	case <-time.After(StopGrace):
		kill(p.cmd)
		<-p.waitDone
		p.log.Emit(logging.Event{Surface: p.spec.Surface, Test: p.spec.Test, Kind: logging.KindProcess,
			Msg: "killed", Detail: map[string]any{"name": p.spec.Name, "after": StopGrace.String()}})
	case <-ctx.Done():
		kill(p.cmd)
		<-p.waitDone
	}
	p.closeStreams()
	return nil
}

func (p *Process) closeStreams() {
	for _, c := range p.closers {
		_ = c.Close()
	}
	p.closers = nil
}

// Wait blocks until the process exits and returns its exit error.
func (p *Process) Wait() error {
	<-p.waitDone
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waitErr
}

// Exited reports whether the process has already exited.
func (p *Process) Exited() bool {
	select {
	case <-p.waitDone:
		return true
	default:
		return false
	}
}

// ExitCode returns the exit status, or -1 if it is still running.
func (p *Process) ExitCode() int {
	if !p.Exited() {
		return -1
	}
	if p.cmd.ProcessState == nil {
		return -1
	}
	return p.cmd.ProcessState.ExitCode()
}

// WaitFor polls a predicate until it holds or the deadline passes.
//
// The only waiting primitive in the harness. There is no Sleep, and
// suites/meta/no_sleep_test.go enforces that -- a sleep is a race that has
// been rounded up rather than removed.
func WaitFor(ctx context.Context, what string, timeout time.Duration, cond func() error) error {
	deadline := time.Now().Add(timeout)
	interval := 10 * time.Millisecond
	var last error
	for {
		if last = cond(); last == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for %s; last attempt: %v", timeout, what, last)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
		// Backing off keeps a 30s wait from making 3000 attempts, while
		// staying fast enough that a process ready in 40ms is not made to
		// wait 200.
		if interval < 250*time.Millisecond {
			interval *= 2
		}
	}
}

// AssertStopped verifies the process is gone. Called from teardown; a
// process still running here is a leak and the caller reports it as a test
// failure.
func (p *Process) AssertStopped() error {
	if !p.Exited() {
		return fmt.Errorf("%s (pid %d) is still running after teardown", p.spec.Name, p.Pid())
	}
	return nil
}

// AssertPortFree verifies nothing is listening on the port any more.
//
// Separate from AssertStopped because they fail for different reasons: the
// process can be gone while a child it spawned still holds the listener,
// which is the exact case process groups exist to prevent and therefore the
// exact case worth checking.
func AssertPortFree(host string, port int, within time.Duration) error {
	if port == 0 {
		return nil
	}
	addr := net.JoinHostPort(host, fmt.Sprint(port))
	return WaitFor(context.Background(), "port "+addr+" to be released", within, func() error {
		conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err != nil {
			return nil // Refused is what we want.
		}
		_ = conn.Close()
		return fmt.Errorf("something is still listening on %s", addr)
	})
}

// FreePort asks the OS for a port and immediately releases it.
//
// Inherently racy, and used only where a component insists on being told a
// port rather than reporting one. Everything that can bind :0 and print
// what it got does that instead.
func FreePort(host string) (int, error) {
	l, err := net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// Environ builds a child environment from an explicit base plus additions.
// Never inherits os.Environ() implicitly -- see Spec.Env.
func Environ(base []string, extra ...string) []string {
	out := append([]string(nil), base...)
	return append(out, extra...)
}

// InheritSafe returns the parent environment minus every variable the
// application reads, so a spawned backend cannot pick up the developer's
// own AMIRO_APP_DATA_DIR and write to their real database.
//
// PATH, HOME and the platform's own variables are kept: a Go binary that
// cannot find its temp directory does not start.
func InheritSafe(strip ...string) []string {
	stripped := map[string]bool{}
	for _, s := range strip {
		stripped[s] = true
	}
	var out []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if stripped[k] {
			continue
		}
		// Everything the app or the harness configures is rebuilt
		// explicitly by harness/backend.Env(); inheriting any of it would
		// make a test's environment depend on the shell that launched it.
		if strings.HasPrefix(k, "AMIRO_") || strings.HasPrefix(k, "BETTERCHATBOT_") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// listen binds a TCP port on loopback. Used by tests to hold a port and
// prove AssertPortFree notices.
func listen(port int) (net.Listener, error) {
	return net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(port)))
}
