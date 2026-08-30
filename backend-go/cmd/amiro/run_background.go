package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"path/filepath"
	"strings"

	"amiro/backend/internal/config"
	"amiro/backend/internal/tui/client"
)

// backgroundRunOutput is `amiro run --background`'s --json schema: the
// job's id and starting status, not a turn's result -- the whole point of
// --background is that this command returns before the turn is anywhere
// near done (docs/coding-agent-parity/05-background-agent-runs.md).
type backgroundRunOutput struct {
	JobID         string `json:"jobId"`
	ThreadID      string `json:"threadId"`
	Status        string `json:"status"`
	WorkspaceRoot string `json:"workspaceRoot"`
	Error         string `json:"error,omitempty"`
}

// runHeadlessBackgroundTurn is --background's counterpart to
// runHeadlessTurn, and deliberately does not share its body: a background
// job's worker goroutine lives in the SERVER process, not in this CLI
// invocation, so this can never call appwiring.New and run the turn
// in-process the way an ordinary `amiro run` does -- the App (and the job's
// worker with it) would be torn down by this command's own `defer
// app.Close()` the instant it returned, killing the job before it had a
// chance to do anything.
//
// Instead this behaves like `amiro chat`: attach to an already-running
// server (the desktop app's sidecar, `amiro serve`, or another `amiro`) and
// submit the job over HTTP. If no server is already running, this refuses
// rather than embedding a fresh one for the call -- an embedded server's
// lifetime is exactly this process's lifetime (see transport.Close), which
// would reproduce the identical problem one layer up.
func runHeadlessBackgroundTurn(ctx context.Context, args []string) (out backgroundRunOutput, jsonOut bool, err error) {
	flagArgs, promptWords := partitionRunArgs(args)

	fs := flag.NewFlagSet("amiro run --background", flag.ContinueOnError)
	dir := fs.String("C", "", "run as though launched from dir")
	mode := fs.String("mode", "auto", `permission mode for the job: "edit" or "auto" (a background job has no one to ask, so plan and interactive are refused)`)
	autoPR := fs.Bool("auto-pr", false, "on a clean finish, summarize the changes, push a new branch, and open a pull request -- each step still asks for approval")
	jsonFlag := fs.Bool("json", false, "print the created job as one JSON object on stdout")
	connectURL := fs.String("connect", "", "attach to a specific server instead of the usual attach-or-embed discovery, e.g. http://127.0.0.1:5175")
	connectToken := fs.String("token", "", "the shared-secret token for --connect")
	_ = fs.Bool("background", false, "unused here -- consumed by the caller before this is reached; present so it is not rejected as an unknown flag if repeated")
	if err := fs.Parse(flagArgs); err != nil {
		return backgroundRunOutput{}, false, err
	}
	if len(promptWords) == 0 {
		return backgroundRunOutput{}, *jsonFlag, fmt.Errorf(`usage: amiro run "<prompt>" --background [--mode edit|auto] [--auto-pr] [--json]`)
	}
	prompt := strings.Join(promptWords, " ")

	if *mode != "edit" && *mode != "auto" {
		return backgroundRunOutput{}, *jsonFlag, fmt.Errorf(`--mode must be "edit" or "auto" for a background job (got %q)`, *mode)
	}

	workspaceRoot := *dir
	if workspaceRoot == "" {
		workspaceRoot = "."
	}
	workspaceRoot, err = filepath.Abs(workspaceRoot)
	if err != nil {
		return backgroundRunOutput{}, *jsonFlag, fmt.Errorf("resolving workspace root: %w", err)
	}

	cfg, err := config.Load()
	if err != nil {
		return backgroundRunOutput{}, *jsonFlag, fmt.Errorf("config: %w", err)
	}

	t, err := resolveConnection(ctx, cfg, *connectURL, *connectToken)
	if err != nil {
		return backgroundRunOutput{}, *jsonFlag, err
	}
	if t.embedded != nil {
		// Nothing was already running -- resolveTransport just started one
		// for this call alone. Closing it immediately and refusing is the
		// honest answer: a job "started" in that server would be
		// interrupted the moment this command exits and this defer runs.
		t.Close()
		return backgroundRunOutput{}, *jsonFlag, fmt.Errorf(
			"no backend server is running -- a background job's worker lives in the server process " +
				"and this command exits immediately, so amiro cannot embed one just for this call. " +
				"Start one first with `amiro serve` (or the desktop app), then retry")
	}

	authed, err := resolveSession(ctx, cfg, t)
	if err != nil {
		return backgroundRunOutput{}, *jsonFlag, err
	}

	job, err := authed.CreateBackgroundJob(ctx, client.CreateBackgroundJobRequest{
		Prompt: prompt, Mode: *mode, WorkspaceRoot: workspaceRoot, AutoPR: *autoPR,
	})
	if err != nil {
		return backgroundRunOutput{}, *jsonFlag, err
	}

	return backgroundRunOutput{
		JobID: job.ID, ThreadID: job.ThreadID, Status: job.Status, WorkspaceRoot: job.WorkspaceRoot,
	}, *jsonFlag, nil
}

// runHeadlessBackground is --background's CLI entrypoint: submit the job
// and print its id, distinct from runHeadless (which waits for and prints
// a turn's result) -- the two are never called for the same invocation
// (see runHeadless's own dispatch on the --background flag).
func runHeadlessBackground(args []string) error {
	out, jsonOut, err := runHeadlessBackgroundTurn(context.Background(), args)
	if err != nil {
		return err
	}
	if jsonOut {
		b, encErr := json.Marshal(out)
		if encErr != nil {
			return fmt.Errorf("encoding result: %w", encErr)
		}
		fmt.Println(string(b))
		return nil
	}
	fmt.Printf("started background job %s (thread %s), status: %s\n", out.JobID, out.ThreadID, out.Status)
	fmt.Println("check its progress from the web \"Agent runs\" panel, the TUI's /runs picker, or `amiro run --background` again once list support lands in this CLI")
	return nil
}

// argsRequestBackground is argsRequestJSON's counterpart: a cheap pre-scan
// for "-background"/"--background" in argv, used only to route
// runHeadless to runHeadlessBackground before any flag set is built --
// the two paths take different flags (--background has no --thread or
// --yes, for instance) and must not share one FlagSet.
func argsRequestBackground(args []string) bool {
	for _, a := range args {
		name, _, _ := strings.Cut(a, "=")
		if name == "-background" || name == "--background" {
			return true
		}
	}
	return false
}
