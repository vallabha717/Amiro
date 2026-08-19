package uimessage

import (
	"encoding/json"
	"strings"
)

// Frame is one chunk of the UI Message Stream, as a Go type.
//
// # Why this exists
//
// This package could always *write* the protocol; nothing could read it.
// The frames were built as map[string]any literals at each call site, which
// is fine for a producer whose only consumer is a browser, and useless to a
// second Go client -- the terminal UI would have had to re-derive the shape
// of every frame from the writer's method bodies, in map lookups, with no
// compiler anywhere in the loop.
//
// Every comparable tool keeps this as a named layer: codex has a `protocol`
// crate ("internal types for communication between codex-core and codex-tui,
// as well as external types used with codex app-server"), crush has
// internal/proto, opencode has packages/protocol. This is Amiro's, over the
// wire format it already shipped.
//
// # Why Writer does not encode Frames
//
// The obvious next step -- reimplement Writer's methods as Frame values and
// encode those -- is deliberately NOT taken, and the reason is the one that
// matters most about this file: *the desktop app depends on these bytes*.
//
// A Frame field is `omitempty`, so a nil tool input encodes as an absent
// "input" key; the map literal in Writer encodes it as `"input":null`. Those
// are different bytes, and which one the AI SDK's parser prefers is not a
// question worth answering under a refactor whose whole purpose is to change
// nothing about the wire. Writer keeps its literals; Frame reads them.
//
// The risk that follows is drift -- a writer method gaining a field this
// type does not model -- and it is covered rather than accepted:
// TestFrameRoundTripsEveryWriterMethod drives every method on Writer and
// fails if decoding then re-encoding loses anything.
type Frame struct {
	Type FrameType `json:"type"`

	// MessageID is set on FrameStart.
	MessageID string `json:"messageId,omitempty"`

	// ID identifies a text or reasoning part, and reconciles repeat writes
	// of a data part.
	ID string `json:"id,omitempty"`

	// Delta carries one fragment of streamed text or reasoning.
	Delta string `json:"delta,omitempty"`

	// The tool-call fields. Input and Output stay raw: a tool's arguments
	// and result are whatever that tool declared, and decoding them into
	// `any` here would cost every consumer the round trip back out.
	ToolCallID     string          `json:"toolCallId,omitempty"`
	ToolName       string          `json:"toolName,omitempty"`
	InputTextDelta string          `json:"inputTextDelta,omitempty"`
	Input          json.RawMessage `json:"input,omitempty"`
	Output         json.RawMessage `json:"output,omitempty"`

	// ErrorText is set on FrameError and FrameToolOutputError.
	ErrorText string `json:"errorText,omitempty"`

	// Data is a data part's payload -- an approval request, a compaction
	// marker. Which one is named by the frame type, see DataName.
	Data json.RawMessage `json:"data,omitempty"`

	// MessageMetadata rides the closing frame: usage, model, duration.
	MessageMetadata json.RawMessage `json:"messageMetadata,omitempty"`
}

// FrameType names what a frame is. The values are the wire strings, not an
// internal enum -- they are compared against bytes that came off a stream.
type FrameType string

const (
	FrameStart      FrameType = "start"
	FrameStartStep  FrameType = "start-step"
	FrameFinishStep FrameType = "finish-step"

	FrameTextStart FrameType = "text-start"
	FrameTextDelta FrameType = "text-delta"
	FrameTextEnd   FrameType = "text-end"

	FrameReasoningStart FrameType = "reasoning-start"
	FrameReasoningDelta FrameType = "reasoning-delta"
	FrameReasoningEnd   FrameType = "reasoning-end"

	FrameToolInputStart      FrameType = "tool-input-start"
	FrameToolInputDelta      FrameType = "tool-input-delta"
	FrameToolInputAvailable  FrameType = "tool-input-available"
	FrameToolOutputAvailable FrameType = "tool-output-available"
	FrameToolOutputError     FrameType = "tool-output-error"

	FrameError  FrameType = "error"
	FrameFinish FrameType = "finish"

	// FrameDone is synthesized by the decoder for the stream's terminal
	// `data: [DONE]` sentinel, which is not JSON and carries no fields.
	//
	// In-band rather than a separate signal because a consumer has to
	// distinguish "the stream ended" from "the connection dropped", and a
	// reader that reports both as io.EOF cannot.
	FrameDone FrameType = "done"
)

// dataFramePrefix marks a typed data part: the wire type is the prefix plus
// the part's name, e.g. "data-tool-approval".
const dataFramePrefix = "data-"

// DataName returns a data frame's part name, and whether this is one.
//
//	f.Type == "data-tool-approval"  ->  ("tool-approval", true)
//	f.Type == "text-delta"          ->  ("", false)
func (f Frame) DataName() (string, bool) {
	name, ok := strings.CutPrefix(string(f.Type), dataFramePrefix)
	if !ok || name == "" {
		return "", false
	}
	return name, true
}

// IsData reports whether this frame is a typed data part.
func (f Frame) IsData() bool {
	_, ok := f.DataName()
	return ok
}

// DataFrameType builds the wire type for a data part name.
func DataFrameType(name string) FrameType { return FrameType(dataFramePrefix + name) }
