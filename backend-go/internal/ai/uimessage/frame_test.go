package uimessage

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// writeEveryFrameKind drives every method on Writer exactly once, in the
// order a real turn would, and returns the raw stream.
//
// One place, used by both tests below, because "every method" is the
// property being asserted and a second hand-written list of them would be
// the thing that goes stale.
func writeEveryFrameKind(t *testing.T) string {
	t.Helper()

	rec := httptest.NewRecorder()
	w := NewWriter(rec)

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("write frame: %v", err)
		}
	}

	must(w.Start("msg-1"))
	must(w.StartStep())
	must(w.ReasoningStart("r-1"))
	must(w.ReasoningDelta("r-1", "thinking"))
	must(w.ReasoningEnd("r-1"))
	must(w.TextStart("t-1"))
	must(w.TextDelta("t-1", "hello"))
	must(w.TextEnd("t-1"))
	must(w.ToolInputStart("call-1", "read_file"))
	must(w.ToolInputDelta("call-1", `{"path":`))
	must(w.ToolInputAvailable("call-1", "read_file", map[string]any{"path": "main.go"}))
	must(w.ToolOutputAvailable("call-1", map[string]any{"content": "package main"}))
	must(w.ToolOutputError("call-2", "boom"))
	must(w.Data("tool-approval", "approval-1", map[string]any{"tool": "run_shell"}))
	must(w.Data("compaction", "", map[string]any{"tokensBefore": 100}))
	must(w.Error("stream error"))
	must(w.FinishStep())
	must(w.Finish(map[string]any{"toolCount": 2}))
	must(w.Done())

	return rec.Body.String()
}

// payloads splits a raw stream into its decoded `data:` payloads, as loose
// maps -- what the frame *actually* said on the wire, with no Frame type
// involved.
func payloads(t *testing.T, stream string) []map[string]any {
	t.Helper()

	var out []map[string]any
	for _, line := range strings.Split(stream, "\n") {
		payload, ok := strings.CutPrefix(line, "data: ")
		if !ok || payload == "[DONE]" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(payload), &m); err != nil {
			t.Fatalf("payload %q: %v", payload, err)
		}
		out = append(out, m)
	}
	return out
}

// TestFrameRoundTripsEveryWriterMethod is the drift guard named in Frame's
// doc comment.
//
// Frame is a hand-written model of what Writer's map literals produce, and
// the two are only kept in step by this test: a writer method that gains a
// field Frame does not model would silently drop it for every Go consumer
// of the stream, which is precisely the class of bug a typed layer is
// supposed to remove rather than introduce.
//
// Semantic comparison, not byte comparison, because JSON object key order
// carries no meaning and asserting on it would fail for reasons that are
// not about correctness.
func TestFrameRoundTripsEveryWriterMethod(t *testing.T) {
	stream := writeEveryFrameKind(t)
	original := payloads(t, stream)

	sc := NewScanner(strings.NewReader(stream))
	var decoded []map[string]any
	for sc.Scan() {
		f := sc.Frame()
		if f.Type == FrameDone {
			continue
		}
		encoded, err := f.Encode()
		if err != nil {
			t.Fatalf("re-encode %s: %v", f.Type, err)
		}
		payload, _ := strings.CutPrefix(strings.TrimSuffix(string(encoded), "\n\n"), "data: ")
		var m map[string]any
		if err := json.Unmarshal([]byte(payload), &m); err != nil {
			t.Fatalf("re-encoded %s is not valid JSON: %v", f.Type, err)
		}
		decoded = append(decoded, m)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !sc.Done() {
		t.Fatal("scanner did not observe the [DONE] sentinel")
	}

	if len(decoded) != len(original) {
		t.Fatalf("decoded %d frames, stream had %d", len(decoded), len(original))
	}
	for i := range original {
		if !reflect.DeepEqual(original[i], decoded[i]) {
			t.Errorf("frame %d (%v) lost or changed a field:\n  wire:    %v\n  round-trip: %v",
				i, original[i]["type"], original[i], decoded[i])
		}
	}
}

// TestScannerReportsDoneInBand pins the decision in FrameDone's doc comment:
// an orderly end of stream is distinguishable from a dropped connection.
func TestScannerReportsDoneInBand(t *testing.T) {
	t.Run("orderly", func(t *testing.T) {
		sc := NewScanner(strings.NewReader("data: {\"type\":\"finish\"}\n\ndata: [DONE]\n\n"))
		var types []FrameType
		for sc.Scan() {
			types = append(types, sc.Frame().Type)
		}
		if want := []FrameType{FrameFinish, FrameDone}; !reflect.DeepEqual(types, want) {
			t.Fatalf("got %v, want %v", types, want)
		}
		if !sc.Done() || sc.Err() != nil {
			t.Fatalf("done=%v err=%v, want done with no error", sc.Done(), sc.Err())
		}
	})

	t.Run("truncated", func(t *testing.T) {
		sc := NewScanner(strings.NewReader("data: {\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"hi\"}\n\n"))
		for sc.Scan() {
		}
		if sc.Done() {
			t.Fatal("a stream that stopped mid-turn reported an orderly finish")
		}
		if sc.Err() != nil {
			t.Fatalf("truncation is the caller's judgment, not a decode error: %v", sc.Err())
		}
	})
}

// TestScannerSkipsNonDataLines covers the keep-alive comment case the
// decoder deliberately tolerates.
func TestScannerSkipsNonDataLines(t *testing.T) {
	sc := NewScanner(strings.NewReader(": keep-alive\n\nevent: ignored\ndata: {\"type\":\"start\",\"messageId\":\"m\"}\n\n"))
	if !sc.Scan() {
		t.Fatalf("no frame decoded: %v", sc.Err())
	}
	if got := sc.Frame(); got.Type != FrameStart || got.MessageID != "m" {
		t.Fatalf("got %+v, want a start frame for m", got)
	}
}

// TestDataFrameNaming covers the data- prefix helpers, which are how a
// consumer tells an approval request from a compaction marker.
func TestDataFrameNaming(t *testing.T) {
	approval := Frame{Type: DataFrameType("tool-approval")}
	name, ok := approval.DataName()
	if !ok || name != "tool-approval" {
		t.Fatalf("DataName() = (%q, %v), want (tool-approval, true)", name, ok)
	}
	if !approval.IsData() {
		t.Fatal("IsData() = false for a data frame")
	}
	if text := (Frame{Type: FrameTextDelta}); text.IsData() {
		t.Fatal("IsData() = true for text-delta")
	}
}
