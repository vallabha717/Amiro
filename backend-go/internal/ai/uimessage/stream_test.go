package uimessage

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func frames(t *testing.T, body string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimRight(body, "\n"), "\n\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			out = append(out, map[string]any{"type": "[DONE]"})
			continue
		}
		var frame map[string]any
		if err := json.Unmarshal([]byte(payload), &frame); err != nil {
			t.Fatalf("unmarshal frame %q: %v", payload, err)
		}
		out = append(out, frame)
	}
	return out
}

func TestNewWriter_SetsUIMessageStreamHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	NewWriter(rec)

	for k, v := range Headers {
		if got := rec.Header().Get(k); got != v {
			t.Fatalf("header %q = %q, want %q", k, got, v)
		}
	}
}

func TestWriter_FullSequenceProducesExpectedFrameTypesInOrder(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewWriter(rec)

	_ = w.Start("msg-1")
	_ = w.StartStep()
	_ = w.TextStart("msg-1")
	_ = w.TextDelta("msg-1", "hello")
	_ = w.TextDelta("msg-1", " world")
	_ = w.TextEnd("msg-1")
	_ = w.FinishStep()
	_ = w.Finish(map[string]string{"toolChoice": "auto"})
	_ = w.Done()

	got := frames(t, rec.Body.String())
	wantTypes := []string{"start", "start-step", "text-start", "text-delta", "text-delta", "text-end", "finish-step", "finish", "[DONE]"}
	if len(got) != len(wantTypes) {
		t.Fatalf("got %d frames, want %d: %+v", len(got), len(wantTypes), got)
	}
	for i, want := range wantTypes {
		if got[i]["type"] != want {
			t.Fatalf("frame %d type = %v, want %q", i, got[i]["type"], want)
		}
	}
}

func TestWriter_TextDeltaCarriesIDAndDelta(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewWriter(rec)
	_ = w.TextDelta("part-1", "hi")

	got := frames(t, rec.Body.String())
	if got[0]["id"] != "part-1" || got[0]["delta"] != "hi" {
		t.Fatalf("got %+v", got[0])
	}
}

func TestWriter_FinishOmitsMessageMetadataWhenNil(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewWriter(rec)
	_ = w.Finish(nil)

	got := frames(t, rec.Body.String())
	if _, ok := got[0]["messageMetadata"]; ok {
		t.Fatalf("got %+v, want no messageMetadata key when nil is passed", got[0])
	}
}

func TestWriter_ErrorFrameCarriesErrorText(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewWriter(rec)
	_ = w.Error("boom")

	got := frames(t, rec.Body.String())
	if got[0]["type"] != "error" || got[0]["errorText"] != "boom" {
		t.Fatalf("got %+v", got[0])
	}
}

func TestWriter_ToolInputAvailableCarriesIDNameAndInput(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewWriter(rec)
	_ = w.ToolInputAvailable("call_1", "createBarChart", map[string]any{"title": "Sales"})

	got := frames(t, rec.Body.String())
	if len(got) != 1 {
		t.Fatalf("got %d frames, want 1", len(got))
	}
	frame := got[0]
	if frame["type"] != "tool-input-available" {
		t.Fatalf("type = %v, want tool-input-available", frame["type"])
	}
	if frame["toolCallId"] != "call_1" || frame["toolName"] != "createBarChart" {
		t.Fatalf("frame = %+v", frame)
	}
	input, _ := frame["input"].(map[string]any)
	if input["title"] != "Sales" {
		t.Fatalf("input = %+v, want title=Sales", frame["input"])
	}
}

func TestWriter_ToolOutputAvailableCarriesIDAndOutput(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewWriter(rec)
	_ = w.ToolOutputAvailable("call_1", "Success")

	got := frames(t, rec.Body.String())[0]
	if got["type"] != "tool-output-available" || got["toolCallId"] != "call_1" || got["output"] != "Success" {
		t.Fatalf("frame = %+v", got)
	}
}

func TestWriter_ToolOutputErrorCarriesIDAndErrorText(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewWriter(rec)
	_ = w.ToolOutputError("call_1", "boom")

	got := frames(t, rec.Body.String())[0]
	if got["type"] != "tool-output-error" || got["toolCallId"] != "call_1" || got["errorText"] != "boom" {
		t.Fatalf("frame = %+v", got)
	}
}

func TestWriter_DoneWritesTerminalDoneSentinel(t *testing.T) {
	rec := httptest.NewRecorder()
	w := NewWriter(rec)
	_ = w.Done()

	if !strings.Contains(rec.Body.String(), "data: [DONE]\n\n") {
		t.Fatalf("body = %q, want a trailing data: [DONE] frame", rec.Body.String())
	}
}
