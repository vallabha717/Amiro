package tools

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"amiro/backend/internal/agent/sandbox"
	"amiro/backend/internal/agent/workspace"
)

const (
	defaultTimeout = 120 * time.Second
	maxTimeout     = 600 * time.Second
	maxOutputChars = 20000
)

type terminalInput struct {
	Command         string `json:"command"`
	Description     string `json:"description,omitempty"`
	TimeoutSeconds  int    `json:"timeout_seconds,omitempty"`
	RunInBackground bool   `json:"run_in_background,omitempty"`
}

type terminalOutput struct {
	Command   string `json:"command"`
	CWD       string `json:"cwd"`
	ExitCode  int    `json:"exit_code"`
	Output    string `json:"output"`
	TimedOut  bool   `json:"timed_out"`
	Truncated bool   `json:"truncated"`
	Error     string `json:"error,omitempty"`
	// Sandboxed and SandboxBackend are the honesty contract
	// docs/coding-agent-parity/03-sandboxed-execution.md requires: every
	// result states plainly whether isolation actually happened for this
	// command, and which backend provided it ("bubblewrap", "seatbelt", or
	// "none"). See internal/agent/sandbox.Result.
	Sandboxed      bool   `json:"sandboxed"`
	SandboxBackend string `json:"sandbox_backend"`
}

type bgTaskInput struct {
	TaskID string `json:"task_id"`
}

type bgTask struct {
	ID       string
	Command  string
	CWD      string
	Cmd      *exec.Cmd
	Lock     sync.Mutex
	Output   bytes.Buffer
	Cursor   int
	Exited   bool
	ExitCode int
}

type TerminalExecutor struct {
	mu        sync.Mutex
	cwd       string
	shellPath string
	bgTasks   map[string]*bgTask
	bgCounter int
}

// executors holds one persistent shell session per workspace root, keyed by
// that root ("" for no workspace).
//
// One session per workspace, rather than one for the process, because the
// session's defining feature is that cwd and background tasks persist
// across calls -- and persisting them *across workspaces* means a command
// run for one thread starts in another thread's directory. A single global
// session was also load-bearing in a way that only showed up under test:
// seeding it from whichever request happened to arrive first left it
// pointing at a temp directory that no longer existed by the time the next
// caller ran anything.
var (
	executorsMu sync.Mutex
	executors   = map[string]*TerminalExecutor{}
)

// executorFor returns the session for a workspace root, creating it on
// first use. An empty root means "no workspace configured", which falls
// back to the process working directory as it always did.
func executorFor(root string) *TerminalExecutor {
	executorsMu.Lock()
	defer executorsMu.Unlock()
	if e, ok := executors[root]; ok {
		return e
	}
	e := newTerminalExecutor(root)
	executors[root] = e
	return e
}

func newTerminalExecutor(root string) *TerminalExecutor {
	cwd := root
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil || cwd == "" {
			cwd, _ = os.UserHomeDir()
		}
	}
	shell := "/bin/bash"
	if runtime.GOOS == "windows" {
		shell = "powershell.exe"
	} else if _, err := exec.LookPath("bash"); err != nil {
		if sh, err := exec.LookPath("sh"); err == nil {
			shell = sh
		}
	}
	return &TerminalExecutor{
		cwd:       cwd,
		shellPath: shell,
		bgTasks:   make(map[string]*bgTask),
	}
}

func randomMarker() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "__AMIRO_DONE_" + hex.EncodeToString(b) + "__"
}

// errUnsandboxedRefused is returned in-band (as terminalOutput.Error), not
// as a Go error, for the same reason every other tool refusal here is: the
// model needs to read it and adapt, not have the turn end on a stream
// error. "no sandbox backend is available" is not this command's fault.
const errUnsandboxedRefused = "refused: no sandbox backend is available on this machine, and an unattended background run may never fall back to running a shell command unsandboxed -- see docs/coding-agent-parity/05-background-agent-runs.md"

