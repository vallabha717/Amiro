package main

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"amiro/backend/internal/agent/session"
	bifrostai "amiro/backend/internal/ai/bifrost"
	chatapi "amiro/backend/internal/api/chat"
)

// This file is the Phase 6 backend gate: "amiro run exit codes; --json log
// schema test." runOutputFrom and exitCode() are deliberately pure --
// separated out of runHeadless specifically so these properties can be
// checked without a live model (chat.RunTurn itself needs one, which this
// sandbox does not have) and without os.Exit killing the test process.

func TestSplitProviderModel_WithProvider(t *testing.T) {
	provider, model := splitProviderModel("anthropic/claude-sonnet-5")
	if provider != "anthropic" || model != "claude-sonnet-5" {
		t.Fatalf("splitProviderModel = (%q, %q), want (anthropic, claude-sonnet-5)", provider, model)
	}
}

func TestSplitProviderModel_BareModelHasNoProvider(t *testing.T) {
	provider, model := splitProviderModel("claude-sonnet-5")
	if provider != "" || model != "claude-sonnet-5" {
		t.Fatalf("splitProviderModel = (%q, %q), want (\"\", claude-sonnet-5)", provider, model)
	}
}

// TestRunOutputFrom_CleanFinish is the ordinary case: a turn that produced
// text and never suspended reports Suspended=false, no Error, exit 0.
func TestRunOutputFrom_CleanFinish(t *testing.T) {
	log := session.NewLog()
	log.Record(
		session.Action{Kind: session.ActionMessage, Step: 0, Text: "hello"},
		session.Observation{Status: session.StatusOK},
	)
	result := chatapi.TurnResult{
		ResponseID: "resp-1",
		Text:       "hello",
		Steps:      1,
		Usage:      &bifrostai.Usage{TotalTokens: 42},
		ToolCount:  0,
		DurationMS: 100,
		Log:        log,
	}

	out := runOutputFrom("thread-1", result, nil)

	if out.ThreadID != "thread-1" || out.ResponseID != "resp-1" || out.Text != "hello" {
		t.Fatalf("out = %+v, want thread/response/text carried through verbatim", out)
	}
	if out.Suspended || out.Approval != nil {
		t.Fatalf("out.Suspended=%v out.Approval=%v, want false/nil for a clean finish", out.Suspended, out.Approval)
	}
	if out.Error != "" {
		t.Fatalf("out.Error = %q, want empty", out.Error)
	}
	if len(out.Log) != 1 {
		t.Fatalf("out.Log has %d events, want 1 (the log dump this phase exists for)", len(out.Log))
	}
	if code := out.exitCode(); code != 0 {
		t.Fatalf("exitCode() = %d, want 0", code)
	}
}

// TestRunOutputFrom_SuspendedForApproval is the case amiro run --yes exists
// for: a gated call suspended, nobody answered, and that has to be
// distinguishable from both success and a hard failure.
func TestRunOutputFrom_SuspendedForApproval(t *testing.T) {
	log := session.NewLog()
	approval := map[string]any{"toolCallId": "call-1", "toolName": "run_shell", "risk": "write"}
	log.Record(
		session.Action{Kind: session.ActionTool, Step: 0, Tool: "run_shell", ToolID: "call-1"},
		session.Observation{Status: session.StatusDenied, Suspended: true, Approval: approval},
	)
	result := chatapi.TurnResult{ResponseID: "resp-1", Log: log}

	out := runOutputFrom("thread-1", result, nil)

	if !out.Suspended {
		t.Fatalf("out.Suspended = false, want true")
	}
	if out.Approval["toolCallId"] != "call-1" {
		t.Fatalf("out.Approval = %+v, want the suspended call's approval payload", out.Approval)
	}
	if out.Error != "" {
		t.Fatalf("out.Error = %q, want empty -- RunTurn did not fail, it suspended", out.Error)
	}
	if code := out.exitCode(); code != 2 {
		t.Fatalf("exitCode() = %d, want 2 (suspended, distinct from both success and failure)", code)
	}
}

