package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeServer is a language server that never leaves the process.
//
// This is the reason Conn takes an io.ReadWriteCloser rather than an
// *exec.Cmd. A protocol implementation whose only test needs gopls
// installed is untested on any machine without gopls -- including CI --
// and a test that silently skips is worse than no test, because it reports
// green.
type fakeServer struct {
	mu       sync.Mutex
	requests []string

	// handle answers one request. Returning (nil, nil) sends no reply at
	// all, which is how a hung server is simulated.
	handle func(method string, params json.RawMessage) (any, error)

	toClient chan []byte // frames the server pushes unprompted
}

// pipePair wires a Conn to a fakeServer over two in-memory pipes.
func pipePair(t *testing.T, fs *fakeServer, onNotify func(string, json.RawMessage)) *Conn {
	t.Helper()
	clientReader, serverWriter := io.Pipe()
	serverReader, clientWriter := io.Pipe()

	fs.toClient = make(chan []byte, 8)
	go fs.serve(bufio.NewReader(serverReader), serverWriter)

	conn := NewConn(struct {
		io.Reader
		io.WriteCloser
	}{clientReader, clientWriter}, onNotify)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func (fs *fakeServer) serve(r *bufio.Reader, w io.Writer) {
	go func() {
		for frame := range fs.toClient {
			writeFrame(w, frame)
		}
	}()

	for {
		body, err := readMessage(r)
		if err != nil {
			return
		}
		var msg struct {
			ID     *int64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(body, &msg) != nil {
			continue
		}

		fs.mu.Lock()
		fs.requests = append(fs.requests, msg.Method)
		fs.mu.Unlock()

		if msg.ID == nil {
			continue // a notification; nothing to answer
		}

		result, herr := fs.handle(msg.Method, msg.Params)
		if result == nil && herr == nil {
			continue // deliberately silent: the hung-server case
		}
		reply := map[string]any{"jsonrpc": "2.0", "id": *msg.ID}
		if herr != nil {
			reply["error"] = map[string]any{"code": -32000, "message": herr.Error()}
		} else {
			reply["result"] = result
		}
		raw, _ := json.Marshal(reply)
		writeFrame(w, raw)
	}
}

func writeFrame(w io.Writer, body []byte) {
	fmt.Fprintf(w, "Content-Length: %d\r\n\r\n", len(body))
	_, _ = w.Write(body)
}

func (fs *fakeServer) sawRequest(method string) bool {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	for _, m := range fs.requests {
		if m == method {
			return true
		}
	}
	return false
}

func TestConn_RoundTripsARequest(t *testing.T) {
	fs := &fakeServer{handle: func(method string, _ json.RawMessage) (any, error) {
		if method != "textDocument/definition" {
			return nil, fmt.Errorf("unexpected %s", method)
		}
		return []Location{{URI: "file:///x/y.go", Range: Range{Start: Position{Line: 4}}}}, nil
	}}
	conn := pipePair(t, fs, nil)

	var locs []Location
	if err := conn.Call(context.Background(), "textDocument/definition", map[string]any{}, &locs); err != nil {
		t.Fatalf("Call: %v", err)
	}
	if len(locs) != 1 || locs[0].Range.Start.Line != 4 {
		t.Fatalf("locations = %+v", locs)
	}
}

// Responses are correlated by id, not by arrival order. A server that
// answers out of order (every real one does, under concurrent requests)
// must not deliver one call's answer to another.
func TestConn_MatchesResponsesByIDNotByOrder(t *testing.T) {
	fs := &fakeServer{handle: func(method string, params json.RawMessage) (any, error) {
		var p struct {
			N int `json:"n"`
		}
		_ = json.Unmarshal(params, &p)
		if p.N == 1 {
			// The slow one, so its reply lands after the second call's.
			time.Sleep(80 * time.Millisecond)
		}
		return map[string]any{"n": p.N}, nil
	}}
	conn := pipePair(t, fs, nil)

	var wg sync.WaitGroup
	results := make([]int, 3)
	errs := make([]error, 3)
	for i := 1; i <= 3; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			var out struct {
				N int `json:"n"`
			}
			errs[n-1] = conn.Call(context.Background(), "echo", map[string]any{"n": n}, &out)
			results[n-1] = out.N
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("call %d: %v", i+1, err)
		}
	}
	for i, got := range results {
		if got != i+1 {
			t.Fatalf("call %d got response %d -- responses were matched by order, not id", i+1, got)
		}
	}
}

