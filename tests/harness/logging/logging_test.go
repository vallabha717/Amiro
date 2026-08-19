package logging

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"amiro/tests/harness/config"
)

func newTestLogger(t *testing.T, secrets ...string) *Logger {
	t.Helper()
	cfg := config.Defaults()
	if len(secrets) > 0 {
		cfg.Providers.LLM = []config.LLMProvider{{ID: "anthropic", APIKey: secrets[0]}}
	}
	l, err := New(t.TempDir(), "run-1", time.Now().UTC(), LevelDebug, NewRedactor(&cfg))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l
}

func TestEmit_WritesOneJSONObjectPerLine(t *testing.T) {
	l := newTestLogger(t)
	l.Emit(Event{Surface: "backend", Test: "backend/smoke/TestX", Kind: KindHTTP, Msg: "GET /health",
		Detail: map[string]any{"status": 200}})
	l.Emit(Event{Surface: "ui", Kind: KindAction, Msg: "click"})

	lines := readLines(t, l.Path(EventsFile))
	if len(lines) != 2 {
		t.Fatalf("wrote %d lines, want 2", len(lines))
	}
	var first Event
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("line 1 is not JSON: %v", err)
	}
	if first.Run != "run-1" {
		t.Errorf("run id = %q, want it filled in from the logger", first.Run)
	}
	if first.TS.IsZero() {
		t.Error("the timestamp was not stamped at write time")
	}
}

// TestRedaction_MarkersAreNotHTMLEscaped guards a subtle regression.
//
// encoding/json escapes < and > by default, which rendered every marker as
// "<redacted:...>" -- unreadable, and invisible to any grep for
// the marker, including the one suites/meta uses to prove redaction fired.
// The guard for the redactor was itself defeated by the encoder.
func TestRedaction_MarkersAreNotHTMLEscaped(t *testing.T) {
	const secret = "sk-a-real-looking-key"
	l := newTestLogger(t, secret)
	l.Emit(Event{Surface: "backend", Kind: KindHTTP, Msg: "using " + secret})

	raw, err := os.ReadFile(l.Path(EventsFile))
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if strings.Contains(body, secret) {
		t.Fatal("the secret was written in the clear")
	}
	want := config.Fingerprint(secret)
	if !strings.Contains(body, want) {
		t.Errorf("the marker %s is not present verbatim (HTML escaping?):\n%s", want, body)
	}
	// The failure mode being guarded against, spelled out: encoding/json
	// would have written \u003credacted...\u003e, which no grep for the
	// marker can find.
	if strings.Contains(body, `\u003c`) {
		t.Error("the output is HTML-escaped; markers become ungreppable")
	}
}

// TestRedactor_DescendsIntoNestedJSONByFieldName is the leak the meta suite
// caught: a session token in a response body.
func TestRedactor_DescendsIntoNestedJSONByFieldName(t *testing.T) {
	l := newTestLogger(t)
	l.NDJSON("backend/http.ndjson", map[string]any{
		"path": "/api/auth/login",
		"response": map[string]any{
			"user":  map[string]any{"id": "abc", "email": "user@amiro.test"},
			"token": "d89b2f75e75c38bac58400711a6c400e6a43442a97d5b459e2d4fdb5ada4d93f",
		},
	})
	body := strings.Join(readLines(t, l.Path("backend/http.ndjson")), "\n")
	if strings.Contains(body, "d89b2f75") {
		t.Errorf("a nested `token` field was not redacted:\n%s", body)
	}
	// Non-secret neighbours must survive, or the log stops being useful.
	if !strings.Contains(body, "user@amiro.test") {
		t.Errorf("redaction removed more than it should:\n%s", body)
	}
}

// TestRedactor_ReplacesASecretSplitAcrossTwoWrites is the stream case.
//
// A pipe delivers arbitrary chunk boundaries. A redactor that worked per
// Write would let a key split across two of them through untouched, which is
// the one leak nobody would ever reproduce deliberately.
func TestRedactor_ReplacesASecretSplitAcrossTwoWrites(t *testing.T) {
	const secret = "sk-split-across-chunks"
	l := newTestLogger(t, secret)
	w, err := l.Stream("backend/server.stdout.log")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("token is sk-split")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("-across-chunks\n")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(l.Path("backend/server.stdout.log"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), secret) {
		t.Errorf("a secret split across two writes reached disk:\n%s", raw)
	}
}

// TestStream_FlushesAnUnterminatedTailOnClose keeps the last line of a
// process that died mid-sentence.
func TestStream_FlushesAnUnterminatedTailOnClose(t *testing.T) {
	l := newTestLogger(t)
	w, err := l.Stream("backend/server.stderr.log")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("panic: no newline follows this")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(l.Path("backend/server.stderr.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "panic: no newline") {
		t.Errorf("the unterminated tail was lost: %q", raw)
	}
}

// TestAppendLine_ConcurrentWritersProduceNoTornLines is the property the
// file lock exists for. events.ndjson is appended to by several processes,
// and one interleaved line makes the whole timeline unparseable.
func TestAppendLine_ConcurrentWritersProduceNoTornLines(t *testing.T) {
	l := newTestLogger(t)
	const writers, each = 8, 40

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				l.Emit(Event{Surface: "backend", Kind: KindTest,
					Msg:    "line",
					Detail: map[string]any{"writer": w, "i": i, "pad": strings.Repeat("x", 200)}})
			}
		}(w)
	}
	wg.Wait()

	lines := readLines(t, l.Path(EventsFile))
	if len(lines) != writers*each {
		t.Errorf("wrote %d lines, want %d", len(lines), writers*each)
	}
	for i, line := range lines {
		var e Event
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatalf("line %d is torn: %v\n%s", i+1, err, line)
		}
	}
}

func TestWriteJSON_IsIndentedAndRedacted(t *testing.T) {
	const secret = "sk-in-the-manifest"
	l := newTestLogger(t, secret)
	if err := l.WriteJSON("run.json", map[string]any{"key": secret, "n": 1}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(l.Path("run.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), secret) {
		t.Error("run.json holds a secret in the clear; it is meant to be pasteable into an issue")
	}
	if !strings.Contains(string(raw), "\n  ") {
		t.Error("run.json is not indented")
	}
}

func TestParseLevel_DefaultsToInfoOnAnythingUnrecognised(t *testing.T) {
	for input, want := range map[string]Level{
		"debug": LevelDebug, "DEBUG": LevelDebug, " warn ": LevelWarn,
		"error": LevelError, "info": LevelInfo, "": LevelInfo, "chatty": LevelInfo,
	} {
		if got := ParseLevel(input); got != want {
			t.Errorf("ParseLevel(%q) = %d, want %d", input, got, want)
		}
	}
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", filepath.Base(path), err)
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}
