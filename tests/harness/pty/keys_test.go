package pty

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKeyRecorder_WritesValidNDJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keys.ndjson")

	kr, err := NewKeyRecorder(path)
	if err != nil {
		t.Fatalf("NewKeyRecorder: %v", err)
	}

	_ = kr.Record("ctrl+p", KeyCtrlP)
	_ = kr.Record("enter", KeyEnter)
	_ = kr.Record("raw", "/models")
	_ = kr.Close()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading keys.ndjson: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines in keys.ndjson, got %d", len(lines))
	}

	for _, line := range lines {
		var ev KeyEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("invalid json line %q: %v", line, err)
		}
		if ev.Timestamp == "" || ev.Key == "" {
			t.Errorf("incomplete key event: %+v", ev)
		}
	}
}