// A wedged server must cost one tool call, not the turn. This runs inside
// an agent loop somebody is watching.
func TestConn_CallReturnsWhenTheContextExpires(t *testing.T) {
	fs := &fakeServer{handle: func(string, json.RawMessage) (any, error) {
		return nil, nil // never replies
	}}
	conn := pipePair(t, fs, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	err := conn.Call(ctx, "textDocument/references", map[string]any{}, nil)
	if err == nil {
		t.Fatal("Call returned nil for a server that never answered")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("Call took %s to give up on a 100ms context", elapsed)
	}
}

func TestConn_SurfacesServerErrors(t *testing.T) {
	fs := &fakeServer{handle: func(string, json.RawMessage) (any, error) {
		return nil, fmt.Errorf("no handler for this")
	}}
	conn := pipePair(t, fs, nil)

	err := conn.Call(context.Background(), "textDocument/definition", map[string]any{}, nil)
	if err == nil || !strings.Contains(err.Error(), "no handler") {
		t.Fatalf("err = %v, want the server's message", err)
	}
}

// Diagnostics arrive unprompted, some time after a file is opened. If the
// client could not receive them, the diagnostics operation could not exist.
func TestConn_DeliversServerNotifications(t *testing.T) {
	got := make(chan string, 1)
	fs := &fakeServer{handle: func(string, json.RawMessage) (any, error) { return nil, nil }}
	conn := pipePair(t, fs, func(method string, params json.RawMessage) {
		if method == "textDocument/publishDiagnostics" {
			got <- string(params)
		}
	})
	_ = conn

	raw, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "textDocument/publishDiagnostics",
		"params":  map[string]any{"uri": "file:///a.go", "diagnostics": []any{}},
	})
	fs.toClient <- raw

	select {
	case params := <-got:
		if !strings.Contains(params, "a.go") {
			t.Fatalf("params = %s", params)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("notification never reached the handler")
	}
}

// Header casing and extra headers vary between servers; only
// Content-Length is load-bearing.
func TestReadMessage_ToleratesHeaderVariation(t *testing.T) {
	raw := "content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}"
	body, err := readMessage(bufio.NewReader(strings.NewReader(raw)))
	if err != nil {
		t.Fatalf("readMessage: %v", err)
	}
	if string(body) != "{}" {
		t.Fatalf("body = %q", body)
	}
}

func TestReadMessage_RejectsAFrameWithNoLength(t *testing.T) {
	if _, err := readMessage(bufio.NewReader(strings.NewReader("X-Thing: 1\r\n\r\n{}"))); err == nil {
		t.Fatal("accepted a frame with no Content-Length")
	}
}

// The spec allows three shapes here and servers genuinely differ; decoding
// only the common one would make the tool work against gopls and fail
// against something else for no visible reason.
func TestDecodeLocations_HandlesEveryShapeTheSpecAllows(t *testing.T) {
	cases := map[string]string{
		"array":        `[{"uri":"file:///a.go","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":3}}}]`,
		"single":       `{"uri":"file:///a.go","range":{"start":{"line":1,"character":0},"end":{"line":1,"character":3}}}`,
		"locationLink": `[{"targetUri":"file:///a.go","targetSelectionRange":{"start":{"line":1,"character":0},"end":{"line":1,"character":3}}}]`,
	}
	for name, raw := range cases {
		got := decodeLocations(json.RawMessage(raw))
		if len(got) != 1 || got[0].URI != "file:///a.go" || got[0].Range.Start.Line != 1 {
			t.Errorf("%s: decoded %+v", name, got)
		}
	}
	if got := decodeLocations(json.RawMessage("null")); got != nil {
		t.Errorf("null decoded to %+v", got)
	}
}

func TestURIRoundTrip(t *testing.T) {
	for _, p := range []string{"/home/u/project/main.go", "/tmp/x y/z.go"} {
		if got := URIToPath(pathToURI(p)); got != p {
			t.Errorf("round trip of %q = %q", p, got)
		}
	}
}
