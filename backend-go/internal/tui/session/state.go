// Package session holds the TUI's projection of one open thread: the
// messages rendered so far and the turn currently streaming in, if any.
//
// It mirrors internal/api/chat's parts.go the way the plan's Part 3
// describes reduce.go: both turn a Frame sequence into something a renderer
// can read, one for the browser's React state, one for this package's
// State. Phase 2 grows Message from a flat string into an ordered list of
// Parts -- text, reasoning and tool calls, interleaved in the order the
// model actually produced them -- the same shape parts.go persists.
package session

import "encoding/json"

// Role is who a message is from.
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// PartKind names what one Part of a Message is.
type PartKind string

const (
	PartText      PartKind = "text"
	PartReasoning PartKind = "reasoning"
	PartTool      PartKind = "tool"
)

// ToolStatus is where one tool call is in its lifecycle.
type ToolStatus string

const (
	// ToolPending covers everything from "the model started emitting a
	// call" through "the call is running" -- the frame stream does not
	// distinguish those (ToolInputStart/-Delta/-Available all precede any
	// output), and a card that can only say "pending" or "done" doesn't
	// need to either.
	ToolPending     ToolStatus = "pending"
	ToolDone        ToolStatus = "done"
	ToolError       ToolStatus = "error"
	ToolInterrupted ToolStatus = "interrupted"

	// ToolAwaitingApproval is ToolPending's sibling for a call the
	// permission engine wants a human to bless first (tool_scheduler.go's
	// suspendForApproval) -- distinct from ToolPending so a card and the
	// status bar can tell "running" from "waiting on you" apart, the same
	// distinction the data-tool-approval part exists to carry over
	// "input-available" alone (see ApprovalRequest's doc comment).
	ToolAwaitingApproval ToolStatus = "awaiting_approval"
)

// ToolCall is one tool invocation, as far as the stream has told the client
// so far. Input/Output stay raw for the same reason uimessage.Frame keeps
// them raw: a tool's shape is its own business, and toolcard's renderers
// decode only the fields they draw.
type ToolCall struct {
	ID        string
	Name      string
	Input     json.RawMessage
	Output    json.RawMessage
	Status    ToolStatus
	ErrorText string

	// Approval is set when Status is ToolAwaitingApproval -- the request the
	// human has to answer before this call can proceed.
	Approval *ApprovalRequest
}

// ApprovalRequest is a data-tool-approval frame's payload, mirroring
// tool_scheduler.go's suspendForApproval (this package's doc comment
// explains why it's a mirror and not an import).
//
// Raw keeps the exact bytes the frame carried, not just the fields this
// struct models: BuildApprovalResubmission echoes this part back verbatim
// in the resubmitted message (resolveApprovals only ever touches the tool
// part it answers, never the data-tool-approval part describing it), so a
// field this struct doesn't know about must still round-trip.
type ApprovalRequest struct {
	ToolCallID string
	ToolName   string
	Risk       string
	Reason     string
	Command    string
	Compound   bool
	Raw        json.RawMessage
}

// Part is one piece of a Message, in the order the model produced it. A
// message that reasons, then calls a tool, then reasons again has three
// Parts in that order -- Reduce is the only thing that mutates this;
// everything downstream (toolcard, the transcript render) only reads it.
type Part struct {
	Kind PartKind
	Text string // PartText, PartReasoning
	Tool *ToolCall
}

// Message is one turn's worth of content, rendered so far.
type Message struct {
	ID    string
	Role  Role
	Parts []Part
}

// Text concatenates every text part, in order. For a user message (always
// exactly one PartText) this is just the message; for an assistant message
// it is "what was said", with tool calls and reasoning omitted -- the
// fallback for anything that just wants the words, not the structure.
func (m Message) Text() string {
	var out string
	for _, p := range m.Parts {
		if p.Kind == PartText {
			out += p.Text
		}
	}
	return out
}

// TodoStatus mirrors internal/ai/tools.TodoStatus's wire values exactly
// (this package does not import internal/ai/tools -- see reduce.go's doc
// comment on why the TUI decodes tool output through its own small
// mirrored structs rather than depending on backend internals).
type TodoStatus string

const (
	TodoPending    TodoStatus = "pending"
	TodoInProgress TodoStatus = "in_progress"
	TodoDone       TodoStatus = "done"
)

