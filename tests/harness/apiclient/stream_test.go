package apiclient

import (
	"io"
	"strings"
	"testing"
)

// body wraps a string as a ReadCloser, since Stream owns closing its source.
type nopCloser struct{ io.Reader }

func (nopCloser) Close() error { return nil }

func stream(s string) *Stream { return NewStream(nopCloser{strings.NewReader(s)}, nil) }

// TestStream_DecodesTheFrameTypesTheServerActuallyWrites is the drift guard
// for the transcribed Frame type.
//
// Frame is copied from backend-go/internal/ai/uimessage/frame.go because Go
// forbids importing it across the module boundary. The cost of a copy is
// drift; this is the payment. The fixture below is the wire form of a
// complete turn, and every field asserted here is one a suite depends on.
func TestStream_DecodesTheFrameTypesTheServerActuallyWrites(t *testing.T) {
	const wire = `data: {"type":"start","messageId":"msg-1"}

data: {"type":"start-step"}

data: {"type":"text-start","id":"t1"}

data: {"type":"text-delta","id":"t1","delta":"Hello, "}

data: {"type":"text-delta","id":"t1","delta":"world"}

data: {"type":"text-end","id":"t1"}

data: {"type":"tool-input-available","toolCallId":"call-1","toolName":"read_file","input":{"path":"a.txt"}}

data: {"type":"tool-output-available","toolCallId":"call-1","output":{"content":"file body"}}

data: {"type":"data-tool-approval","id":"ap-1","data":{"toolCallId":"call-1"}}

data: {"type":"finish-step"}

data: {"type":"finish","messageMetadata":{"usage":{"totalTokens":42}}}

data: [DONE]

`
	turn, err := stream(wire).Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if turn.MessageID != "msg-1" {
		t.Errorf("MessageID = %q", turn.MessageID)
	}
	if turn.Text != "Hello, world" {
		t.Errorf("Text = %q, want \"Hello, world\"", turn.Text)
	}
	if !turn.Finished {
		t.Error("the [DONE] sentinel was not recognised")
	}
	if len(turn.ToolCalls) != 1 {
		t.Fatalf("collected %d tool calls, want 1", len(turn.ToolCalls))
	}
	call := turn.ToolCalls[0]
	if call.Name != "read_file" || call.ID != "call-1" {
		t.Errorf("tool call = %+v", call)
	}
	if !strings.Contains(string(call.Input), "a.txt") {
		t.Errorf("tool input lost: %s", call.Input)
	}
	if !strings.Contains(string(call.Output), "file body") {
		t.Errorf("tool output lost: %s", call.Output)
	}
	if turn.Metadata == nil || !strings.Contains(string(turn.Metadata), "totalTokens") {
		t.Errorf("finish metadata lost: %s", turn.Metadata)
	}

	// The data frame must be recognised as one, and named.
	var sawApproval bool
	for _, f := range turn.Frames {
		if name, ok := f.DataName(); ok && name == "tool-approval" {
			sawApproval = true
		}
	}
	if !sawApproval {
		t.Error("the data-tool-approval frame was not recognised as a named data part")
	}
}

// TestStream_DistinguishesAnOrderlyFinishFromADroppedConnection.
//
// A reader that reported both as EOF could not tell "the model stopped" from
// "the backend died", and those call for very different test failures.
func TestStream_DistinguishesAnOrderlyFinishFromADroppedConnection(t *testing.T) {
	orderly, err := stream("data: {\"type\":\"text-delta\",\"delta\":\"hi\"}\n\ndata: [DONE]\n\n").Collect()
	if err != nil {
		t.Fatal(err)
	}
	if !orderly.Finished {
		t.Error("a stream ending in [DONE] must report Finished")
	}

	truncated, err := stream("data: {\"type\":\"text-delta\",\"delta\":\"hi\"}\n\n").Collect()
	if err != nil {
		t.Fatalf("a truncated stream is not an error here: %v", err)
	}
	if truncated.Finished {
		t.Error("a stream with no [DONE] must not report Finished")
	}
	if truncated.Text != "hi" {
		t.Errorf("the frames received before the drop were lost: %q", truncated.Text)
	}
}

func TestStream_SkipsKeepAliveCommentsAndBlankSeparators(t *testing.T) {
	// A proxy inserting SSE comment lines for keep-alive is a normal thing
	// for a proxy to do; a stricter reader would break on it.
	turn, err := stream(": keep-alive\n\ndata: {\"type\":\"text-delta\",\"delta\":\"ok\"}\n\n\nevent: ignored\n\ndata: [DONE]\n\n").Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if turn.Text != "ok" {
		t.Errorf("Text = %q", turn.Text)
	}
	if !turn.Finished {
		t.Error("Finished = false")
	}
}

func TestStream_ReportsAMalformedFrameWithTheFrameInTheMessage(t *testing.T) {
	_, err := stream("data: {\"type\":\"text-delta\",\"delta\":\n\n").Collect()
	if err == nil {
		t.Fatal("expected a decode error")
	}
	if !strings.Contains(err.Error(), "text-delta") {
		t.Errorf("the error does not include the offending frame: %v", err)
	}
}

