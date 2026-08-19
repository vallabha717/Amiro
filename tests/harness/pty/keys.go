package pty

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

// Standard key escape sequences matching the TUI's actual key bindings
// (backend-go/internal/tui/keys/keys.go).
const (
	KeyEnter      = "\r"
	KeyCtrlJ      = "\n"
	KeyShiftEnter = "\n"
	KeyCtrlC      = "\x03"
	KeyCtrlP      = "\x10"
	KeyCtrlT      = "\x14"
	KeyCtrlO      = "\x0f"
	KeyCtrlD      = "\x04"
	KeyCtrlK      = "\x0b"
	KeyTab        = "\t"
	KeyEsc        = "\x1b"
	KeyBackspace  = "\x7f"
	KeyUp         = "\x1b[A"
	KeyDown       = "\x1b[B"
	KeyRight      = "\x1b[C"
	KeyLeft       = "\x1b[D"
	KeyPgUp       = "\x1b[5~"
	KeyPgDown     = "\x1b[6~"
	KeyApprove    = "y"
	KeyAlways     = "a"
	KeyDeny       = "n"
)

// KeyEvent records one key press for keys.ndjson.
type KeyEvent struct {
	Timestamp string `json:"timestamp"`
	Key       string `json:"key"`
	Bytes     string `json:"bytes,omitempty"`
}

// KeyRecorder logs keystrokes to a keys.ndjson file.
type KeyRecorder struct {
	mu     sync.Mutex
	file   *os.File
	closed bool
}

// NewKeyRecorder opens path for recording keystrokes.
func NewKeyRecorder(path string) (*KeyRecorder, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, fmt.Errorf("creating keys log %s: %w", path, err)
	}
	return &KeyRecorder{file: f}, nil
}

// Record writes a key event to the ndjson file.
func (k *KeyRecorder) Record(keyName, byteSeq string) error {
	k.mu.Lock()
	defer k.mu.Unlock()

	if k.closed || k.file == nil {
		return nil
	}

	ev := KeyEvent{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Key:       keyName,
		Bytes:     byteSeq,
	}
	raw, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = k.file.Write(append(raw, '\n'))
	return err
}

// Close closes the key recorder.
func (k *KeyRecorder) Close() error {
	k.mu.Lock()
	defer k.mu.Unlock()

	if k.closed {
		return nil
	}
	k.closed = true
	if k.file != nil {
		err := k.file.Close()
		k.file = nil
		return err
	}
	return nil
}
