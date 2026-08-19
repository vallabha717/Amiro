package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"amiro/backend/internal/agent/session"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/uimessage"
	chatapi "amiro/backend/internal/api/chat"
	"amiro/backend/internal/appwiring"
	"amiro/backend/internal/config"
	"amiro/backend/internal/db/models"
)

// runOutput is amiro run --json's schema -- the whole point of the flag
// (plan Appendix A: "amiro run \"<prompt>\" [--json] [--yes]", and the
// plan's own opening line for this phase, "--json dumping the
// session.Log"). It is also what the plain-text printer and the exit code
// both read from, so there is exactly one place that decides what a turn
// "meant", however it gets displayed.
type runOutput struct {
	ThreadID   string           `json:"threadId"`
	ResponseID string           `json:"responseId,omitempty"`
	Text       string           `json:"text,omitempty"`
	Steps      int              `json:"steps,omitempty"`
	ToolCount  int              `json:"toolCount,omitempty"`
	DurationMS int64            `json:"durationMs,omitempty"`
	Usage      *bifrostai.Usage `json:"usage,omitempty"`

	// Suspended and Approval mirror session.Observation's own fields: the
	// turn stopped on a gated call with nobody to ask (no --yes), the exact
	// state RunTurn already leaves a browser or the TUI to render as an
	// approval dialog -- amiro run has no dialog, so it reports the same
	// fact and exits distinctly instead.
	Suspended bool           `json:"suspended,omitempty"`
	Approval  map[string]any `json:"approval,omitempty"`

	// Log is internal/agent/session's own record of the turn, verbatim --
	// this is the "--json dumping the session.Log" the plan asks for, not a
	// second summary of it.
	Log []session.Event `json:"log,omitempty"`

	Error string `json:"error,omitempty"`
}

// exitCode is amiro run's contract with a script (plan Part 5: "amiro run
// exit codes"):
//
//	0  the turn completed -- RunTurn returned no error and nothing suspended
//	1  RunTurn itself failed (bad thread ownership, a model/transport error)
//	2  the turn suspended on a gated call with no one to ask (no --yes)
//
// 2 is distinct from 1 on purpose: "crashed" and "needs --yes or a human"
// are different things for a CI script to react to, and conflating them is
// exactly the ambiguity --yes exists to let a script route around.
func (o runOutput) exitCode() int {
	switch {
	case o.Error != "":
		return 1
	case o.Suspended:
		return 2
	default:
		return 0
	}
}

// suspendedOn scans a turn's log for the one fact amiro run cares about:
// did anything stop waiting on an answer nobody headless can give.
// log.Events() is nil-receiver-safe (session.Log's own doc comment), so a
// zero-value TurnResult from a RunTurn error -- Log is nil -- is handled
// with no special case here.
func suspendedOn(log *session.Log) (approval map[string]any, suspended bool) {
	for _, e := range log.Events() {
		if e.Observation != nil && e.Observation.Suspended {
			return e.Observation.Approval, true
		}
	}
	return nil, false
}

// runOutputFrom builds amiro run's result from what chat.RunTurn actually
// returned. Pure and separated from runHeadless on purpose: RunTurn itself
// needs a live model this sandbox does not have, but the schema this phase
// asks for -- suspension detection, the log dump, the exit code -- has
// nothing to do with the model and is fully testable without one.
func runOutputFrom(threadID string, result chatapi.TurnResult, runErr error) runOutput {
	approval, suspended := suspendedOn(result.Log)
	out := runOutput{
		ThreadID:   threadID,
		ResponseID: result.ResponseID,
		Text:       result.Text,
		Steps:      result.Steps,
		ToolCount:  result.ToolCount,
		DurationMS: result.DurationMS,
		Usage:      result.Usage,
		Suspended:  suspended,
		Approval:   approval,
		Log:        result.Log.Events(),
	}
	if runErr != nil {
		out.Error = runErr.Error()
	}
	return out
}

// splitProviderModel parses --model's "provider/model" shape, mirroring
// internal/tui/config's own parseModel: a value with no "/" is a bare model
// name, which bifrostai.Resolve already treats as "use this model on
// whichever provider serves it." Kept local rather than exported from
// internal/tui/config for one extra caller -- the same three-lines-beats-
// an-abstraction call this tree already made once for this exact logic.
func splitProviderModel(s string) (provider, model string) {
	if p, m, ok := strings.Cut(s, "/"); ok {
		return p, m
	}
	return "", s
}

