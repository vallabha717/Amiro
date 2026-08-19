package uimessage

// Emitter is everything one agent turn can say to whoever is watching it.
//
// It exists so the tool loop stops naming a *transport*. Before this, every
// function that ran a turn took a concrete *Writer, and a *Writer needs an
// http.ResponseWriter -- which made "run a turn" and "serve an HTTP request"
// the same act. They are not: the eval harness already ran turns with
// NewDiscardWriter and no client at all, and the terminal client
// (docs/tui-implementation-plan.md) is a third caller that has a client but
// no HTTP response to write it to.
//
// The method set is exactly *Writer's, so this is a description of what the
// loop already did rather than a new capability. That is deliberate: an
// interface invented ahead of its implementations tends to be wrong about
// all of them.
type Emitter interface {
	// Start/Finish/Done bracket the whole message.
	Start(messageID string) error
	Finish(messageMetadata any) error
	Done() error

	// StartStep/FinishStep bracket one model turn within it.
	StartStep() error
	FinishStep() error

	// Text and reasoning parts, each identified by a part id.
	TextStart(id string) error
	TextDelta(id, delta string) error
	TextEnd(id string) error
	ReasoningStart(id string) error
	ReasoningDelta(id, delta string) error
	ReasoningEnd(id string) error

	// One tool call, from the model beginning to emit it through its result.
	ToolInputStart(toolCallID, toolName string) error
	ToolInputDelta(toolCallID, inputTextDelta string) error
	ToolInputAvailable(toolCallID, toolName string, input any) error
	ToolOutputAvailable(toolCallID string, output any) error
	ToolOutputError(toolCallID, errorText string) error

	// Data parts (approval requests, compaction markers) and inline errors.
	Data(name, id string, data any) error
	Error(errorText string) error
}

// The SSE writer is the reference implementation, and the one the desktop
// app consumes. A compile-time assertion rather than a comment because the
// interface is defined *from* it -- if they drift, this is where it should
// be noticed.
var _ Emitter = (*Writer)(nil)
