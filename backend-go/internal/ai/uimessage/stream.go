// Package uimessage writes the Vercel AI SDK's UI Message Stream protocol
// (what the frontend's useChat / streamText().toUIMessageStreamResponse()
// speak today) directly over an http.ResponseWriter. Ported by reading the
// "ai" package's own implementation
// (node_modules/ai/dist/index.js: JsonToSseTransformStream,
// UI_MESSAGE_STREAM_HEADERS) rather than guessing the wire format, since
// Phase 7 (frontend decoupling) will point the existing useChat calls
// straight at this sidecar and needs byte-for-byte compatible framing.
package uimessage

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// Headers ports UI_MESSAGE_STREAM_HEADERS
// (ai/dist/index.js "src/ui-message-stream/ui-message-stream-headers.ts").
var Headers = map[string]string{
	"Content-Type":                  "text/event-stream",
	"Cache-Control":                 "no-cache",
	"Connection":                    "keep-alive",
	"X-Vercel-Ai-Ui-Message-Stream": "v1",
	"X-Accel-Buffering":             "no",
}

// Writer streams UIMessageChunk frames as `data: <json>\n\n` SSE events,
// flushing after every frame so partial output reaches the client as soon
// as it's written (matching the TS stream's behavior, where each enqueue is
// its own network write).
type Writer struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

// NewWriter sets the UI Message Stream response headers and returns a
// Writer. Call this before writing any other response data.
func NewWriter(w http.ResponseWriter) *Writer {
	for k, v := range Headers {
		w.Header().Set(k, v)
	}
	flusher, _ := w.(http.Flusher)
	return &Writer{w: w, flusher: flusher}
}

func (s *Writer) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "data: %s\n\n", b); err != nil {
		return err
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
	return nil
}

// Start writes the stream's opening "start" chunk.
func (s *Writer) Start(messageID string) error {
	return s.write(map[string]any{"type": "start", "messageId": messageID})
}

// StartStep/FinishStep bracket one model turn -- ported even though Phase 3
// never emits more than one step (no tool-call loop yet, that's Phase 4/5),
// because the frontend's stream parser expects the step markers around any
// text part.
func (s *Writer) StartStep() error  { return s.write(map[string]any{"type": "start-step"}) }
func (s *Writer) FinishStep() error { return s.write(map[string]any{"type": "finish-step"}) }

// TextStart/TextDelta/TextEnd stream one text part, identified by id (a
// UI part id, distinct from the message id).
func (s *Writer) TextStart(id string) error {
	return s.write(map[string]any{"type": "text-start", "id": id})
}
func (s *Writer) TextDelta(id, delta string) error {
	return s.write(map[string]any{"type": "text-delta", "id": id, "delta": delta})
}
func (s *Writer) TextEnd(id string) error {
	return s.write(map[string]any{"type": "text-end", "id": id})
}

// ToolInputAvailable writes a completed tool call: the model decided to
// call toolName with the given input (already-parsed, not a raw argument
// string -- ai/dist/index.js's own "tool-call" case enqueues `input`, the
// parsed object, not the provider's raw JSON string). Ported without the
// tool-input-start/tool-input-delta pair the TS stream also supports:
// GenerateStep (internal/ai/bifrost) resolves a step non-streaming, so the
// full input is already known by the time this is ever called -- there are
// no partial arguments to stream.
func (s *Writer) ToolInputAvailable(toolCallID, toolName string, input any) error {
	return s.write(map[string]any{
		"type":       "tool-input-available",
		"toolCallId": toolCallID,
		"toolName":   toolName,
		"input":      input,
	})
}

// ToolOutputAvailable writes a tool's successful result.
func (s *Writer) ToolOutputAvailable(toolCallID string, output any) error {
	return s.write(map[string]any{
		"type":       "tool-output-available",
		"toolCallId": toolCallID,
		"output":     output,
	})
}

// ToolOutputError writes a tool's failed result -- reserved for a tool
// invocation actually erroring out at the transport/framework level, not
// this app's own tools reporting a handled failure (http_fetch.go's and
// web_search.go's error paths deliberately return a normal, "succeeded"
// tool output shaped like `{isError, error, solution}` instead, matching
// the TS tools' own safe().ifFail() pattern -- see those files' doc
// comments).
func (s *Writer) ToolOutputError(toolCallID, errorText string) error {
	return s.write(map[string]any{
		"type":       "tool-output-error",
		"toolCallId": toolCallID,
		"errorText":  errorText,
	})
}

// Error writes an inline error chunk. The stream continues after this --
// TS's onError returns a string that becomes this errorText and the stream
// still finishes normally (see shared.chat.ts's handleError).
func (s *Writer) Error(errorText string) error {
	return s.write(map[string]any{"type": "error", "errorText": errorText})
}

// Finish writes the closing "finish" chunk. messageMetadata, when non-nil,
// is attached the same way route.ts's onFinish messageMetadata callback
// attaches ChatMetadata.
func (s *Writer) Finish(messageMetadata any) error {
	frame := map[string]any{"type": "finish"}
	if messageMetadata != nil {
		frame["messageMetadata"] = messageMetadata
	}
	return s.write(frame)
}

// Done writes the terminal `data: [DONE]` frame
// (JsonToSseTransformStream's flush()).
func (s *Writer) Done() error {
	if _, err := fmt.Fprint(s.w, "data: [DONE]\n\n"); err != nil {
		return err
	}
	if s.flusher != nil {
		s.flusher.Flush()
	}
	return nil
}
