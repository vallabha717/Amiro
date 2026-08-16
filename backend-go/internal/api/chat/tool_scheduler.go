package chat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"amiro/backend/internal/agent/permission"
	"amiro/backend/internal/agent/session"
	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/ai/tools"
	"amiro/backend/internal/ai/uimessage"
)

// maxParallelToolCalls bounds how many side-effect-free tool calls may be
// in flight at once within a single model step. The ceiling exists so a
// model that asks for thirty file reads doesn't open thirty concurrent
// descriptors (or thirty outbound HTTP requests) at the same instant; eight
// is enough to hide latency on the case this is for -- a handful of reads
// or searches issued together -- without behaving like a load generator.
//
// A var, not a const, so tests can pin it to 1 and assert the sequential
// path still produces identical results.
var maxParallelToolCalls = 8

// toolSlot is one tool call's reserved position in a step's result order.
//
// The slot is appended the moment the call is offered -- before it runs --
// which is what lets results be merged back in the model's original call
// order no matter which execution finishes first. Nothing outside the
// goroutine that owns a slot writes to `outcome`, and Finish only reads
// them after the WaitGroup has closed, so no lock guards it.
type toolSlot struct {
	tc      bifrostai.ToolCall
	def     tools.Definition
	input   json.RawMessage
	outcome toolCallOutcome

	// logAt is this call's reserved position in the event log, taken at
	// offer time for exactly the same reason the slot itself is: a parallel
	// call that recorded itself when its goroutine got scheduled would put
	// the log in start order rather than call order, and a log that
	// reorders between runs of one deterministic turn is useless for the
	// comparison the eval harness exists to make. -1 means unrecorded.
	logAt int
}

// toolScheduler resolves one model step's tool calls: it overlaps the calls
// that declared themselves side-effect-free (tools.Parallel) and keeps
// every other call strictly in the order the model emitted it.
//
// Two properties are load-bearing and easy to lose:
//
//   - Tool *input* frames are still written the instant a call's arguments
//     finish streaming, so cards appear on screen while the model is still
//     writing the next call -- the reason StepHooks.OnToolCallReady exists.
//     Only execution is deferred or overlapped, never the input frame.
//   - Results are merged in call order, not completion order. Feeding the
//     model a history whose tool results shuffle run to run makes its own
//     reasoning non-reproducible, which is a far worse trade than the
//     latency parallelism buys back.
type toolScheduler struct {
	sw          *uimessage.Writer
	activeTools []tools.Definition

	// perms decides allow / deny / ask for every call before it runs. Never
	// nil -- a nil engine would be a scheduler that silently executes
	// everything, which is precisely the state this package was in before
	// Phase 3, so the constructor takes it as a required argument rather
	// than leaving it settable after the fact.
	perms *permission.Engine

	// swMu serializes writes to the stream writer, which is a single SSE
	// connection and not safe for concurrent use. Parallel executions emit
	// their own output frames as they land, so without this two tools
	// finishing together can interleave mid-frame and corrupt the stream.
	swMu sync.Mutex

	sem chan struct{}
	wg  sync.WaitGroup

	slots   []*toolSlot
	seen    map[string]bool
	pending []*toolSlot // Sequential calls, drained in order after the stream

	// paused records that a call was offered which this turn cannot
	// resolve on its own -- either a client-executed tool (nil Execute) or
	// one the permission engine wants a human to approve. Generation stops
	// there: the frontend has to resubmit with a result before anything
	// else can run, so later calls in the same step are dropped rather than
	// executed against a history that will never contain their sibling's
	// result.
	paused bool

	// approvals are the parts describing calls this step suspended for
	// approval, in call order. runToolLoop appends them to the persisted
	// message so the approval card survives a reload -- an approval prompt
	// that disappears when the user refreshes is worse than no prompt,
	// because the turn is then stuck with nothing on screen explaining why.
	approvals []map[string]any

	// log records what each call did, for the eval harness and for anything
	// that needs to reason about a turn as actions rather than as message
	// frames (internal/agent/session). Nil is a valid zero -- every method
	// on *session.Log tolerates it -- so the many existing call sites that
	// do not care carry no burden.
	log  *session.Log
	step int
}