// TestRunOutputFrom_RunTurnError covers RunTurn returning an error outright
// (bad thread ownership, a transport failure) -- distinct from suspension,
// and must win exit-code precedence even in the (never actually reachable,
// since a RunTurn error means TurnResult is the zero value) case both are
// somehow set.
func TestRunOutputFrom_RunTurnError(t *testing.T) {
	out := runOutputFrom("thread-1", chatapi.TurnResult{}, errors.New("boom"))

	if out.Error != "boom" {
		t.Fatalf("out.Error = %q, want %q", out.Error, "boom")
	}
	if out.Suspended {
		t.Fatalf("out.Suspended = true, want false for a zero-value TurnResult")
	}
	if code := out.exitCode(); code != 1 {
		t.Fatalf("exitCode() = %d, want 1", code)
	}
}

// TestRunOutputFrom_NilLogIsSafe is the "runErr means TurnResult{} which
// means Log is nil" case runOutputFrom's own doc comment names -- session.Log
// tolerates a nil receiver, but this pins that runOutputFrom itself never
// panics or needs a special case for it.
func TestRunOutputFrom_NilLogIsSafe(t *testing.T) {
	out := runOutputFrom("thread-1", chatapi.TurnResult{}, errors.New("setup failed"))
	if out.Log != nil {
		t.Fatalf("out.Log = %v, want nil for a turn that never ran", out.Log)
	}
}

// TestRunOutput_JSONSchema is the Phase 6 backend gate's "--json log schema
// test": amiro run --json's whole purpose is a script piping it to `jq`, so
// the field names and the log's shape are a contract, not an implementation
// detail. This locks the exact top-level keys and that "log" is
// session.Event's own JSON shape (action/observation), not a flattened
// summary of it.
func TestRunOutput_JSONSchema(t *testing.T) {
	log := session.NewLog()
	log.Record(
		session.Action{Kind: session.ActionTool, Step: 0, Tool: "run_shell", ToolID: "call-1"},
		session.Observation{Status: session.StatusOK, Summary: "ran"},
	)
	out := runOutputFrom("thread-1", chatapi.TurnResult{
		ResponseID: "resp-1", Text: "done", Steps: 2, ToolCount: 1, DurationMS: 500,
		Usage: &bifrostai.Usage{TotalTokens: 10}, Log: log,
	}, nil)

	b, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	for _, key := range []string{"threadId", "responseId", "text", "steps", "toolCount", "durationMs", "usage", "log"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("--json output missing key %q: %s", key, b)
		}
	}
	// A clean finish must not carry suspended/approval/error keys at all --
	// omitempty is load-bearing here: a script checking `.error` or
	// `.suspended` with jq should see them absent, not present-and-false or
	// present-and-null, on the common case.
	for _, key := range []string{"suspended", "approval", "error"} {
		if _, ok := decoded[key]; ok {
			t.Fatalf("--json output has key %q on a clean finish, want it omitted entirely: %s", key, b)
		}
	}

	var events []struct {
		Action struct {
			Kind string `json:"kind"`
			Tool string `json:"tool"`
		} `json:"action"`
		Observation struct {
			Status string `json:"status"`
		} `json:"observation"`
	}
	if err := json.Unmarshal(decoded["log"], &events); err != nil {
		t.Fatalf("decode log: %v", err)
	}
	if len(events) != 1 || events[0].Action.Tool != "run_shell" || events[0].Observation.Status != "ok" {
		t.Fatalf("log = %+v, want the one run_shell event, verbatim from session.Event's own shape", events)
	}
}

// TestRunOutput_JSONSchema_SuspendedIncludesApproval is the other half of
// the schema contract: when a turn suspends, `.suspended` and `.approval`
// must actually appear so a script can act on them without falling back to
// scanning the log itself.
func TestRunOutput_JSONSchema_SuspendedIncludesApproval(t *testing.T) {
	log := session.NewLog()
	log.Record(
		session.Action{Kind: session.ActionTool, Step: 0, Tool: "run_shell", ToolID: "call-1"},
		session.Observation{Status: session.StatusDenied, Suspended: true, Approval: map[string]any{"toolCallId": "call-1"}},
	)
	out := runOutputFrom("thread-1", chatapi.TurnResult{Log: log}, nil)

	b, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if _, ok := decoded["suspended"]; !ok {
		t.Fatalf("--json output missing \"suspended\" on a suspended turn: %s", b)
	}
	if _, ok := decoded["approval"]; !ok {
		t.Fatalf("--json output missing \"approval\" on a suspended turn: %s", b)
	}
}

