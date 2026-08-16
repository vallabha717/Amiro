package lsp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Timeouts. Every one of these bounds something that runs inside a turn a
// user is waiting on, so none of them may be absent.
const (
	// initTimeout covers spawn plus the initialize handshake. gopls returns
	// from initialize before it has finished indexing, so this is not the
	// index time -- a server that cannot even answer the handshake in 30s
	// is broken, not busy.
	initTimeout = 30 * time.Second

	// queryTimeout bounds one request. Generous because the first query
	// against a cold server waits on the indexing that initialize did not.
	queryTimeout = 45 * time.Second

	// diagnosticsWait is how long to wait for a server to push diagnostics
	// for a file after opening it. Diagnostics are a notification with no
	// completion signal, so "no errors" and "not analysed yet" look
	// identical -- this is the window after which we call it clean, and the
	// result says which it was.
	diagnosticsWait = 4 * time.Second
)

// Position is a zero-based LSP position.
type Position struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

// Range is a span in a document.
type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

// Location is a range in a file.
type Location struct {
	URI   string `json:"uri"`
	Range Range  `json:"range"`
}

// Diagnostic is one problem the server reports.
type Diagnostic struct {
	Range    Range  `json:"range"`
	Severity int    `json:"severity"` // 1 error, 2 warning, 3 info, 4 hint
	Source   string `json:"source"`
	Message  string `json:"message"`
}

// DocumentSymbol is one declaration in a file, possibly nested.
type DocumentSymbol struct {
	Name      string           `json:"name"`
	Kind      int              `json:"kind"`
	Range     Range            `json:"range"`
	Selection Range            `json:"selectionRange"`
	Children  []DocumentSymbol `json:"children,omitempty"`
}

// Server is one running language server, scoped to one workspace root.
//
// One per (root, language) and shared across requests, started lazily.
// gopls spends seconds to tens of seconds indexing a repository on its
// first request; paying that per tool call would make the tool slower than
// the grep it replaces, which is the entire reason to have it.
type Server struct {
	cmd  *exec.Cmd
	conn *Conn
	root string
	lang string

	mu       sync.Mutex
	opened   map[string]bool // uri -> didOpen already sent
	diags    map[string][]Diagnostic
	diagCh   map[string]chan struct{}
	shutdown bool
}

// Start spawns a language server and completes the initialize handshake.
func Start(ctx context.Context, lang, root string, argv []string) (*Server, error) {
	if len(argv) == 0 {
		return nil, fmt.Errorf("lsp: no command for %s", lang)
	}

	ctx, cancel := context.WithTimeout(ctx, initTimeout)
	defer cancel()

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = root
	// Inherit stderr to the sidecar's own: language servers log heavily,
	// and the alternative -- capturing it into a pipe nobody drains -- is a
	// server that blocks on a full pipe after a few thousand lines.
	cmd.Stderr = os.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("lsp: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("lsp: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("lsp: starting %s: %w", argv[0], err)
	}

	s := &Server{
		cmd:    cmd,
		root:   root,
		lang:   lang,
		opened: map[string]bool{},
		diags:  map[string][]Diagnostic{},
		diagCh: map[string]chan struct{}{},
	}
	s.conn = NewConn(rwc{stdout, stdin}, s.onNotify)

	if err := s.initialize(ctx); err != nil {
		_ = s.Close()
		return nil, err
	}
	return s, nil
}

type rwc struct {
	io.Reader
	io.WriteCloser
}

func (r rwc) Close() error { return r.WriteCloser.Close() }