// runFlagTakesValue names amiro run's flags that consume the next argument
// as their value ("-mode" and "--mode" are both spelled out since Go's flag
// package accepts either dash form for the same name). Bool flags (--json,
// --yes) are deliberately absent: they never consume a following token.
var runFlagTakesValue = map[string]bool{
	"-C": true, "--C": true,
	"-mode": true, "--mode": true,
	"-model": true, "--model": true,
	"-thread": true, "--thread": true,
}

// partitionRunArgs splits amiro run's argv into flags (and their values)
// and everything else, which is joined into the prompt -- regardless of
// where in argv the flags fall.
//
// This exists because Go's flag package stops parsing at the first
// non-flag argument, and Appendix A documents amiro run's flags *trailing*
// the prompt: `amiro run "<prompt>" [--json] [--yes]`. A plain fs.Parse(args)
// against that exact documented invocation would see "<prompt>" first,
// stop right there, and silently fold "--json"/"--yes" into the prompt
// text instead of parsing them -- found live, running this phase's own
// manual smoke test: --json produced no JSON at all, because it was never
// actually recognized as a flag.
func partitionRunArgs(args []string) (flagArgs, promptWords []string) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			promptWords = append(promptWords, a)
			continue
		}
		flagArgs = append(flagArgs, a)
		name, _, hasValue := strings.Cut(a, "=")
		if !hasValue && runFlagTakesValue[name] && i+1 < len(args) {
			i++
			flagArgs = append(flagArgs, args[i])
		}
	}
	return flagArgs, promptWords
}

// runHeadlessTurn does everything runHeadless needs except printing and
// exiting: parse flags, stand up a backend, resolve an identity, and run
// exactly one turn through chat.RunTurn directly -- the in-process path
// plan §2.2 carves out for "amiro run (Phase 6) and the eval harness, which
// genuinely have no client. RunTurn serves both." There is no attach-or-
// embed choice and no --connect here: amiro run always owns the App it
// just built, for exactly this one turn's lifetime.
//
// Returns a non-nil error only for something that happened *before* a turn
// could be attempted (bad flags, config, or backend startup) -- runHeadless
// treats that the same way every other subcommand's setup failure is
// treated. Once chat.RunTurn is actually called, its outcome (success,
// failure, or suspension) is folded into the returned runOutput instead, so
// a script piping --json always gets one well-formed JSON value on stdout
// regardless of which of those three happened.
func runHeadlessTurn(ctx context.Context, args []string) (out runOutput, jsonOut bool, err error) {
	flagArgs, promptWords := partitionRunArgs(args)

	fs := flag.NewFlagSet("amiro run", flag.ContinueOnError)
	dir := fs.String("C", "", "run as though launched from dir")
	mode := fs.String("mode", "", "permission mode: plan, interactive, edit, or auto (default: interactive)")
	modelFlag := fs.String("model", "", "provider/model to use, e.g. anthropic/claude-sonnet-5 (default: the server's own default)")
	threadID := fs.String("thread", "", "run inside an existing thread by id, instead of starting a new one")
	jsonFlag := fs.Bool("json", false, "print the turn's result -- text, usage, and the full session.Log -- as one JSON object on stdout, instead of streaming text")
	yes := fs.Bool("yes", false, "auto-approve every gated tool call; without it, a gated call suspends the turn (exit code 2) since there is no one to ask")
	if err := fs.Parse(flagArgs); err != nil {
		return runOutput{}, false, err
	}
	if len(promptWords) == 0 {
		return runOutput{}, *jsonFlag, fmt.Errorf(`usage: amiro run "<prompt>" [--json] [--yes]`)
	}
	prompt := strings.Join(promptWords, " ")

	if *mode != "" && !validModes[*mode] {
		return runOutput{}, *jsonFlag, fmt.Errorf("--mode must be one of plan, interactive, edit, auto (got %q)", *mode)
	}

	workspaceRoot := *dir
	if workspaceRoot == "" {
		workspaceRoot = "."
	}
	workspaceRoot, err = filepath.Abs(workspaceRoot)
	if err != nil {
		return runOutput{}, *jsonFlag, fmt.Errorf("resolving workspace root: %w", err)
	}

	cfg, err := config.Load()
	if err != nil {
		return runOutput{}, *jsonFlag, fmt.Errorf("config: %w", err)
	}
	cfg.WorkspaceRoot = workspaceRoot

	app, err := appwiring.New(ctx, cfg)
	if err != nil {
		return runOutput{}, *jsonFlag, fmt.Errorf("starting backend: %w", err)
	}
	defer app.Close()

	user, err := resolveHeadlessUser(ctx, cfg, app)
	if err != nil {
		return runOutput{}, *jsonFlag, err
	}

	id := *threadID
	if id == "" {
		id = models.NewID()
	}

	req := chatapi.NewTextTurn(user, id, prompt).WithWorkspace(workspaceRoot)
	if *mode != "" {
		req = req.WithPermissionMode(*mode)
	}
	if *modelFlag != "" {
		provider, model := splitProviderModel(*modelFlag)
		req = req.WithModel(provider, model)
	}

	turnCtx := ctx
	if *yes {
		turnCtx = chatapi.WithApprover(turnCtx, chatapi.AutoApprove)
	}

	var emitter uimessage.Emitter = uimessage.NewDiscardWriter()
	if !*jsonFlag {
		emitter = textEmitter{}
	}
	capturing := &errorCapturingEmitter{Emitter: emitter}

	result, runErr := app.Chat.RunTurn(turnCtx, req, capturing)
	if runErr == nil && capturing.err != "" {
		// RunTurn's own contract (runner.go's doc comment): a failure
		// *after* streaming starts -- a model call with no configured
		// provider key, a timeout -- is written into the stream as an
		// Error(...) frame, not returned as a Go error; the turn still
		// returns (TurnResult{}, nil), the same as a genuinely clean
		// finish. A browser or the TUI renders that frame; amiro run has
		// no stream to render it on, so without this it would print
		// nothing wrong and exit 0 on a turn that never actually ran.
		runErr = fmt.Errorf("%s", capturing.err)
	}
	return runOutputFrom(id, result, runErr), *jsonFlag, nil
}

