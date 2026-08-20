package fakeprovider

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
)

// ToolCallSpec defines a scripted tool invocation returned by fakeprovider.
type ToolCallSpec struct {
	ID        string
	Name      string
	Arguments string
}

// RuleOption configures a rule's response behavior.
type RuleOption func(*Rule)

// PerChunk sets the character slice size when streaming text deltas.
func PerChunk(size int) RuleOption {
	return func(r *Rule) {
		if size > 0 {
			r.ChunkSize = size
		}
	}
}

// Rule defines an expectation and scripted response in fakeprovider.
type Rule struct {
	Matcher Matcher

	// Text streaming
	Text      string
	ChunkSize int

	// Tool call then text
	ToolCalls []ToolCallSpec
	ThenText  string

	// Failure injections
	StatusCode          int
	ErrorBody           string
	TruncateAfterChunks int
	MalformedSSEPayload string
	MalformedArgsTool   string
	MalformedArgsBody   string
	IsContextOverflow   bool

	// Custom handler
	Handler func(w http.ResponseWriter, r *http.Request) bool
}

// StreamText configures the rule to stream the given text in chunks.
func (r *Rule) StreamText(text string, opts ...RuleOption) *Rule {
	r.Text = text
	r.ChunkSize = 10
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// ToolCall configures the rule to first emit a tool call.
func (r *Rule) ToolCall(name string, args any) *Rule {
	var argsStr string
	switch a := args.(type) {
	case string:
		argsStr = a
	default:
		b, _ := json.Marshal(a)
		argsStr = string(b)
	}
	r.ToolCalls = append(r.ToolCalls, ToolCallSpec{
		ID:        fmt.Sprintf("call_fake_%d", len(r.ToolCalls)+1),
		Name:      name,
		Arguments: argsStr,
	})
	return r
}

// ThenStreamText sets the follow-up text to stream once tool output is returned.
func (r *Rule) ThenStreamText(text string, opts ...RuleOption) *Rule {
	r.ThenText = text
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// Error scripts an HTTP error status code and response body.
func (r *Rule) Error(statusCode int, body string) *Rule {
	r.StatusCode = statusCode
	r.ErrorBody = body
	return r
}

// TruncateStreamAfter terminates the HTTP stream abruptly after chunkCount chunks.
func (r *Rule) TruncateStreamAfter(chunkCount int) *Rule {
	r.TruncateAfterChunks = chunkCount
	return r
}

// MalformedSSE injects invalid SSE framing or corrupted JSON mid-stream.
func (r *Rule) MalformedSSE(payload string) *Rule {
	r.MalformedSSEPayload = payload
	return r
}

// MalformedToolArgs returns a tool call with unparseable JSON arguments.
func (r *Rule) MalformedToolArgs(toolName, invalidJSON string) *Rule {
	r.MalformedArgsTool = toolName
	r.MalformedArgsBody = invalidJSON
	return r
}

// OverContextWindow injects a context window exceeded error.
func (r *Rule) OverContextWindow() *Rule {
	r.IsContextOverflow = true
	r.StatusCode = http.StatusBadRequest
	r.ErrorBody = `{"error":{"message":"This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens.","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}`
	return r
}

// Handle sets a custom HTTP handler for this rule.
func (r *Rule) Handle(fn func(w http.ResponseWriter, r *http.Request) bool) *Rule {
	r.Handler = fn
	return r
}

// ResetMidStream streams chunksBeforeReset SSE text deltas and then destroys
// the underlying TCP connection, so the client sees a transport-level
// failure rather than an orderly end of body.
//
// This is a DIFFERENT fault from TruncateStreamAfter, and the difference is
// the whole point. TruncateStreamAfter returns from the handler early, so
// net/http still terminates the response properly: the client observes a
// well-formed body that simply stopped, i.e. a short read. ResetMidStream
// hijacks the connection and closes it with SO_LINGER 0, which sends a TCP
// RST -- the client observes "connection reset by peer" partway through a
// frame. A provider that dies mid-chunk, a load balancer that drops a long
// stream, and a network partition all look like this one and none of them
// look like the other.
//
// Implemented as a Handler so that nothing in the server's own response
// path changes: an existing rule behaves exactly as it did before.
func (r *Rule) ResetMidStream(text string, chunksBeforeReset int) *Rule {
	if chunksBeforeReset < 0 {
		chunksBeforeReset = 0
	}
	return r.Handle(func(w http.ResponseWriter, _ *http.Request) bool {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			// Not reachable through httptest.Server, but a caller that wired
			// the fake into something else deserves a real failure rather
			// than a silently well-behaved response.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"fakeprovider: ResetMidStream needs an http.Hijacker"}}`))
			return true
		}
		conn, buf, err := hijacker.Hijack()
		if err != nil {
			return true
		}
		// The response is written by hand: after Hijack, net/http has
		// stopped managing this connection entirely.
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\n" +
			"Content-Type: text/event-stream\r\n" +
			"Cache-Control: no-cache\r\n" +
			"Connection: keep-alive\r\n\r\n")
		_ = buf.Flush()

		runes := []rune(text)
		per := len(runes) / max(chunksBeforeReset, 1)
		if per <= 0 {
			per = 1
		}
		for i := 0; i < chunksBeforeReset && i*per < len(runes); i++ {
			end := min((i+1)*per, len(runes))
			payload := map[string]any{
				"id":      "chatcmpl-fake-reset",
				"object":  "chat.completion.chunk",
				"created": 1700000000,
				"model":   "gpt-4.1",
				"choices": []map[string]any{
					{"index": 0, "delta": map[string]any{"content": string(runes[i*per : end])}},
				},
			}
			b, _ := json.Marshal(payload)
			_, _ = fmt.Fprintf(buf, "data: %s\n\n", b)
			_ = buf.Flush()
		}

		// SO_LINGER 0 is what turns Close into an RST instead of a FIN. A
		// plain Close would look like an orderly shutdown, which is the
		// fault TruncateStreamAfter already covers.
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetLinger(0)
		}
		_ = conn.Close()
		return true
	})
}