func newToolScheduler(sw *uimessage.Writer, activeTools []tools.Definition, perms *permission.Engine) *toolScheduler {
	return &toolScheduler{
		sw:          sw,
		activeTools: activeTools,
		perms:       perms,
		sem:         make(chan struct{}, maxParallelToolCalls),
		seen:        map[string]bool{},
	}
}

// withLog attaches an event log for the given step. Chained from the loop
// rather than passed to the constructor: the log is optional and the
// constructor already takes three required arguments.
func (s *toolScheduler) withLog(l *session.Log, step int) *toolScheduler {
	s.log, s.step = l, step
	return s
}

// note records an action/observation pair for a call that never reached
// execute -- an unknown tool, a refusal, a suspension.
func (s *toolScheduler) note(sl *toolSlot, status session.ObservationStatus, summary, errText string) {
	s.log.Record(s.action(sl), session.Observation{Status: status, Summary: summary, Error: errText})
}

func (s *toolScheduler) action(sl *toolSlot) session.Action {
	return session.Action{
		Kind: session.ActionTool, Step: s.step,
		Tool: sl.tc.Name, ToolID: sl.tc.ID, Input: sl.input,
		Risk:     sl.def.Risk.String(),
		Parallel: sl.def.Concurrency() == tools.Parallel,
	}
}

// Offer submits one tool call. It is called from the stream goroutine --
// both from StepHooks.OnToolCallReady mid-stream and from the post-step
// sweep -- and never concurrently with itself.
//
// It returns immediately for parallel tools (execution continues in the
// background) and queues sequential ones for Finish to drain.
func (s *toolScheduler) Offer(ctx context.Context, tc bifrostai.ToolCall) {
	if s.paused || tc.ID == "" || s.seen[tc.ID] {
		return
	}
	s.seen[tc.ID] = true

	input := json.RawMessage(tc.Arguments)
	// A call finalized mid-stream can still carry truncated JSON if a
	// provider interleaved indices; fall back rather than emit invalid input.
	if len(input) == 0 || !json.Valid(input) {
		input = json.RawMessage("{}")
	}

	sl := &toolSlot{tc: tc, input: input, logAt: -1}
	s.slots = append(s.slots, sl)

	def, found := tools.FindByName(s.activeTools, tc.Name)

	s.emitInput(tc, input)

	// A tool name the model invented/mis-typed and one this turn genuinely
	// offered but left client-executed (nil Execute -- e.g. code.go's
	// JS/Python tools) look similar but are not: the latter is a real,
	// expected pause (the frontend resubmits with a result, matching the TS
	// route's sendAutomaticallyWhen). !found has no such contract on either
	// side -- nothing will ever resubmit for it. Found live: a model called
	// a plausible-but-nonexistent MCP tool name, and treating it as the same
	// "pause and wait" case left the chat stuck forever with no way to
	// recover (Stop included, since the request had already completed
	// normally from the server's point of view).
	if !found {
		errMsg := "unknown tool: " + tc.Name
		s.emitError(tc.ID, errMsg)
		sl.outcome = errorOutcome(tc, input, errMsg)
		s.note(sl, session.StatusError, "", errMsg)
		return
	}

	sl.def = def

	// Policy runs before dispatch, and before the client-tool branch below:
	// whether the agent may do a thing does not depend on which side of the
	// wire ends up doing it.
	switch d := s.perms.Evaluate(permission.CallFor(def, input)); {
	case d.Allowed:
		// fall through to execution
	case d.NeedsUser:
		s.suspendForApproval(sl, d)
		return
	default:
		// A refusal is fed back to the model as the tool's result rather
		// than surfaced as a stream error, because it is one: the call was
		// answered, just not the way the model hoped. A model that sees
		// "plan mode is read-only" in a tool result adapts within the same
		// turn; a stream error ends the turn with nothing useful said.
		s.emitError(tc.ID, d.Reason)
		sl.outcome = errorOutcome(tc, input, d.Reason)
		s.note(sl, session.StatusDenied, "", d.Reason)
		return
	}

	if def.Execute == nil {
		sl.outcome = toolCallOutcome{
			part: map[string]any{
				"type": "tool-" + tc.Name, "toolCallId": tc.ID, "state": "input-available", "input": input,
			},
			pauseForClient: true,
		}
		s.paused = true
		s.note(sl, session.StatusOK, "handed to the client to execute", "")
		return
	}

	// Reserved here, in call order, and closed later by whichever goroutine
	// ends up running it.
	sl.logAt = s.log.Start(s.action(sl))

	if def.Concurrency() == tools.Parallel {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			select {
			case s.sem <- struct{}{}:
				defer func() { <-s.sem }()
			case <-ctx.Done():
				sl.outcome = errorOutcome(sl.tc, sl.input, ctx.Err().Error())
				s.emitError(sl.tc.ID, ctx.Err().Error())
				s.log.Observe(sl.logAt, session.Observation{Status: session.StatusError, Error: ctx.Err().Error()})
				return
			}
			s.execute(ctx, sl)
		}()
		return
	}

	s.pending = append(s.pending, sl)
}

