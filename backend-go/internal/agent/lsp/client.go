// Package lsp speaks the Language Server Protocol, so an agent can ask
// "what calls this?" and get an answer instead of a grep.
//
// The gap this closes is narrow and real. `grep` finds every occurrence of
// a name; a language server finds every *reference to this symbol*, which
// on a name like `New`, `Run` or `handler` is a different set entirely.
// The same distinction makes go-to-definition exact rather than
// best-effort, and makes "did my edit break the build" answerable without
// running one.
//
// # Why this is optional and the repo map is not
//
// A language server is a separate executable the desktop app cannot assume
// is installed -- the same objection that kept ripgrep out of `grep`
// (internal/ai/tools/search.go) and tree-sitter out of the repo map. The
// difference is what happens when it is missing. There, the tool *is* the
// capability, so a missing binary would mean a core tool that works on the
// developer's machine and not the user's -- a silent capability difference,
// which is worse than a uniformly simpler tool. Here it is an accelerator
// over capabilities the agent already has (`grep`, `repo_map`), so absence
// costs precision on one question rather than the ability to answer it.
//
// So discovery is opportunistic and failure is silent: no server found
// means the `lsp` tool is never offered, exactly like tools.Deps's contract
// that an absent dependency omits a toolkit rather than substituting a
// default. The model is never told about a tool it cannot use, which is the
// only form of degradation that does not waste a turn.
package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
)

// Conn is one JSON-RPC 2.0 connection over LSP's Content-Length framing.
//
// The transport is an io.ReadWriteCloser rather than an *exec.Cmd so the
// protocol can be tested against an in-process fake server. A protocol
// implementation whose only test requires a language server on the machine
// is one that is untested in CI, which is the shape of test that reports
// green while covering nothing.
type Conn struct {
	w  io.Writer
	r  *bufio.Reader
	c  io.Closer
	mu sync.Mutex // serializes writes; LSP framing is not interleave-safe

	nextID  int64
	pending map[int64]chan rpcResponse
	pmu     sync.Mutex

	// notify receives server-initiated messages. Diagnostics arrive this
	// way -- unprompted, some time after a file is opened -- which is why
	// the client cannot be a simple request/response pair.
	notify func(method string, params json.RawMessage)

	closeOnce sync.Once
	closed    chan struct{}
	readErr   error
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      *int64 `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	ID     *int64          `json:"id"`
	Method string          `json:"method"`
	Result json.RawMessage `json:"result"`
	Params json.RawMessage `json:"params"`
	Error  *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("lsp: server error %d: %s", e.Code, e.Message) }

// NewConn starts reading from rwc immediately.
func NewConn(rwc io.ReadWriteCloser, onNotify func(method string, params json.RawMessage)) *Conn {
	c := &Conn{
		w:       rwc,
		r:       bufio.NewReaderSize(rwc, 64*1024),
		c:       rwc,
		pending: map[int64]chan rpcResponse{},
		notify:  onNotify,
		closed:  make(chan struct{}),
	}
	go c.readLoop()
	return c
}

// Call sends a request and waits for its response or ctx.
//
// Every call takes a context and none of them may block forever. A language
// server that stops answering -- indexing a huge repo, or wedged -- must
// cost one tool call, not the whole turn: this runs inside an agent loop
// that a user is watching.
func (c *Conn) Call(ctx context.Context, method string, params any, result any) error {
	c.pmu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan rpcResponse, 1)
	c.pending[id] = ch
	c.pmu.Unlock()

	defer func() {
		c.pmu.Lock()
		delete(c.pending, id)
		c.pmu.Unlock()
	}()

	if err := c.write(rpcRequest{JSONRPC: "2.0", ID: &id, Method: method, Params: params}); err != nil {
		return err
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.closed:
		if c.readErr != nil {
			return fmt.Errorf("lsp: connection closed: %w", c.readErr)
		}
		return fmt.Errorf("lsp: connection closed before %s returned", method)
	case resp := <-ch:
		if resp.Error != nil {
			return resp.Error
		}
		if result == nil || len(resp.Result) == 0 {
			return nil
		}
		return json.Unmarshal(resp.Result, result)
	}
}

// Notify sends a notification, which by protocol has no reply.
func (c *Conn) Notify(method string, params any) error {
	return c.write(rpcRequest{JSONRPC: "2.0", Method: method, Params: params})
}

func (c *Conn) write(msg rpcRequest) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("lsp: %w", err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := fmt.Fprintf(c.w, "Content-Length: %d\r\n\r\n", len(body)); err != nil {
		return fmt.Errorf("lsp: %w", err)
	}
	if _, err := c.w.Write(body); err != nil {
		return fmt.Errorf("lsp: %w", err)
	}
	return nil
}

func (c *Conn) readLoop() {
	for {
		body, err := readMessage(c.r)
		if err != nil {
			c.readErr = err
			c.closeOnce.Do(func() { close(c.closed) })
			return
		}

		var resp rpcResponse
		if err := json.Unmarshal(body, &resp); err != nil {
			continue // a frame we cannot parse is not a reason to tear down
		}

		switch {
		case resp.ID != nil && resp.Method == "":
			// A response to something we sent.
			c.pmu.Lock()
			ch := c.pending[*resp.ID]
			c.pmu.Unlock()
			if ch != nil {
				ch <- resp
			}
		case resp.Method != "" && resp.ID != nil:
			// A server->client *request*. We advertise no capabilities that
			// need one, but the protocol requires a reply or the server may
			// block waiting: answer null rather than ignoring it.
			_ = c.write(rpcRequest{JSONRPC: "2.0", ID: resp.ID, Method: ""})
		case resp.Method != "":
			if c.notify != nil {
				c.notify(resp.Method, resp.Params)
			}
		}
	}
}

// Close shuts the transport. Safe to call more than once.
func (c *Conn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return c.c.Close()
}

// readMessage reads one Content-Length-framed JSON-RPC body.
//
// Header parsing is deliberately lenient about everything except
// Content-Length: servers vary on Content-Type and on header casing, and
// none of that changes where the body starts.
func readMessage(r *bufio.Reader) ([]byte, error) {
	length := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break // end of headers
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(name), "content-length") {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return nil, fmt.Errorf("lsp: bad Content-Length %q", value)
			}
			length = n
		}
	}
	if length < 0 {
		return nil, fmt.Errorf("lsp: message without Content-Length")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return body, nil
}