// errorCapturingEmitter wraps another Emitter and remembers the last
// Error(...) frame it saw, forwarding everything to the wrapped Emitter
// unchanged. See runHeadlessTurn's own comment on why this exists: it is
// the only way amiro run can learn that a turn failed mid-stream, since
// RunTurn does not return that as a Go error.
type errorCapturingEmitter struct {
	uimessage.Emitter
	err string
}

func (e *errorCapturingEmitter) Error(errText string) error {
	e.err = errText
	return e.Emitter.Error(errText)
}

// resolveHeadlessUser resolves the identity amiro run acts as, entirely
// in-process -- there is no client here at all (chat.RunTurn is called
// directly), so this mirrors resolveSession's rule without any of its HTTP:
// a stored session wins when it still validates, and only then does this
// fall back to the desktop-default account. Both branches are the
// "this process owns the backend it's talking to" case resolveSession's own
// doc comment allows auto-provisioning for -- amiro run has no attach-or-
// embed choice and no --connect; it always owns the App it just built for
// this one turn.
func resolveHeadlessUser(ctx context.Context, cfg config.Config, app *appwiring.App) (*models.User, error) {
	store := secretsStore(cfg)

	if token, ok, err := store.Get(ctx, sessionSecretKey); err == nil && ok {
		if user, _, err := app.Auth.ValidateSession(ctx, token); err == nil {
			return user, nil
		}
		// Stale token (expired session, deleted account) -- fall through to
		// the desktop-default account, same as resolveSession does.
	}

	user, sess, err := app.Auth.EnsureDesktopDefaultUser(ctx)
	if err != nil {
		return nil, fmt.Errorf("provisioning local user: %w", err)
	}
	if err := store.Set(ctx, sessionSecretKey, sess.Token); err != nil {
		fmt.Fprintf(os.Stderr, "amiro: could not remember this session: %v\n", err)
	}
	return user, nil
}

// textEmitter is amiro run's default (non---json) Emitter. There is no
// client and no terminal UI here -- only a script or a person watching
// stdout -- so it streams exactly the assistant's words as they arrive (the
// one thing a one-shot CLI prompt is for) and puts everything else where a
// shell pipeline expects incidental output to go: stderr, or nowhere. In
// --json mode this is swapped for uimessage.NewDiscardWriter() instead, so
// no partial text ever lands on stdout ahead of the one JSON value a script
// piping --json expects there.
type textEmitter struct{}