// Finish drains the sequential queue in call order, waits for every
// in-flight parallel call, and returns each slot's outcome in the order the
// model originally emitted the calls.
func (s *toolScheduler) Finish(ctx context.Context) []toolCallOutcome {
	for _, sl := range s.pending {
		s.execute(ctx, sl)
	}
	s.pending = nil
	s.wg.Wait()

	out := make([]toolCallOutcome, 0, len(s.slots))
	for _, sl := range s.slots {
		out = append(out, sl.outcome)
	}
	return out
}

// Paused reports whether a client-executed tool or a pending approval
// stopped this step.
func (s *toolScheduler) Paused() bool { return s.paused }

// Approvals returns the approval-request parts this step produced, in call
// order.
func (s *toolScheduler) Approvals() []map[string]any { return s.approvals }

// approvalDataPart is the name of the data part carrying an approval
// request. The frontend keys off `data-` + this.
const approvalDataPart = "tool-approval"

// suspendForApproval stops the turn on a call the user has to bless first.
//
// The mechanics are deliberately the same as the client-executed-tool pause
// that already existed: the tool call is left in "input-available", the
// loop stops, and the frontend resubmits the assistant message once it has
// an answer. That rail already handles persistence, reload, and the SDK's
// auto-resubmit; building a second one (a held-open request waiting on a
// channel from some /approve endpoint) would need session state, would not
// survive a refresh, and would have to be reconciled with this one anyway.
//
// What is new is the data part. "input-available" alone cannot distinguish
// "waiting for the browser to run this" from "waiting for a human to say
// yes", and those want completely different UI.
func (s *toolScheduler) suspendForApproval(sl *toolSlot, d permission.Decision) {
	command := ""
	if sl.def.CommandLine != nil {
		command = sl.def.CommandLine(sl.input)
	} else {
		var in struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(sl.input, &in) == nil {
			command = in.Command
		}
	}

	data := map[string]any{
		"toolCallId": sl.tc.ID,
		"toolName":   sl.tc.Name,
		"risk":       sl.def.Risk.String(),
		"reason":     d.Reason,
	}
	if command != "" {
		data["command"] = command
		// Flagged separately from the command itself so the card can say
		// *why* an otherwise-allowlisted command is being asked about. A
		// compound command is the case the allowlist exists to catch, and
		// the user should be told that rather than left to spot the `&&`.
		data["compound"] = permission.HasShellOperators(command)
	}

	part := map[string]any{"type": "data-" + approvalDataPart, "id": sl.tc.ID, "data": data}
	s.approvals = append(s.approvals, part)

	s.swMu.Lock()
	_ = s.sw.Data(approvalDataPart, sl.tc.ID, data)
	s.swMu.Unlock()

	sl.outcome = toolCallOutcome{
		part: map[string]any{
			"type": "tool-" + sl.tc.Name, "toolCallId": sl.tc.ID, "state": "input-available", "input": sl.input,
		},
		pauseForClient: true,
	}
	s.paused = true
	s.note(sl, session.StatusDenied, "suspended for user approval", d.Reason)
}

