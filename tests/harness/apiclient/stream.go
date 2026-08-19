package apiclient

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Frame is one frame of the UI Message Stream POST /api/chat returns.
//
// TRANSCRIBED from backend-go/internal/ai/uimessage/frame.go, not imported.
// Go forbids importing amiro/backend/internal/... from this module -- the
// plan's `replace` directive assumed otherwise and cannot work. The
// language is enforcing the boundary docs/testing/01-architecture.md wanted
// anyway: the test system asserts on the WIRE, which is the contract a real
// client depends on, not on the type the server happened to marshal from.
//
// The cost of transcription is drift, and it is covered rather than
// accepted: suites/backend/smoke decodes a real stream from a real server,
// and a frame type this struct cannot represent fails there.
type Frame struct {
	Type FrameType `json:"type"`

	MessageID string `json:"messageId,omitempty"`
	ID        string `json:"id,omitempty"`
	Delta     string `json:"delta,omitempty"`

	ToolCallID     string          `json:"toolCallId,omitempty"`
	ToolName       string          `json:"toolName,omitempty"`
	InputTextDelta string          `json:"inputTextDelta,omitempty"`
	Input          json.RawMessage `json:"input,omitempty"`
	Output         json.RawMessage `json:"output,omitempty"`

	ErrorText string `json:"errorText,omitempty"`

	Data            json.RawMessage `json:"data,omitempty"`
	MessageMetadata json.RawMessage `json:"messageMetadata,omitempty"`
}

// FrameType names what a frame is. These are the wire strings, compared
// against bytes that came off a stream.
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

	// FrameDone is synthesized for the terminal `data: [DONE]` sentinel,
	// which is not JSON. It is in-band so a consumer can tell an orderly
	// finish from a dropped connection -- a reader that reports both as EOF
	// cannot, and "the model stopped" and "the backend died" call for very
	// different test failures.
	FrameDone FrameType = "done"
)

const dataFramePrefix = "data-"

// DataName returns a data frame's part name, and whether this is one:
// "data-tool-approval" -> ("tool-approval", true).
func (f Frame) DataName() (string, bool) {
	name, ok := strings.CutPrefix(string(f.Type), dataFramePrefix)
	if !ok || name == "" {
		return "", false
	}
	return name, true
}

func (f Frame) IsData() bool {
	_, ok := f.DataName()
	return ok
}

const (
	sseDataPrefix = "data: "
	doneSentinel  = "[DONE]"
	// maxFrameBytes matches the server's own cap. One frame routinely
	// exceeds bufio's 64 KiB default -- a tool-output frame carries whatever
	// the tool returned, and read_file's windowed default is ~2000 lines --
	// so a smaller buffer would fail exactly on the turns that worked.
	maxFrameBytes = 16 << 20
)

// Stream reads Frames off a UI Message Stream.
type Stream struct {
	lines  *bufio.Scanner
	closer io.Closer
	frame  Frame
	err    error
	done   bool

	// onFrame is called for every frame as it is read, before the caller
	// sees it. That is how frames reach events.ndjson without every test
	// having to remember to log them.
	onFrame func(Frame)
}

// NewStream wraps a response body.
func NewStream(r io.ReadCloser, onFrame func(Frame)) *Stream {
	lines := bufio.NewScanner(r)
	lines.Buffer(make([]byte, 0, 64<<10), maxFrameBytes)
	return &Stream{lines: lines, closer: r, onFrame: onFrame}
}

// Next advances to the next frame, returning false at end of stream or on
// the first error.
func (s *Stream) Next() bool {
	if s.err != nil || s.done {
		return false
	}
	for s.lines.Scan() {
		line := bytes.TrimSuffix(s.lines.Bytes(), []byte("\r"))
		payload, ok := bytes.CutPrefix(line, []byte(sseDataPrefix))
		if !ok {
			// Blank separators and any SSE field this protocol does not use
			// are skipped rather than treated as errors: a keep-alive
			// comment from a proxy is a normal thing to receive.
			continue
		}
		if string(payload) == doneSentinel {
			s.frame = Frame{Type: FrameDone}
			s.done = true
			s.emit()
			return true
		}
		var f Frame
		if err := json.Unmarshal(payload, &f); err != nil {
			s.err = fmt.Errorf("decoding stream frame: %w\nframe: %s", err, truncate(string(payload), 500))
			return false
		}
		s.frame = f
		s.emit()
		return true
	}
	s.err = s.lines.Err()
	return false
}

func (s *Stream) emit() {
	if s.onFrame != nil {
		s.onFrame(s.frame)
	}
}

func (s *Stream) Frame() Frame { return s.frame }
func (s *Stream) Err() error   { return s.err }

// Done reports whether the stream ended with its [DONE] sentinel. A stream
// that ended without one is not an error here -- a cancelled turn is a
// legitimate way to stop -- so the caller decides whether it matters.
func (s *Stream) Done() bool { return s.done }

func (s *Stream) Close() error {
	if s.closer != nil {
		return s.closer.Close()
	}
	return nil
}

// Turn is a whole streamed response, collected.
//
// Most assertions want the finished text and the tool calls, not the frame
// sequence; the frames are kept alongside so an assertion about ORDER --
// "text-start precedes every text-delta" -- is still possible.
type Turn struct {
	MessageID string
	Text      string
	Reasoning string
	Frames    []Frame
	ToolCalls []ToolCall
	Errors    []string
	// Finished reports whether the stream ended with [DONE]. False means the
	// connection ended early, which is a different failure from a turn that
	// completed with an error frame.
	Finished bool
	Metadata json.RawMessage
}

// ToolCall is one tool invocation observed in the stream.
type ToolCall struct {
	ID     string
	Name   string
	Input  json.RawMessage
	Output json.RawMessage
	Error  string
}

// Collect drains a stream into a Turn.
func (s *Stream) Collect() (Turn, error) {
	var t Turn
	var text, reasoning strings.Builder
	byID := map[string]int{}

	for s.Next() {
		f := s.Frame()
		t.Frames = append(t.Frames, f)
		switch f.Type {
		case FrameStart:
			t.MessageID = f.MessageID
		case FrameTextDelta:
			text.WriteString(f.Delta)
		case FrameReasoningDelta:
			reasoning.WriteString(f.Delta)
		case FrameToolInputAvailable:
			byID[f.ToolCallID] = len(t.ToolCalls)
			t.ToolCalls = append(t.ToolCalls, ToolCall{ID: f.ToolCallID, Name: f.ToolName, Input: f.Input})
		case FrameToolOutputAvailable:
			if i, ok := byID[f.ToolCallID]; ok {
				t.ToolCalls[i].Output = f.Output
			} else {
				t.ToolCalls = append(t.ToolCalls, ToolCall{ID: f.ToolCallID, Output: f.Output})
			}
		case FrameToolOutputError:
			if i, ok := byID[f.ToolCallID]; ok {
				t.ToolCalls[i].Error = f.ErrorText
			}
		case FrameError:
			t.Errors = append(t.Errors, f.ErrorText)
		case FrameFinish:
			t.Metadata = f.MessageMetadata
		}
	}
	t.Text = text.String()
	t.Reasoning = reasoning.String()
	t.Finished = s.Done()
	return t, s.Err()
}