func (e *TerminalExecutor) Run(ctx context.Context, in terminalInput, networkAllow []string, requireSandbox bool) terminalOutput {
	if requireSandbox && !sandbox.Detect().Sandboxed() {
		return terminalOutput{Command: in.Command, CWD: e.cwd, ExitCode: 1, Error: errUnsandboxedRefused}
	}
	if in.RunInBackground {
		res := e.runBackground(in.Command, networkAllow, requireSandbox)
		b, _ := json.Marshal(res)
		return terminalOutput{
			Command:  in.Command,
			CWD:      e.cwd,
			Output:   string(b),
			ExitCode: 0,
		}
	}

	e.mu.Lock()
	cwd := e.cwd
	shellPath := e.shellPath
	e.mu.Unlock()

	timeout := defaultTimeout
	if in.TimeoutSeconds > 0 {
		timeout = time.Duration(in.TimeoutSeconds) * time.Second
		if timeout > maxTimeout {
			timeout = maxTimeout
		}
	}

	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	marker := randomMarker()
	var argv []string

	if runtime.GOOS == "windows" {
		psScript := fmt.Sprintf("%s; Write-Output \"`n%s $LASTEXITCODE $($PWD.Path)\"", in.Command, marker)
		argv = []string{"powershell.exe", "-NoProfile", "-NonInteractive", "-Command", psScript}
	} else {
		script := fmt.Sprintf("{ %s\n}; __amiro_ec=$?; echo ''; echo '%s' $__amiro_ec \"$PWD\"", in.Command, marker)
		argv = []string{shellPath, "-c", script}
	}

	// Windows has no sandbox backend this phase (sandbox.Detect always
	// returns the "none" fallback there -- see
	// internal/agent/sandbox/detect_other.go), so cwd is set the same way
	// os/exec always set it; a real backend instead binds cwd itself
	// (bubblewrap's --chdir, seatbelt's subpath rule) as part of wrap().
	var outBuf bytes.Buffer
	networkAllowed := sandbox.NetworkAllowed(networkAllow, in.Command)
	result, runErr := sandbox.Run(execCtx, argv, sandbox.RunOpts{
		Dir: cwd,
		Env: append(os.Environ(),
			"GIT_TERMINAL_PROMPT=0",
			"DEBIAN_FRONTEND=noninteractive",
			"PYTHONUNBUFFERED=1",
			"PIP_NO_INPUT=1",
		),
		Stdout:         &outBuf,
		Stderr:         &outBuf,
		NetworkAllowed: networkAllowed,
	})

	timedOut := execCtx.Err() == context.DeadlineExceeded

	rawOutput := outBuf.String()
	cleanOutput := rawOutput
	exitCode := result.ExitCode
	if runErr != nil && exitCode == 0 {
		exitCode = 1
	}
	newCWD := cwd

	// Parse marker line
	if idx := strings.Index(rawOutput, marker); idx != -1 {
		cleanOutput = strings.TrimRight(rawOutput[:idx], "\r\n")
		trailer := strings.TrimSpace(rawOutput[idx+len(marker):])
		parts := strings.Fields(trailer)
		if len(parts) >= 1 {
			if parsedCode, parseErr := strconv.Atoi(parts[0]); parseErr == nil {
				exitCode = parsedCode
			}
		}
		if len(parts) >= 2 {
			parsedCwd := strings.Join(parts[1:], " ")
			if parsedCwd != "" {
				newCWD = parsedCwd
				e.mu.Lock()
				e.cwd = parsedCwd
				e.mu.Unlock()
			}
		}
	}

	truncated := len(cleanOutput) > maxOutputChars
	if truncated {
		cleanOutput = cleanOutput[len(cleanOutput)-maxOutputChars:]
	}

	errMsg := ""
	if timedOut {
		errMsg = "command timed out"
	}

	return terminalOutput{
		Command:        in.Command,
		CWD:            newCWD,
		ExitCode:       exitCode,
		Output:         cleanOutput,
		TimedOut:       timedOut,
		Truncated:      truncated,
		Error:          errMsg,
		Sandboxed:      result.Sandboxed,
		SandboxBackend: result.Backend,
	}
}