// execute runs one tool and records its outcome. Safe to call from any
// goroutine: every stream write it makes goes through emit*, and the only
// slot it touches is its own.
func (s *toolScheduler) execute(ctx context.Context, sl *toolSlot) {
	output, execErr := sl.def.Execute(ctx, sl.input)
	if execErr != nil {
		s.emitError(sl.tc.ID, execErr.Error())
		sl.outcome = errorOutcome(sl.tc, sl.input, execErr.Error())
		// A tool that ran and refused (a bad edit anchor, a pattern that
		// matched nothing) is not the same event as a tool that broke, and
		// the eval harness's failed-edit rate depends on the difference.
		// classifyToolError decides which this was.
		s.log.Observe(sl.logAt, session.Observation{Status: classifyToolError(sl.def.Name, execErr), Error: execErr.Error()})
		return
	}

	s.swMu.Lock()
	_ = s.sw.ToolOutputAvailable(sl.tc.ID, output)
	s.swMu.Unlock()

	outputJSON, _ := json.Marshal(output)
	sl.outcome = toolCallOutcome{
		part: map[string]any{
			"type": "tool-" + sl.tc.Name, "toolCallId": sl.tc.ID, "state": "output-available",
			"input": sl.input, "output": output,
		},
		messages: []bifrostai.Message{
			assistantCallMessage(sl.tc, sl.input),
			{Role: bifrostai.RoleTool, ToolCallID: sl.tc.ID, Text: stringifyToolOutput(outputJSON)},
		},
	}
	s.log.Observe(sl.logAt, session.Observation{Status: session.StatusOK, Summary: summarizeOutput(outputJSON)})
}

// classifyToolError separates "the tool refused" from "the tool broke".
//
// Both surface to the model as an error string, and that is right -- the
// model's next move is the same either way. They are different events for
// anyone measuring the run: a rising rejection rate on edit_file means the
// edit format is hard for the model to produce correctly, which is a
// scaffold problem the plan calls the sharpest ACI signal there is. A
// rising error rate means something is broken. Averaging them together
// hides both.
//
// The signal is that a tool built here returns a message written for the
// model to act on, and those all begin with the tool's own name. An
// unexpected panic, an I/O failure or a context deadline does not.
func classifyToolError(toolName string, err error) session.ObservationStatus {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return session.StatusError
	}
	// Tools here prefix a message they wrote for the model with their own
	// name (`edit_file: ...`); containment failures come from the workspace
	// package and are equally deliberate refusals. Anything else -- a
	// wrapped I/O error, a panic recovered upstream -- is the tool breaking.
	prefix, _, ok := strings.Cut(err.Error(), ":")
	if !ok {
		return session.StatusError
	}
	switch strings.TrimSpace(prefix) {
	case toolName, "workspace":
		return session.StatusRejected
	}
	return session.StatusError
}

// summarizeOutput is a short description of a result for the log. Length-
// capped hard: the log exists to describe a turn, and one that carried
// every file read would be as large as the context it describes.
func summarizeOutput(outputJSON []byte) string {
	const cap = 200
	s := string(outputJSON)
	if len(s) > cap {
		return s[:cap] + "..."
	}
	return s
}

func (s *toolScheduler) emitInput(tc bifrostai.ToolCall, input json.RawMessage) {
	s.swMu.Lock()
	defer s.swMu.Unlock()
	_ = s.sw.ToolInputAvailable(tc.ID, tc.Name, input)
}

func (s *toolScheduler) emitError(id, msg string) {
	s.swMu.Lock()
	defer s.swMu.Unlock()
	_ = s.sw.ToolOutputError(id, msg)
}

// assistantCallMessage is the assistant turn that carries one tool call,
// paired with the tool result message that answers it.
func assistantCallMessage(tc bifrostai.ToolCall, input json.RawMessage) bifrostai.Message {
	return bifrostai.Message{
		Role:      bifrostai.RoleAssistant,
		ToolCalls: []bifrostai.ToolCall{{ID: tc.ID, Name: tc.Name, Arguments: string(input)}},
	}
}

func errorOutcome(tc bifrostai.ToolCall, input json.RawMessage, msg string) toolCallOutcome {
	return toolCallOutcome{
		part: map[string]any{
			"type": "tool-" + tc.Name, "toolCallId": tc.ID, "state": "output-error",
			"input": input, "errorText": msg,
		},
		messages: []bifrostai.Message{
			assistantCallMessage(tc, input),
			{Role: bifrostai.RoleTool, ToolCallID: tc.ID, Text: msg},
		},
	}
}

// toolCallOutcome is one resolved tool call: the part to persist, the
// messages to append to the model's history, and whether the loop must now
// pause and wait for the browser to run it.
type toolCallOutcome struct {
	part           map[string]any
	messages       []bifrostai.Message
	pauseForClient bool
}
