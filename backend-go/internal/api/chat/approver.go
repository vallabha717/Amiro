package chat

import (
	"context"
	"encoding/json"
	"fmt"

	"amiro/backend/internal/agent/permission"
)

// Approver answers, synchronously, whether one gated tool call may run.
//
// # Who this is for, and who it is not for
//
// It is for callers that have a human (or a policy) available *right now*
// and no client to hand the question to: the headless runner
// (`amiro run --yes`) and the evaluation harness. Those turns have no
// browser to render a card and nothing that will ever resubmit, so without
// an Approver their only options are "suspend forever" or "run everything".
//
// It is deliberately NOT how the desktop app or the terminal UI approve
// things. Both of those have a client, and both use the rail that already
// exists: the turn suspends, the call is persisted as a pending approval,
// the client asks, and the answer arrives on the next request
// (suspendForApproval, resolveApprovals). That rail survives a page
// reload, a reconnect and a restart, which a blocked goroutine holding an
// open request does not. Two surfaces sharing one approval path is also
// what stops them from drifting apart on the most safety-critical decision
// the agent makes.
//
// So: nil Approver -- the normal case -- changes nothing at all.
type Approver interface {
	// Ask blocks until the call is answered. Returning an error is treated
	// as a denial: a turn that cannot get an answer must not proceed as
	// though it got a yes.
	Ask(ctx context.Context, req ApprovalRequest) (ApprovalAnswer, error)
}

// ApprovalRequest is one call the permission engine wants blessed.
//
// The same facts the approval card renders, which is not a coincidence --
// an approver that shows less than the card is deciding with less
// information than a user in the browser would have.
type ApprovalRequest struct {
	ToolCallID string
	ToolName   string

	// Risk is the tool's declared side-effect class: read, write, external.
	Risk string

	// Reason is the permission engine's explanation, written to be read by
	// a person rather than matched by a machine.
	Reason string

	// Command is the shell command line this call would run, when it is a
	// command-shaped call. Empty otherwise.
	Command string

	// Compound marks a command carrying shell operators (`&&`, `;`, `|`).
	// Flagged separately because it is the case the allowlist exists to
	// catch, and a reviewer should be told rather than left to spot the
	// operator.
	Compound bool

	// Input is the call's arguments, exactly as the model produced them.
	Input json.RawMessage
}

// ApprovalAnswer is the verdict.
type ApprovalAnswer struct {
	// Confirm allows the call to run.
	Confirm bool

	// Scope is "once" (the default) or "always". "always" records a session
	// grant -- for a command-shaped call, for that exact command line only,
	// never for the tool that ran it.
	Scope string
}

// ApproveOnce and ApproveAlways are the two yes answers; DenyApproval is
// the no. Named constructors because a bare struct literal at a call site
// reads as `{true, "always"}`, which says nothing.
func ApproveOnce() ApprovalAnswer   { return ApprovalAnswer{Confirm: true, Scope: "once"} }
func ApproveAlways() ApprovalAnswer { return ApprovalAnswer{Confirm: true, Scope: "always"} }
func DenyApproval() ApprovalAnswer  { return ApprovalAnswer{} }

// ApproverFunc adapts a function to the Approver interface.
type ApproverFunc func(ctx context.Context, req ApprovalRequest) (ApprovalAnswer, error)

// Ask implements Approver.
func (f ApproverFunc) Ask(ctx context.Context, req ApprovalRequest) (ApprovalAnswer, error) {
	return f(ctx, req)
}

// AutoApprove answers yes to everything, once.
//
// For `amiro run --yes` and for benchmark runs, where nobody is present to
// answer and the alternative is a turn that suspends forever. It relaxes
// *policy* only -- workspace containment is enforced somewhere else
// entirely (internal/agent/workspace) and no answer here can widen it.
var AutoApprove Approver = ApproverFunc(func(context.Context, ApprovalRequest) (ApprovalAnswer, error) {
	return ApproveOnce(), nil
})

// approverKey types the context value below. Unexported and empty, so no
// other package can collide with it or read it out.
type approverKey struct{}

// WithApprover returns a context whose turns answer their own approvals
// through ap.
//
// On the context rather than a parameter, which is worth justifying because
// the usual advice is the opposite. Three things make this the right side
// of that line: it is genuinely request-scoped (it is "who is watching this
// particular turn"), it is optional with a correct zero behavior (no
// approver means the existing suspend rail, unchanged), and the alternative
// is a ninth parameter on a tool loop that already takes eight and is
// called from five places -- four of which would pass nil forever.
//
// The thing to avoid with context values is smuggling *required* inputs
// through it. This is not one: a turn with no approver is a complete,
// correct turn, and is what every existing caller gets.
func WithApprover(ctx context.Context, ap Approver) context.Context {
	if ap == nil {
		return ctx
	}
	return context.WithValue(ctx, approverKey{}, ap)
}

// approverFrom returns the context's Approver, or nil.
func approverFrom(ctx context.Context) Approver {
	ap, _ := ctx.Value(approverKey{}).(Approver)
	return ap
}

// declinedToolMessage is what the model is told when a human said no.
//
// One definition, used by both approval paths -- the client's rejection
// (resolveApprovals) and an Approver's (tool_scheduler.go). They were about
// to be two string literals saying almost the same thing, and "almost" is
// the problem: the sentence is a prompt, it is tuned, and a model that gets
// a differently-worded refusal depending on which surface asked is a
// difference nobody chose.
//
// It reads as an instruction rather than an error because the model's next
// move is what matters: retrying the identical call is the one thing it
// must not do.
func declinedToolMessage(toolName string) string {
	return fmt.Sprintf(
		"The user declined to run %s. Do not retry it -- explain what you wanted to do and why, or find another way.",
		toolName)
}

// approvalRequestFor builds the question from a gated call, mirroring the
// data the approval card is given.
func approvalRequestFor(sl *toolSlot, d permission.Decision) ApprovalRequest {
	command := commandLineOf(sl.def, sl.input)
	return ApprovalRequest{
		ToolCallID: sl.tc.ID,
		ToolName:   sl.tc.Name,
		Risk:       sl.def.Risk.String(),
		Reason:     d.Reason,
		Command:    command,
		Compound:   command != "" && permission.HasShellOperators(command),
		Input:      sl.input,
	}
}