func (e *TerminalExecutor) runBackground(command string, networkAllow []string, requireSandbox bool) map[string]any {
	if requireSandbox && !sandbox.Detect().Sandboxed() {
		return map[string]any{"error": errUnsandboxedRefused}
	}
	e.mu.Lock()
	e.bgCounter++
	taskID := fmt.Sprintf("bg-%d", e.bgCounter)
	cwd := e.cwd
	shellPath := e.shellPath
	e.mu.Unlock()

	// Deliberately not the request context, and deliberately not a
	// cancelable one either. A background task outlives the turn that
	// started it -- that is what "background" means here -- so tying it to
	// the request would kill a dev server the moment the reply finished.
	// The cancel func this used to derive was discarded, which `go vet`
	// flags as a leak and which was also just a lie: nothing could ever
	// call it. shell_task_kill is the real stop, and it kills the process
	// directly.
	var argv []string
	if runtime.GOOS == "windows" {
		argv = []string{"powershell.exe", "-NoProfile", "-Command", command}
	} else {
		argv = []string{shellPath, "-c", command}
	}
	cmd, sandboxResult := sandbox.Command(context.Background(), argv, sandbox.CommandOpts{
		Dir:            cwd,
		NetworkAllowed: sandbox.NetworkAllowed(networkAllow, command),
	})
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"DEBIAN_FRONTEND=noninteractive",
		"PYTHONUNBUFFERED=1",
		"PIP_NO_INPUT=1",
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return map[string]any{"error": fmt.Sprintf("failed to get stdout pipe: %v", err)}
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return map[string]any{"error": fmt.Sprintf("failed to get stderr pipe: %v", err)}
	}

	if err := cmd.Start(); err != nil {
		return map[string]any{"error": fmt.Sprintf("failed to start background task: %v", err)}
	}

	task := &bgTask{
		ID:      taskID,
		Command: command,
		CWD:     cwd,
		Cmd:     cmd,
	}

	e.mu.Lock()
	e.bgTasks[taskID] = task
	e.mu.Unlock()

	readPipe := func(r io.Reader) {
		buf := make([]byte, 1024)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				task.Lock.Lock()
				task.Output.Write(buf[:n])
				task.Lock.Unlock()
			}
			if err != nil {
				break
			}
		}
	}

	go readPipe(stdout)
	go readPipe(stderr)

	go func() {
		err := cmd.Wait()
		task.Lock.Lock()
		task.Exited = true
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				task.ExitCode = exitErr.ExitCode()
			} else {
				task.ExitCode = 1
			}
		} else {
			task.ExitCode = 0
		}
		task.Lock.Unlock()
	}()

	return map[string]any{
		"task_id":         taskID,
		"command":         command,
		"status":          "running",
		"note":            "use shell_task_output to read its output, shell_task_kill to stop it",
		"sandboxed":       sandboxResult.Sandboxed,
		"sandbox_backend": sandboxResult.Backend,
	}
}

func (e *TerminalExecutor) backgroundOutput(taskID string) map[string]any {
	e.mu.Lock()
	task, ok := e.bgTasks[taskID]
	e.mu.Unlock()

	if !ok {
		return map[string]any{"error": fmt.Sprintf("unknown task: %s", taskID)}
	}

	task.Lock.Lock()
	defer task.Lock.Unlock()

	fullOutput := task.Output.String()
	newOutput := ""
	if task.Cursor < len(fullOutput) {
		newOutput = fullOutput[task.Cursor:]
		task.Cursor = len(fullOutput)
	}

	status := "running"
	var exitCode any = nil
	if task.Exited {
		status = "exited"
		exitCode = task.ExitCode
	}

	truncated := len(newOutput) > maxOutputChars
	if truncated {
		newOutput = newOutput[len(newOutput)-maxOutputChars:]
	}

	return map[string]any{
		"task_id":   taskID,
		"status":    status,
		"exit_code": exitCode,
		"output":    newOutput,
		"truncated": truncated,
	}
}

func (e *TerminalExecutor) backgroundKill(taskID string) map[string]any {
	e.mu.Lock()
	task, ok := e.bgTasks[taskID]
	e.mu.Unlock()

	if !ok {
		return map[string]any{"error": fmt.Sprintf("unknown task: %s", taskID)}
	}

	task.Lock.Lock()
	if !task.Exited && task.Cmd != nil && task.Cmd.Process != nil {
		_ = task.Cmd.Process.Kill()
		task.Exited = true
		task.ExitCode = -1
	}
	task.Lock.Unlock()

	return map[string]any{
		"task_id":   taskID,
		"status":    "killed",
		"exit_code": -1,
	}
}

