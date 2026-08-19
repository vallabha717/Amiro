package logging

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// EventsFile is the merged timeline every surface appends to. One JSON
// object per line, one clock, every process interleaved -- the single most
// useful artifact a run produces (docs/testing/04-artifacts-and-logs.md).
const EventsFile = "events.ndjson"

// Kinds of event. Not an exhaustive enum -- a surface may invent its own --
// but these are the ones `amirotest report --timeline` knows how to render.
const (
	KindRun      = "run"      // run started, run finished
	KindTest     = "test"     // test started, passed, failed, skipped
	KindProcess  = "process"  // spawn, ready, stop, exit
	KindHTTP     = "http"     // a request/response through harness/apiclient
	KindStream   = "stream"   // one decoded SSE frame
	KindAction   = "action"   // a UI or TUI interaction
	KindAssert   = "assert"   // an assertion outcome
	KindCassette = "cassette" // hit / miss / recorded
	KindConfig   = "config"   // resolution, warnings, overrides
)

// Event is one line of events.ndjson.
type Event struct {
	TS      time.Time      `json:"ts"`
	Run     string         `json:"run"`
	Surface string         `json:"surface"`
	Test    string         `json:"test,omitempty"`
	Kind    string         `json:"kind"`
	Msg     string         `json:"msg"`
	Detail  map[string]any `json:"detail,omitempty"`
}

// Level filters what is written. debug adds full bodies and per-frame dumps.
type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

func ParseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "warn":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

// Logger owns every file in one run directory.
//
// One Logger per process. Several processes may hold one for the SAME run
// directory at once -- the Go harness, a `go test` shard, the Playwright
// reporter -- which is why appends go through appendLine's file lock rather
// than an in-process mutex alone.
type Logger struct {
	runID    string
	dir      string
	level    Level
	redactor *Redactor

	mu    sync.Mutex
	files map[string]*os.File
	// startedAt anchors relative timings so two processes agree on t=0 even
	// if their clocks differ slightly. Carried across process boundaries in
	// AMIRO_TEST_RUN_STARTED_AT.
	startedAt time.Time
}

// New opens a logger against an existing run directory.
func New(dir, runID string, startedAt time.Time, level Level, redactor *Redactor) (*Logger, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("creating run directory %s: %w", dir, err)
	}
	if redactor == nil {
		redactor = &Redactor{fields: map[string]bool{}}
	}
	return &Logger{
		runID:     runID,
		dir:       dir,
		level:     level,
		redactor:  redactor,
		files:     map[string]*os.File{},
		startedAt: startedAt,
	}, nil
}

// Dir is the run directory every path is relative to.
func (l *Logger) Dir() string            { return l.dir }
func (l *Logger) RunID() string          { return l.runID }
func (l *Logger) Level() Level           { return l.level }
func (l *Logger) Redactor() *Redactor    { return l.redactor }
func (l *Logger) StartedAt() time.Time   { return l.startedAt }
func (l *Logger) Path(rel string) string { return filepath.Join(l.dir, filepath.FromSlash(rel)) }

// Emit appends one event to the merged timeline.
//
// Timestamps are filled in here rather than by the caller so that every
// line in events.ndjson is stamped at the moment it is written, which is
// what makes the file sortable without further thought.
func (l *Logger) Emit(e Event) {
	if e.TS.IsZero() {
		e.TS = time.Now().UTC()
	}
	if e.Run == "" {
		e.Run = l.runID
	}
	e.Msg = l.redactor.String(e.Msg)
	if e.Detail != nil {
		e.Detail = l.redactDetail(e.Detail)
	}
	line, err := marshal(e)
	if err != nil {
		return
	}
	l.appendLine(EventsFile, line)
}