func (textEmitter) Start(string) error     { return nil }
func (textEmitter) Finish(any) error       { return nil }
func (textEmitter) Done() error            { return nil }
func (textEmitter) StartStep() error       { return nil }
func (textEmitter) FinishStep() error      { return nil }
func (textEmitter) TextStart(string) error { return nil }
func (textEmitter) TextDelta(_, delta string) error {
	fmt.Print(delta)
	return nil
}
func (textEmitter) TextEnd(string) error                { return nil }
func (textEmitter) ReasoningStart(string) error         { return nil }
func (textEmitter) ReasoningDelta(string, string) error { return nil }
func (textEmitter) ReasoningEnd(string) error           { return nil }
func (textEmitter) ToolInputStart(_, name string) error {
	fmt.Fprintf(os.Stderr, "\n→ %s\n", name)
	return nil
}
func (textEmitter) ToolInputDelta(string, string) error          { return nil }
func (textEmitter) ToolInputAvailable(string, string, any) error { return nil }
func (textEmitter) ToolOutputAvailable(string, any) error        { return nil }
func (textEmitter) ToolOutputError(_, errText string) error {
	fmt.Fprintf(os.Stderr, "  tool error: %s\n", errText)
	return nil
}
func (textEmitter) Data(name string, _ string, data any) error {
	if name == "tool-approval" {
		fmt.Fprintf(os.Stderr, "\n⧗ waiting for approval: %v\n", data)
	}
	return nil
}
func (textEmitter) Error(errText string) error {
	fmt.Fprintln(os.Stderr, "amiro run: "+errText)
	return nil
}

var _ uimessage.Emitter = textEmitter{}

// argsRequestJSON is a cheap pre-scan for "-json"/"--json" in argv, used
// only to decide whether to suppress stdout for the call (below) --
// runHeadlessTurn's own flag.FlagSet remains the actual source of truth
// for parsing and validation.
func argsRequestJSON(args []string) bool {
	for _, a := range args {
		name, _, _ := strings.Cut(a, "=")
		if name == "-json" || name == "--json" {
			return true
		}
	}
	return false
}

// withStdoutSuppressed runs fn with os.Stdout redirected to a drain nobody
// reads, when suppress is true.
//
// Needed because bifrost's own internal logger (internal/ai/bifrost's
// NewClient leaves schemas.BifrostConfig.Logger nil, so bifrost.Init falls
// back to its default) writes structured JSON straight to os.Stdout at
// Info level -- found live, piping amiro run --json's actual output
// through jq for this phase's own manual smoke test: several unrelated
// `{"level":"info",...}` lines landed on stdout ahead of amiro run's own
// one JSON result, which breaks "one JSON value on stdout" for any script
// consuming it. Reconfiguring that logger globally belongs to
// internal/ai/bifrost, if anywhere -- it would change cmd/server's and the
// embedded TUI server's own startup logs too, well outside this phase's
// scope. Redirecting os.Stdout for the lifetime of this one call is
// contained entirely to amiro run --json and touches nothing else.
func withStdoutSuppressed(suppress bool, fn func()) {
	if !suppress {
		fn()
		return
	}
	real := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		fn()
		return
	}
	os.Stdout = w
	drained := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, r)
		close(drained)
	}()
	fn()
	os.Stdout = real
	w.Close()
	<-drained
	r.Close()
}

// runHeadless is `amiro run "<prompt>"`'s actual CLI entrypoint: run the
// turn, print the result the way --json asked for, and exit with the code
// runOutput.exitCode() computes. Kept thin and un-tested directly on
// purpose -- os.Exit here would kill a test process outright, which is
// exactly why runHeadlessTurn and runOutput.exitCode() exist as separate,
// pure pieces a test can drive instead.
func runHeadless(args []string) error {
	var out runOutput
	var jsonOut bool
	var err error
	withStdoutSuppressed(argsRequestJSON(args), func() {
		out, jsonOut, err = runHeadlessTurn(context.Background(), args)
	})
	if err != nil {
		return err
	}

	if jsonOut {
		b, encErr := json.Marshal(out)
		if encErr != nil {
			return fmt.Errorf("encoding result: %w", encErr)
		}
		fmt.Println(string(b))
	} else {
		if out.Text != "" {
			fmt.Println()
		}
		switch {
		case out.Error != "":
			fmt.Fprintln(os.Stderr, "amiro run: "+out.Error)
		case out.Suspended:
			fmt.Fprintln(os.Stderr, "amiro run: turn suspended, waiting for an approval nobody can give headlessly -- rerun with --yes to auto-approve")
		}
	}

	if code := out.exitCode(); code != 0 {
		os.Exit(code)
	}
	return nil
}