func (s *Server) initialize(ctx context.Context) error {
	var result json.RawMessage
	err := s.conn.Call(ctx, "initialize", map[string]any{
		"processId": os.Getpid(),
		"rootUri":   pathToURI(s.root),
		"workspaceFolders": []map[string]any{
			{"uri": pathToURI(s.root), "name": filepath.Base(s.root)},
		},
		// Only what is actually used. Advertising capabilities we do not
		// implement invites the server to send messages we would have to
		// answer, and an unanswered server->client request can block it.
		"capabilities": map[string]any{
			"textDocument": map[string]any{
				"synchronization": map[string]any{"dynamicRegistration": false},
				"definition":      map[string]any{"linkSupport": false},
				"references":      map[string]any{},
				"documentSymbol":  map[string]any{"hierarchicalDocumentSymbolSupport": true},
				"publishDiagnostics": map[string]any{
					"relatedInformation": false,
				},
			},
			"workspace": map[string]any{
				"symbol":           map[string]any{},
				"workspaceFolders": true,
			},
		},
	}, &result)
	if err != nil {
		return fmt.Errorf("lsp: initialize %s: %w", s.lang, err)
	}
	return s.conn.Notify("initialized", map[string]any{})
}

func (s *Server) onNotify(method string, params json.RawMessage) {
	if method != "textDocument/publishDiagnostics" {
		return
	}
	var p struct {
		URI         string       `json:"uri"`
		Diagnostics []Diagnostic `json:"diagnostics"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return
	}
	s.mu.Lock()
	s.diags[p.URI] = p.Diagnostics
	if ch, ok := s.diagCh[p.URI]; ok {
		delete(s.diagCh, p.URI)
		close(ch)
	}
	s.mu.Unlock()
}

// open sends didOpen for a file if it has not been sent, so the server has
// the on-disk contents.
//
// Always didOpen and never didChange, because this agent writes files to
// disk and the server watches them. Maintaining an in-memory document
// mirror would mean the tool layer became the authority on file contents,
// and any divergence between that mirror and disk shows up as diagnostics
// about code that no longer exists.
func (s *Server) open(path string) error {
	uri := pathToURI(path)
	s.mu.Lock()
	already := s.opened[uri]
	s.mu.Unlock()
	if already {
		// Re-send as a change so an edit since the last open is picked up.
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return s.conn.Notify("textDocument/didChange", map[string]any{
			"textDocument":   map[string]any{"uri": uri, "version": time.Now().UnixNano()},
			"contentChanges": []map[string]any{{"text": string(src)}},
		})
	}

	src, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.opened[uri] = true
	s.mu.Unlock()

	return s.conn.Notify("textDocument/didOpen", map[string]any{
		"textDocument": map[string]any{
			"uri":        uri,
			"languageId": s.lang,
			"version":    1,
			"text":       string(src),
		},
	})
}

// Definition returns where the symbol at pos is declared.
func (s *Server) Definition(ctx context.Context, path string, pos Position) ([]Location, error) {
	return s.locations(ctx, "textDocument/definition", path, pos, nil)
}

// References returns every use of the symbol at pos.
func (s *Server) References(ctx context.Context, path string, pos Position, includeDecl bool) ([]Location, error) {
	return s.locations(ctx, "textDocument/references", path, pos, map[string]any{
		"context": map[string]any{"includeDeclaration": includeDecl},
	})
}

func (s *Server) locations(ctx context.Context, method, path string, pos Position, extra map[string]any) ([]Location, error) {
	if err := s.open(path); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	params := map[string]any{
		"textDocument": map[string]any{"uri": pathToURI(path)},
		"position":     pos,
	}
	for k, v := range extra {
		params[k] = v
	}

	// The spec allows Location, []Location or []LocationLink here and
	// servers genuinely differ, so decode into json.RawMessage and sort it
	// out rather than trusting one shape.
	var raw json.RawMessage
	if err := s.conn.Call(ctx, method, params, &raw); err != nil {
		return nil, err
	}
	return decodeLocations(raw), nil
}

func decodeLocations(raw json.RawMessage) []Location {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	// A LocationLink array unmarshals into []Location without error -- the
	// keys simply do not match, leaving every field zero. So the check is on
	// the decoded content, not on the error: a Location with no URI is not a
	// Location, it is a different shape that happened to parse.
	var list []Location
	if err := json.Unmarshal(raw, &list); err == nil && len(list) > 0 && list[0].URI != "" {
		return list
	}
	var one Location
	if err := json.Unmarshal(raw, &one); err == nil && one.URI != "" {
		return []Location{one}
	}
	// LocationLink: the target is under a different key.
	var links []struct {
		TargetURI   string `json:"targetUri"`
		TargetRange Range  `json:"targetSelectionRange"`
	}
	if err := json.Unmarshal(raw, &links); err == nil {
		out := make([]Location, 0, len(links))
		for _, l := range links {
			out = append(out, Location{URI: l.TargetURI, Range: l.TargetRange})
		}
		return out
	}
	return nil
}

// Symbols returns the declarations in one file.
func (s *Server) Symbols(ctx context.Context, path string) ([]DocumentSymbol, error) {
	if err := s.open(path); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()

	var raw json.RawMessage
	if err := s.conn.Call(ctx, "textDocument/documentSymbol", map[string]any{
		"textDocument": map[string]any{"uri": pathToURI(path)},
	}, &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}

	var hierarchical []DocumentSymbol
	if err := json.Unmarshal(raw, &hierarchical); err == nil && len(hierarchical) > 0 && hierarchical[0].Name != "" {
		return hierarchical, nil
	}
	// SymbolInformation, the older flat shape.
	var flat []struct {
		Name     string   `json:"name"`
		Kind     int      `json:"kind"`
		Location Location `json:"location"`
	}
	if err := json.Unmarshal(raw, &flat); err != nil {
		return nil, nil
	}
	out := make([]DocumentSymbol, 0, len(flat))
	for _, f := range flat {
		out = append(out, DocumentSymbol{Name: f.Name, Kind: f.Kind, Range: f.Location.Range, Selection: f.Location.Range})
	}
	return out, nil
}

// Diagnostics returns the problems the server reported for a file, and
// whether any were actually received.
//
// The bool is the load-bearing part. Diagnostics are pushed, not requested,
// so an empty list means either "this file is clean" or "the server has not
// looked at it yet", and those are opposite answers to the question the
// agent is asking. Reporting them as the same thing is how a tool tells an
// agent its broken edit compiled.
func (s *Server) Diagnostics(ctx context.Context, path string) ([]Diagnostic, bool, error) {
	uri := pathToURI(path)

	s.mu.Lock()
	wait, have := s.diags[uri]
	if !have {
		ch, ok := s.diagCh[uri]
		if !ok {
			ch = make(chan struct{})
			s.diagCh[uri] = ch
		}
		s.mu.Unlock()
		if err := s.open(path); err != nil {
			return nil, false, err
		}
		select {
		case <-ch:
		case <-time.After(diagnosticsWait):
			return nil, false, nil
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
		s.mu.Lock()
		wait = s.diags[uri]
	}
	out := append([]Diagnostic(nil), wait...)
	s.mu.Unlock()
	return out, true, nil
}

// Refresh drops the cached diagnostics for a file so the next call waits
// for fresh ones. Called after an edit: stale diagnostics describing the
// pre-edit file are worse than none.
func (s *Server) Refresh(path string) {
	uri := pathToURI(path)
	s.mu.Lock()
	delete(s.diags, uri)
	s.mu.Unlock()
	_ = s.open(path)
}

// Close shuts the server down politely, then kills it.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.shutdown {
		s.mu.Unlock()
		return nil
	}
	s.shutdown = true
	s.mu.Unlock()

	// Best-effort: a server that ignores shutdown gets killed below. This
	// is why the exit notification is not checked either.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = s.conn.Call(ctx, "shutdown", nil, nil)
	cancel()
	_ = s.conn.Notify("exit", nil)
	_ = s.conn.Close()

	if s.cmd != nil && s.cmd.Process != nil {
		done := make(chan struct{})
		go func() { _, _ = s.cmd.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = s.cmd.Process.Kill()
		}
	}
	return nil
}

func pathToURI(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	abs = filepath.ToSlash(abs)
	if !strings.HasPrefix(abs, "/") {
		abs = "/" + abs // Windows drive letters
	}
	return "file://" + abs
}

// URIToPath converts back, for rendering results as workspace paths.
func URIToPath(uri string) string {
	p := strings.TrimPrefix(uri, "file://")
	if len(p) > 2 && p[0] == '/' && p[2] == ':' {
		p = p[1:] // Windows: /C:/x -> C:/x
	}
	return filepath.FromSlash(p)
}
