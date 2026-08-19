package pty

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCastWriter_WritesValidAsciinemaV2(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.cast")

	cw, err := NewCastWriter(path, 120, 40, "xterm-256color")
	if err != nil {
		t.Fatalf("NewCastWriter: %v", err)
	}

	_ = cw.RecordOutput("Hello from TUI\r\n")
	_ = cw.RecordInput("\x10")
	_ = cw.RecordOutput("Opened command palette\r\n")
	_ = cw.Close()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading cast file: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines in cast file (header + 3 events), got %d:\n%s", len(lines), string(data))
	}

	var header CastHeader
	if err := json.Unmarshal([]byte(lines[0]), &header); err != nil {
		t.Fatalf("invalid cast header JSON: %v\nline: %s", err, lines[0])
	}
	if header.Version != 2 || header.Width != 120 || header.Height != 40 {
		t.Errorf("header = %+v, want v2 120x40", header)
	}

	// Validate events
	for i, line := range lines[1:] {
		var ev []any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("event %d invalid JSON: %v\nline: %s", i, err, line)
		}
		if len(ev) != 3 {
			t.Errorf("event %d length = %d, want 3", i, len(ev))
		}
		if _, ok := ev[0].(float64); !ok {
			t.Errorf("event %d timestamp not float: %v", i, ev[0])
		}
		if typ, ok := ev[1].(string); !ok || (typ != "o" && typ != "i") {
			t.Errorf("event %d type invalid: %v", i, ev[1])
		}
	}
}