func TestStream_CollectsErrorFramesWithoutTreatingThemAsTransportFailures(t *testing.T) {
	turn, err := stream(`data: {"type":"error","errorText":"provider refused"}

data: [DONE]

`).Collect()
	if err != nil {
		t.Fatalf("an error FRAME is not a stream error: %v", err)
	}
	if len(turn.Errors) != 1 || turn.Errors[0] != "provider refused" {
		t.Errorf("Errors = %v", turn.Errors)
	}
	if !turn.Finished {
		t.Error("the turn still finished orderly")
	}
}

func TestStream_HandlesAFrameLargerThanBufioDefault(t *testing.T) {
	// One frame routinely exceeds 64 KiB: a tool-output frame carries
	// whatever the tool returned, and read_file's windowed default is ~2000
	// lines. A smaller buffer would fail exactly on the turns that worked.
	big := strings.Repeat("x", 200<<10)
	turn, err := stream("data: {\"type\":\"text-delta\",\"delta\":\"" + big + "\"}\n\ndata: [DONE]\n\n").Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(turn.Text) != len(big) {
		t.Errorf("got %d bytes of text, want %d", len(turn.Text), len(big))
	}
}

func TestStream_HandlesCRLFLineEndings(t *testing.T) {
	turn, err := stream("data: {\"type\":\"text-delta\",\"delta\":\"ok\"}\r\n\r\ndata: [DONE]\r\n\r\n").Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if turn.Text != "ok" || !turn.Finished {
		t.Errorf("CRLF stream mis-decoded: text=%q finished=%v", turn.Text, turn.Finished)
	}
}

func TestDataName_OnlyMatchesPrefixedTypes(t *testing.T) {
	if name, ok := (Frame{Type: "data-tool-approval"}).DataName(); !ok || name != "tool-approval" {
		t.Errorf("DataName = %q, %v", name, ok)
	}
	if _, ok := (Frame{Type: "text-delta"}).DataName(); ok {
		t.Error("text-delta was treated as a data part")
	}
	if _, ok := (Frame{Type: "data-"}).DataName(); ok {
		t.Error("a bare data- prefix with no name was treated as a data part")
	}
}

func TestTextMessage_BuildsTheOrdinaryUserMessage(t *testing.T) {
	msg := TextMessage("m1", "hello")
	if msg.Role != "user" || msg.ID != "m1" {
		t.Errorf("message = %+v", msg)
	}
	if len(msg.Parts) != 1 || !strings.Contains(string(msg.Parts[0]), `"text":"hello"`) {
		t.Errorf("parts = %s", msg.Parts)
	}
}

func TestStatusOf_ExtractsTheHTTPStatusFromAnAPIError(t *testing.T) {
	err := &Error{Method: "GET", Path: "/api/admin/users", Status: 403, Message: "forbidden"}
	if got := StatusOf(err); got != 403 {
		t.Errorf("StatusOf = %d", got)
	}
	if got := StatusOf(io.EOF); got != 0 {
		t.Errorf("StatusOf of a non-API error = %d, want 0", got)
	}
	// The message must carry the status and the path: a test that fails on
	// an unexpected response should not need the log to know which call.
	if s := err.Error(); !strings.Contains(s, "403") || !strings.Contains(s, "/api/admin/users") {
		t.Errorf("Error() = %q", s)
	}
}

func TestNewBody_KeepsJSONStructuredAndFallsBackToAStringOtherwise(t *testing.T) {
	// Structure matters: a JSON body embedded as a string is opaque to the
	// redactor's field-name pass, so a session token inside it would leak.
	b := newBody([]byte(`{"token":"abc"}`), 1024)
	raw, err := b.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"token":"abc"}` {
		t.Errorf("JSON body was not kept structured: %s", raw)
	}

	html := newBody([]byte("<html>502 Bad Gateway</html>"), 1024)
	raw, _ = html.MarshalJSON()
	if !strings.HasPrefix(string(raw), `"`) {
		t.Errorf("a non-JSON body should be recorded as a string: %s", raw)
	}

	// Oversized degrades to a truncated string rather than being dropped: a
	// 2 MB response recorded as its first 1 KB is worth having.
	long := newBody([]byte(strings.Repeat("y", 4096)), 64)
	raw, _ = long.MarshalJSON()
	if !strings.Contains(string(raw), "truncated") {
		t.Errorf("an oversized body was not marked as truncated: %s", raw)
	}

	if newBody(nil, 1024) != nil {
		t.Error("an empty body should record as absent, not as an empty value")
	}
}

func TestJoin_EscapesPathSegmentsSoAnIDCannotChangeTheRoute(t *testing.T) {
	got := join("/api/thread", "abc/../admin")
	if strings.Contains(got, "/../") {
		t.Errorf("join produced a traversable path: %s", got)
	}
	if got := join("/api/archive", "a1", "items", "i1"); got != "/api/archive/a1/items/i1" {
		t.Errorf("join = %q", got)
	}
}
