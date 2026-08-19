package pty

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"amiro/tests/harness/logging"
	"amiro/tests/harness/process"
)

// Options describes a PTY session to start.
type Options struct {
	Name        string
	Binary      string
	Args        []string
	Dir         string
	Env         []string
	Width       int
	Height      int
	Term        string
	RecordCasts bool
	LogDir      string
	Surface     string
	Test        string
}

// Session is a running process attached to a virtual terminal.
type Session struct {
	mu      sync.Mutex
	Process *process.Process
	Buffer  *Buffer
	Cast    *CastWriter
	Keys    *KeyRecorder
	device  *ptyDevice
	log     *logging.Logger
	ctx     context.Context
	closed  bool
}

// Start allocates a PTY, starts the binary through the process supervisor,
// and streams its output into a virtual ANSI screen buffer, an asciinema .cast
// recorder, and disk logs.
func Start(ctx context.Context, log *logging.Logger, opts Options) (*Session, error) {
	if opts.Width <= 0 {
		opts.Width = 120
	}
	if opts.Height <= 0 {
		opts.Height = 40
	}
	if opts.Term == "" {
		opts.Term = "xterm-256color"
	}
	if opts.Name == "" {
		opts.Name = "tui"
	}

	dev, err := openPTY(opts.Width, opts.Height)
	if err != nil {
		return nil, fmt.Errorf("allocating PTY: %w", err)
	}

	buf := NewBuffer(opts.Width, opts.Height)

	var cast *CastWriter
	var extraSinks []io.Writer
	extraSinks = append(extraSinks, buf)

	if opts.RecordCasts && log != nil && opts.LogDir != "" {
		castPath := log.Path(filepath.Join(opts.LogDir, "session.cast"))
		if err := os.MkdirAll(filepath.Dir(castPath), 0o755); err != nil {
			_ = dev.Close()
			return nil, fmt.Errorf("creating cast directory: %w", err)
		}
		cw, err := NewCastWriter(castPath, opts.Width, opts.Height, opts.Term)
		if err != nil {
			_ = dev.Close()
			return nil, fmt.Errorf("opening cast writer: %w", err)
		}
		cast = cw
		extraSinks = append(extraSinks, cw.Writer())
	}

	var keyRec *KeyRecorder
	if log != nil && opts.LogDir != "" {
		keyPath := log.Path(filepath.Join(opts.LogDir, "keys.ndjson"))
		if err := os.MkdirAll(filepath.Dir(keyPath), 0o755); err != nil {
			_ = dev.Close()
			if cast != nil {
				_ = cast.Close()
			}
			return nil, fmt.Errorf("creating keys directory: %w", err)
		}
		kr, err := NewKeyRecorder(keyPath)
		if err != nil {
			_ = dev.Close()
			if cast != nil {
				_ = cast.Close()
			}
			return nil, fmt.Errorf("opening key recorder: %w", err)
		}
		keyRec = kr
	}


	env := append([]string(nil), opts.Env...)
	env = append(env,
		"TERM="+opts.Term,
		fmt.Sprintf("COLUMNS=%d", opts.Width),
		fmt.Sprintf("LINES=%d", opts.Height),
	)

	spec := process.Spec{
		Name:    opts.Name,
		Path:    opts.Binary,
		Args:    opts.Args,
		Dir:     opts.Dir,
		Env:     env,
		LogDir:  opts.LogDir,
		Surface: opts.Surface,
		Test:    opts.Test,
	}

	proc, err := process.StartWithPTY(log, spec, dev.master, dev.slave, extraSinks...)
	if err != nil {
		_ = dev.Close()
		if cast != nil {
			_ = cast.Close()
		}
		if keyRec != nil {
			_ = keyRec.Close()
		}
		return nil, fmt.Errorf("starting process under PTY: %w", err)
	}

	s := &Session{
		Process: proc,
		Buffer:  buf,
		Cast:    cast,
		Keys:    keyRec,
		device:  dev,
		log:     log,
		ctx:     ctx,
	}

	return s, nil
}

// Send writes raw bytes/string to the PTY master and records the keystroke.
func (s *Session) Send(input string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed || s.device == nil || s.device.master == nil {
		return fmt.Errorf("session is closed")
	}

	if s.Keys != nil {
		_ = s.Keys.Record("raw", input)
	}
	if s.Cast != nil {
		_ = s.Cast.RecordInput(input)
	}

	_, err := s.device.master.WriteString(input)
	return err
}

// SendKey sends a named key sequence (e.g. KeyEnter, KeyCtrlC) and records it.
func (s *Session) SendKey(keySeq string, keyName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed || s.device == nil || s.device.master == nil {
		return fmt.Errorf("session is closed")
	}

	if s.Keys != nil {
		_ = s.Keys.Record(keyName, keySeq)
	}
	if s.Cast != nil {
		_ = s.Cast.RecordInput(keySeq)
	}

	_, err := s.device.master.WriteString(keySeq)
	return err
}

// SendLine sends a string followed by a newline/carriage return.
func (s *Session) SendLine(line string) error {
	if err := s.Send(line); err != nil {
		return err
	}
	return s.SendKey(KeyEnter, "enter")
}

// Resize changes the terminal dimensions and notifies the process.
func (s *Session) Resize(width, height int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed || s.device == nil {
		return fmt.Errorf("session is closed")
	}

	s.Buffer.Resize(width, height)
	return s.device.Resize(width, height)
}

// WaitForStable waits until the screen buffer stops changing for settleTimeout.
func (s *Session) WaitForStable(settleTimeout time.Duration) error {
	return WaitForStable(s.ctx, s.Buffer, settleTimeout, 50*time.Millisecond)
}

// WaitForText waits until the screen contains s.
func (s *Session) WaitForText(text string, timeout time.Duration) error {
	return WaitForText(s.ctx, s.Buffer, text, timeout)
}

// WaitForFrame waits until predicate returns true.
func (s *Session) WaitForFrame(predicate func(*Buffer) bool, timeout time.Duration) error {
	return WaitForFrame(s.ctx, s.Buffer, timeout, predicate)
}

// Frame returns the current plain text frame.
func (s *Session) Frame() string {
	return s.Buffer.Plain()
}

// Contains reports whether the screen contains text.
func (s *Session) Contains(text string) bool {
	return s.Buffer.Contains(text)
}

// Close gracefully terminates the process, closes the PTY, and flushes recordings.
func (s *Session) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed {
		return nil
	}
	s.closed = true

	var errs []error
	if s.Process != nil {
		if err := s.Process.Stop(s.ctx); err != nil {
			errs = append(errs, fmt.Errorf("stopping process: %w", err))
		}
	}

	if s.device != nil {
		if err := s.device.Close(); err != nil && !errors.Is(err, os.ErrClosed) && !strings.Contains(err.Error(), "file already closed") {
			errs = append(errs, fmt.Errorf("closing PTY: %w", err))
		}
	}


	if s.Cast != nil {
		if err := s.Cast.Close(); err != nil {
			errs = append(errs, fmt.Errorf("closing cast: %w", err))
		}
	}

	if s.Keys != nil {
		if err := s.Keys.Close(); err != nil {
			errs = append(errs, fmt.Errorf("closing keys log: %w", err))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("teardown errors: %v", errs)
	}
	return nil
}