func (l *Logger) redactDetail(d map[string]any) map[string]any {
	raw, err := marshal(d)
	if err != nil {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(l.redactor.JSON(raw), &out); err != nil {
		return nil
	}
	return out
}

// NDJSON appends one record to a per-surface file, e.g.
// "backend/<test-id>/http.ndjson". The record is redacted as JSON, so a
// field named in providers.redact is replaced wherever it is nested.
func (l *Logger) NDJSON(rel string, record any) {
	raw, err := marshal(record)
	if err != nil {
		return
	}
	l.appendLine(rel, l.redactor.JSON(raw))
}

// marshal encodes without Go's default HTML escaping.
//
// encoding/json turns < and > into \u003c and \u003e, which would render
// every redaction marker as "\u003credacted:sha256:...\u003e" -- unreadable
// in a log, and invisible to any grep for the marker, including the one
// suites/meta uses to prove redaction happened. There is no HTML here to
// escape for; these files are read by people and by jq.
func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// appendLine writes one whole line under a file lock.
//
// Opening per write rather than holding the handle costs a syscall and buys
// the thing that matters: several processes appending to events.ndjson
// cannot interleave a partial line. The lock is advisory and the write is
// O_APPEND, so even where the lock is a no-op the failure mode is
// reordering, never a torn record.
func (l *Logger) appendLine(rel string, line []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()

	path := l.Path(rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()

	unlock := lockFile(f)
	defer unlock()

	buf := make([]byte, 0, len(line)+1)
	buf = append(buf, line...)
	buf = append(buf, '\n')
	_, _ = f.Write(buf)
}

// Stream returns a writer for a raw process stream (server.stdout.log).
//
// The returned writer redacts line by line as bytes arrive. It is NOT
// buffered beyond one line: harness/process copies into it as the child
// produces output, so a process that hangs still leaves everything it said
// before hanging.
func (l *Logger) Stream(rel string) (io.WriteCloser, error) {
	path := l.Path(rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	l.files[rel] = f
	l.mu.Unlock()
	return &redactingWriter{f: f, r: l.redactor}, nil
}

// WriteFile writes a whole file into the run directory, redacted.
func (l *Logger) WriteFile(rel string, data []byte) error {
	path := l.Path(rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, l.redactor.Bytes(data), 0o644)
}

// WriteJSON writes an indented JSON file into the run directory, redacted.
//
// Redaction happens on the COMPACT form and the result is indented
// afterwards. The order matters: Redactor.JSON re-marshals what it walks, so
// redacting an already-indented document would flatten it -- run.json is
// meant to be read by a person, and a single 4 KB line is not that.
func (l *Logger) WriteJSON(rel string, v any) error {
	raw, err := marshal(v)
	if err != nil {
		return err
	}
	var indented bytes.Buffer
	if err := json.Indent(&indented, l.redactor.JSON(raw), "", "  "); err != nil {
		return err
	}
	indented.WriteByte('\n')
	return l.WriteFile(rel, indented.Bytes())
}

// Close closes every stream handle. Safe to call more than once.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	names := make([]string, 0, len(l.files))
	for name := range l.files {
		names = append(names, name)
	}
	sort.Strings(names)
	var firstErr error
	for _, name := range names {
		if err := l.files[name].Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(l.files, name)
	}
	return firstErr
}

// redactingWriter redacts each Write before it reaches the file.
//
// It holds a tail buffer because a secret can straddle two Writes: a pipe
// delivers arbitrary chunk boundaries, and a key split across them would
// pass through untouched. Anything not ending in a newline is held back
// until the next write or Close.
type redactingWriter struct {
	f    *os.File
	r    *Redactor
	tail []byte
	mu   sync.Mutex
}

func (w *redactingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	n := len(p)
	buf := append(w.tail, p...)
	cut := lastNewline(buf)
	if cut < 0 {
		// No complete line yet. Hold it -- but not without bound: a process
		// emitting a megabyte with no newline would otherwise be buffered
		// forever, which is the failure this whole design is avoiding.
		if len(buf) > 64<<10 {
			if _, err := w.f.Write(w.r.Bytes(buf)); err != nil {
				return 0, err
			}
			w.tail = nil
			return n, nil
		}
		w.tail = buf
		return n, nil
	}
	complete, rest := buf[:cut+1], buf[cut+1:]
	if _, err := w.f.Write(w.r.Bytes(complete)); err != nil {
		return 0, err
	}
	w.tail = append(w.tail[:0], rest...)
	return n, nil
}

func (w *redactingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.tail) > 0 {
		_, _ = w.f.Write(w.r.Bytes(w.tail))
		w.tail = nil
	}
	return nil
}

func lastNewline(b []byte) int {
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] == '\n' {
			return i
		}
	}
	return -1
}