// terminalTools builds the shell toolkit for a workspace.
//
// A configured root becomes the session's starting directory instead of
// wherever the sidecar process was launched from -- which on the packaged
// desktop app is arbitrary, and is very unlikely to be the code the user is
// asking about. That is a *default*, not containment: a shell command can
// `cd` anywhere the user can, and no starting directory changes that. What
// bounds shell is the permission gate (RiskExec below), not this. Files are
// different -- workspace.Resolve genuinely confines them -- and conflating
// the two would be the mistake.
func terminalTools(ws *workspace.Workspace, networkAllow []string, requireSandbox bool) []Definition {
	root := ""
	if ws != nil {
		root = ws.Root()
	}
	executor := executorFor(root)

	executeTerminal := func(ctx context.Context, rawInput json.RawMessage) (any, error) {
		var in terminalInput
		if err := json.Unmarshal(rawInput, &in); err != nil {
			return nil, err
		}
		out := executor.Run(ctx, in, networkAllow, requireSandbox)
		return out, nil
	}

	executeTaskOutput := func(ctx context.Context, rawInput json.RawMessage) (any, error) {
		var in bgTaskInput
		if err := json.Unmarshal(rawInput, &in); err != nil {
			return nil, err
		}
		return executor.backgroundOutput(in.TaskID), nil
	}

	executeTaskKill := func(ctx context.Context, rawInput json.RawMessage) (any, error) {
		var in bgTaskInput
		if err := json.Unmarshal(rawInput, &in); err != nil {
			return nil, err
		}
		return executor.backgroundKill(in.TaskID), nil
	}

	schemaTerminal := json.RawMessage(`{
		"type": "object",
		"properties": {
			"command": {
				"type": "string",
				"description": "The shell command to run."
			},
			"description": {
				"type": "string",
				"description": "Short human-readable summary of what the command does."
			},
			"timeout_seconds": {
				"type": "integer",
				"description": "Max seconds to wait (default 120, max 600)."
			},
			"run_in_background": {
				"type": "boolean",
				"description": "Run detached and return a task_id immediately instead of waiting."
			}
		},
		"required": ["command"]
	}`)

	schemaTaskOutput := json.RawMessage(`{
		"type": "object",
		"properties": {
			"task_id": {
				"type": "string",
				"description": "The task_id returned by run_shell or terminal-execution."
			}
		},
		"required": ["task_id"]
	}`)

	schemaTaskKill := json.RawMessage(`{
		"type": "object",
		"properties": {
			"task_id": {
				"type": "string",
				"description": "The task_id returned by run_shell or terminal-execution."
			}
		},
		"required": ["task_id"]
	}`)

	return []Definition{
		{
			Name:             NameTerminalExecution,
			Toolkit:          ToolkitTerminal,
			Risk:             RiskExec,
			Description:      "Execute shell commands in a persistent terminal session (cwd and env persist across calls). Use for running tools, builds, tests, git commands, or inspection.",
			ParametersSchema: schemaTerminal,
			Execute:          executeTerminal,
		},
		{
			Name:             NameRunShell,
			Toolkit:          ToolkitTerminal,
			Risk:             RiskExec,
			Description:      "Run a shell command in the persistent session (cwd and env persist across calls). Set run_in_background for long-running processes like dev servers.",
			ParametersSchema: schemaTerminal,
			Execute:          executeTerminal,
		},
		{
			Name:    NameShellTaskOutput,
			Toolkit: ToolkitTerminal,
			// Reading a task's buffer is a read. The command it is reading
			// from was gated when it was started.
			Risk:             RiskRead,
			Description:      "Read new output from a background task started with run_in_background=true.",
			ParametersSchema: schemaTaskOutput,
			Execute:          executeTaskOutput,
		},
		{
			Name:    NameShellTaskKill,
			Toolkit: ToolkitTerminal,
			// Killing a process is not a read, but it is also not a new
			// command: the only thing it can reach is a task this session
			// already started and the user already approved. Write, so it
			// stays ordered against the run that spawned it.
			Risk:             RiskWrite,
			Description:      "Stop a background task started with run_in_background=true.",
			ParametersSchema: schemaTaskKill,
			Execute:          executeTaskKill,
		},
	}
}