// TodoItem is one line of the plan the todo_write/todo_read tool tracks.
type TodoItem struct {
	Content string     `json:"content"`
	Status  TodoStatus `json:"status"`
}

// State is the open thread: every message rendered so far, plus whatever a
// turn in flight has told it. One State per thread; the chat page owns
// exactly one.
type State struct {
	ThreadID string
	Messages []Message

	// Streaming reports whether a turn is currently being reduced into the
	// last message in Messages -- the chat page uses this to decide whether
	// Ctrl+C means "interrupt" or "quit", and whether to show a spinner.
	Streaming bool

	// Err is the most recent turn's failure, if RunTurn or the transport
	// reported one. Cleared by the next SendUserMessage.
	Err error

	// Todos is the most recently reported plan -- whatever the last
	// todo_write/todo_read call in this thread returned, thread-scoped
	// rather than message-scoped like the transcript itself: it answers
	// "what is the agent working on right now", which is a property of the
	// thread, not of any one turn.
	Todos []TodoItem

	// Model, Usage and DurationMS are the last completed turn's metadata
	// (the Finish frame's messageMetadata) -- what the status bar reads for
	// "model · tokens · cost · elapsed". Nil/zero before any turn finishes.
	Model      string
	Usage      *Usage
	DurationMS int64

	// PermissionMode is what every future SendUserMessage/turn is sent
	// with -- "" reads as interactive, matching permission.ParseMode's own
	// fallback. Owned here rather than by the page so a resumed thread and
	// a live mode switch are the same write.
	PermissionMode string

	// PendingApproval is the suspended call the human has to answer before
	// the thread can continue, or nil. Set by Reduce on a data-tool-approval
	// frame; cleared by BuildApprovalResubmission once an answer is built --
	// the page uses this to decide whether to render the approval dialog
	// instead of the composer.
	PendingApproval *ApprovalRequest

	current int // index into Messages of the in-flight assistant message, -1 if none

	// openText/openReasoning map a still-streaming text/reasoning part's id
	// (TextStart/ReasoningStart's ID field) to its index in the current
	// message's Parts, so TextDelta/ReasoningDelta know which Part to
	// append to without a linear search. openTool does the same for a
	// still-open tool call, keyed by ToolCallID.
	openText      map[string]int
	openReasoning map[string]int
	openTool      map[string]int
}

// Usage is bifrostai.Usage's wire shape, mirrored rather than imported for
// the same reason ToolCall's Input/Output stay raw -- see reduce.go.
type Usage struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
}

// New returns an empty State for threadID.
func New(threadID string) *State {
	return &State{ThreadID: threadID, current: -1}
}

// SendUserMessage appends the user's turn and marks the thread as awaiting a
// reply. Call this before starting the request that streams the response --
// the transcript should show what was asked immediately, not once the first
// frame arrives.
func (s *State) SendUserMessage(id, text string) {
	s.Messages = append(s.Messages, Message{ID: id, Role: RoleUser, Parts: []Part{{Kind: PartText, Text: text}}})
	s.Streaming = true
	s.current = -1
	s.Err = nil
}

// Interrupted marks an in-flight turn as stopped by the user rather than
// finished or errored -- called when Ctrl+C cancels the request context,
// since no FrameFinish/FrameDone will arrive for it. Any tool call still
// waiting on a result (ToolPending: the model asked, but no output frame
// ever arrived) is marked ToolInterrupted rather than left showing
// "running" forever -- the state a card that never hears back would
// otherwise be stuck in.
func (s *State) Interrupted() {
	s.Streaming = false
	s.abandonPendingTools()
}

// Failed records a transport-level failure (the connection dropped, the
// request never got a response) that happened outside the frame stream, so
// no FrameError described it. Same pending-tool cleanup as Interrupted --
// from a tool card's point of view, "the connection died" and "the user
// pressed Ctrl+C" are the same fact: no result is ever coming.
func (s *State) Failed(err error) {
	s.Streaming = false
	s.Err = err
	s.abandonPendingTools()
}

func (s *State) abandonPendingTools() {
	if s.current < 0 || s.current >= len(s.Messages) {
		return
	}
	for i := range s.Messages[s.current].Parts {
		p := &s.Messages[s.current].Parts[i]
		if p.Kind == PartTool && p.Tool != nil && p.Tool.Status == ToolPending {
			p.Tool.Status = ToolInterrupted
		}
	}
}
