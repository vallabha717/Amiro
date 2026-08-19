package uimessage

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// sseDataPrefix is the only SSE field this protocol uses. The AI SDK's
// JsonToSseTransformStream writes `data: <json>\n\n` and nothing else -- no
// event names, no ids, no retry directives -- so a decoder that handled the
// full SSE grammar would be describing a stream this app never produces.
const sseDataPrefix = "data: "

// doneSentinel is the terminal frame's payload. Not JSON, which is why it
// is matched before any decode is attempted.
const doneSentinel = "[DONE]"

// maxFrameBytes caps a single frame.
//
// bufio.Scanner defaults to 64 KiB, and one frame is routinely larger than
// that: a tool-output frame carries whatever the tool returned, and
// read_file's windowed default is ~2000 lines. A stream that died on a
// large file read would fail exactly on the turns that were working.
const maxFrameBytes = 16 << 20

// Scanner reads Frames off a UI Message Stream.
//
// The mirror of Writer, and the half this package never had. Used by any Go
// client of the sidecar -- today the terminal UI, tomorrow anything else
// that wants to watch a turn without being a browser.
//
// Usage follows bufio.Scanner, which is what a reader of this code will
// already have in mind:
//
//	sc := uimessage.NewScanner(resp.Body)
//	for sc.Scan() {
//	    frame := sc.Frame()
//	    ...
//	}
//	if err := sc.Err(); err != nil { ... }
type Scanner struct {
	lines *bufio.Scanner
	frame Frame
	err   error
	done  bool
}

// NewScanner returns a Scanner reading frames from r.
func NewScanner(r io.Reader) *Scanner {
	lines := bufio.NewScanner(r)
	lines.Buffer(make([]byte, 0, 64<<10), maxFrameBytes)
	return &Scanner{lines: lines}
}

// Scan advances to the next frame, returning false at end of stream or on
// the first error.
//
// The terminal `[DONE]` sentinel is reported as a FrameDone frame and *then*
// ends the stream, so a consumer can tell an orderly finish from a dropped
// connection -- the distinction a plain io.EOF loses, and the one that
// decides whether a client shows "done" or "the backend went away".
func (s *Scanner) Scan() bool {
	if s.err != nil || s.done {
		return false
	}
	for s.lines.Scan() {
		line := bytes.TrimSuffix(s.lines.Bytes(), []byte("\r"))
		// Blank separators between frames, and any field this protocol does
		// not use, are skipped rather than treated as errors: a stricter
		// reader would break on a proxy that inserts SSE comment lines for
		// keep-alive, which is a normal thing for a proxy to do.
		payload, ok := bytes.CutPrefix(line, []byte(sseDataPrefix))
		if !ok {
			continue
		}
		if string(payload) == doneSentinel {
			s.frame = Frame{Type: FrameDone}
			s.done = true
			return true
		}
		var f Frame
		if err := json.Unmarshal(payload, &f); err != nil {
			s.err = fmt.Errorf("uimessage: decode frame: %w", err)
			return false
		}
		s.frame = f
		return true
	}
	s.err = s.lines.Err()
	return false
}

// Frame returns the frame read by the most recent call to Scan.
func (s *Scanner) Frame() Frame { return s.frame }

// Err returns the first error encountered, if any. A stream that ended
// without a [DONE] sentinel is not an error here -- the caller decides
// whether that matters, since a canceled turn is a legitimate way for one
// to stop.
func (s *Scanner) Err() error { return s.err }

// Done reports whether the stream ended with its [DONE] sentinel.
func (s *Scanner) Done() bool { return s.done }

// DecodeFrame decodes a single frame's JSON payload -- the bytes after
// `data: `. For decoding a whole stream, use Scanner.
func DecodeFrame(payload []byte) (Frame, error) {
	var f Frame
	if err := json.Unmarshal(payload, &f); err != nil {
		return Frame{}, fmt.Errorf("uimessage: decode frame: %w", err)
	}
	return f, nil
}

// Encode renders a frame as its SSE representation, terminating separator
// included.
//
// For tests and for tools that replay a recorded stream. Not what Writer
// uses -- see Frame's doc comment for why that stayed on map literals.
func (f Frame) Encode() ([]byte, error) {
	if f.Type == FrameDone {
		return []byte(sseDataPrefix + doneSentinel + "\n\n"), nil
	}
	b, err := json.Marshal(f)
	if err != nil {
		return nil, fmt.Errorf("uimessage: encode frame: %w", err)
	}
	out := make([]byte, 0, len(sseDataPrefix)+len(b)+2)
	out = append(out, sseDataPrefix...)
	out = append(out, b...)
	return append(out, '\n', '\n'), nil
}
