package pty

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// CastHeader is the Asciinema v2 header.
type CastHeader struct {
	Version   int               `json:"version"`
	Width     int               `json:"width"`
	Height    int               `json:"height"`
	Timestamp int64             `json:"timestamp"`
	Env       map[string]string `json:"env,omitempty"`
}

// CastWriter records a terminal session in asciinema v2 format.
type CastWriter struct {
	mu        sync.Mutex
	file      *os.File
	started   time.Time
	width     int
	height    int
	closed    bool
}

// NewCastWriter opens path for writing an asciinema v2 recording.
func NewCastWriter(path string, width, height int, term string) (*CastWriter, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, fmt.Errorf("creating cast file %s: %w", path, err)
	}

	started := time.Now().UTC()
	header := CastHeader{
		Version:   2,
		Width:     width,
		Height:    height,
		Timestamp: started.Unix(),
		Env: map[string]string{
			"TERM": term,
		},
	}
	raw, err := json.Marshal(header)
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("encoding cast header: %w", err)
	}
	if _, err := f.Write(append(raw, '\n')); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("writing cast header: %w", err)
	}

	return &CastWriter{
		file:    f,
		started: started,
		width:   width,
		height:  height,
	}, nil
}

// RecordOutput records an output event ("o").
func (w *CastWriter) RecordOutput(data string) error {
	return w.recordEvent("o", data)
}

// RecordInput records an input event ("i").
func (w *CastWriter) RecordInput(data string) error {
	return w.recordEvent("i", data)
}

func (w *CastWriter) recordEvent(eventType, data string) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed || w.file == nil {
		return nil
	}

	elapsed := time.Since(w.started).Seconds()
	// Asciinema v2 event: [time_seconds, event_type, data]
	event := []any{elapsed, eventType, data}
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = w.file.Write(append(raw, '\n'))
	return err
}

// Close closes the cast writer.
func (w *CastWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return nil
	}
	w.closed = true
	if w.file != nil {
		err := w.file.Close()
		w.file = nil
		return err
	}
	return nil
}

// Writer returns an io.Writer that forwards bytes to RecordOutput.
func (w *CastWriter) Writer() io.Writer {
	return castOutputWriter{w: w}
}

type castOutputWriter struct {
	w *CastWriter
}

func (c castOutputWriter) Write(p []byte) (n int, err error) {
	if err := c.w.RecordOutput(string(p)); err != nil {
		return 0, err
	}
	return len(p), nil
}