// TestPartitionRunArgs_FlagsTrailThePrompt is the exact bug this phase's
// own manual smoke test found: Appendix A documents amiro run's flags
// *after* the prompt ("amiro run \"<prompt>\" [--json] [--yes]"), but Go's
// flag package stops parsing at the first non-flag argument -- a plain
// fs.Parse(args) against that exact invocation would silently fold --json
// into the prompt text instead of recognizing it.
func TestPartitionRunArgs_FlagsTrailThePrompt(t *testing.T) {
	flagArgs, promptWords := partitionRunArgs([]string{"say", "hello", "--json", "--yes"})
	if !reflect.DeepEqual(promptWords, []string{"say", "hello"}) {
		t.Fatalf("promptWords = %v, want [say hello]", promptWords)
	}
	if !reflect.DeepEqual(flagArgs, []string{"--json", "--yes"}) {
		t.Fatalf("flagArgs = %v, want [--json --yes]", flagArgs)
	}
}

func TestPartitionRunArgs_FlagsLeadThePrompt(t *testing.T) {
	flagArgs, promptWords := partitionRunArgs([]string{"--json", "--mode", "plan", "say", "hello"})
	if !reflect.DeepEqual(promptWords, []string{"say", "hello"}) {
		t.Fatalf("promptWords = %v, want [say hello]", promptWords)
	}
	if !reflect.DeepEqual(flagArgs, []string{"--json", "--mode", "plan"}) {
		t.Fatalf("flagArgs = %v, want [--json --mode plan]", flagArgs)
	}
}

func TestPartitionRunArgs_FlagsInterleaved(t *testing.T) {
	flagArgs, promptWords := partitionRunArgs([]string{"say", "--mode", "plan", "hello", "--json"})
	if !reflect.DeepEqual(promptWords, []string{"say", "hello"}) {
		t.Fatalf("promptWords = %v, want [say hello]", promptWords)
	}
	if !reflect.DeepEqual(flagArgs, []string{"--mode", "plan", "--json"}) {
		t.Fatalf("flagArgs = %v, want [--mode plan --json]", flagArgs)
	}
}

// TestPartitionRunArgs_EqualsFormDoesNotConsumeTheNextWord covers
// --model=anthropic/claude-sonnet-5 (one token, no following value to
// swallow) against a value-taking flag, so the next positional word is not
// mistakenly pulled into flagArgs.
func TestPartitionRunArgs_EqualsFormDoesNotConsumeTheNextWord(t *testing.T) {
	flagArgs, promptWords := partitionRunArgs([]string{"--model=anthropic/claude-sonnet-5", "say", "hello"})
	if !reflect.DeepEqual(promptWords, []string{"say", "hello"}) {
		t.Fatalf("promptWords = %v, want [say hello]", promptWords)
	}
	if !reflect.DeepEqual(flagArgs, []string{"--model=anthropic/claude-sonnet-5"}) {
		t.Fatalf("flagArgs = %v, want [--model=anthropic/claude-sonnet-5]", flagArgs)
	}
}

func TestArgsRequestJSON(t *testing.T) {
	if argsRequestJSON([]string{"say", "hello"}) {
		t.Fatalf("argsRequestJSON = true, want false with no --json present")
	}
	if !argsRequestJSON([]string{"say", "hello", "--json"}) {
		t.Fatalf("argsRequestJSON = false, want true")
	}
	if !argsRequestJSON([]string{"--json=true", "say", "hello"}) {
		t.Fatalf("argsRequestJSON = false, want true for --json=true")
	}
}

func TestExitCode_Table(t *testing.T) {
	cases := []struct {
		name string
		out  runOutput
		want int
	}{
		{"clean finish", runOutput{}, 0},
		{"error", runOutput{Error: "boom"}, 1},
		{"suspended", runOutput{Suspended: true}, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.out.exitCode(); got != c.want {
				t.Fatalf("exitCode() = %d, want %d", got, c.want)
			}
		})
	}
}
