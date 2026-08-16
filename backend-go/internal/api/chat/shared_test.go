package chat

import (
	"encoding/json"
	"testing"

	bifrostai "amiro/backend/internal/ai/bifrost"
	"amiro/backend/internal/db/models"
)

func rawParts(t *testing.T, parts ...map[string]any) []json.RawMessage {
	t.Helper()
	out := make([]json.RawMessage, 0, len(parts))
	for _, p := range parts {
		b, err := json.Marshal(p)
		if err != nil {
			t.Fatalf("marshal part: %v", err)
		}
		out = append(out, b)
	}
	return out
}

func TestUIMessage_TextOfJoinsOnlyTextParts(t *testing.T) {
	m := uiMessage{Parts: rawParts(t,
		map[string]any{"type": "text", "text": "hello"},
		map[string]any{"type": "file", "url": "http://example.invalid/f.png"},
		map[string]any{"type": "text", "text": "world"},
	)}
	got := m.textOf()
	want := "hello\n\nworld"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestUIMessage_TextOfIsEmptyWithNoTextParts(t *testing.T) {
	m := uiMessage{Parts: rawParts(t, map[string]any{"type": "file", "url": "x"})}
	if got := m.textOf(); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}

func TestUIMessage_ToEngineMessagesMapsRoles(t *testing.T) {
	cases := map[string]bifrostai.MessageRole{
		"user":      bifrostai.RoleUser,
		"assistant": bifrostai.RoleAssistant,
		"system":    bifrostai.RoleSystem,
		"bogus":     bifrostai.RoleUser,
	}
	for role, want := range cases {
		m := uiMessage{Role: role, Parts: rawParts(t, map[string]any{"type": "text", "text": "hi"})}
		got := m.toEngineMessages()
		if len(got) != 1 {
			t.Fatalf("role %q: got %d messages, want 1: %+v", role, len(got), got)
		}
		if got[0].Role != want {
			t.Fatalf("role %q -> %q, want %q", role, got[0].Role, want)
		}
		if got[0].Text != "hi" {
			t.Fatalf("text = %q, want %q", got[0].Text, "hi")
		}
	}
}

func TestUIMessage_ToEngineMessagesTextOnlyYieldsOneMessage(t *testing.T) {
	m := uiMessage{Role: "assistant", Parts: rawParts(t,
		map[string]any{"type": "text", "text": "hello"},
		map[string]any{"type": "text", "text": "world"},
	)}
	got := m.toEngineMessages()
	if len(got) != 1 || got[0].Text != "hello\n\nworld" {
		t.Fatalf("got %+v", got)
	}
}

func TestUIMessage_ToEngineMessagesSplitsCompletedToolCallIntoCallAndResultPair(t *testing.T) {
	m := uiMessage{Role: "assistant", Parts: rawParts(t, map[string]any{
		"type": "tool-createBarChart", "toolCallId": "call_1", "state": "output-available",
		"input": map[string]any{"title": "Sales"}, "output": "Success",
	})}
	got := m.toEngineMessages()
	if len(got) != 2 {
		t.Fatalf("got %d messages, want 2 (assistant tool call + tool result): %+v", len(got), got)
	}
	if got[0].Role != bifrostai.RoleAssistant || len(got[0].ToolCalls) != 1 {
		t.Fatalf("got first message %+v, want an assistant tool call", got[0])
	}
	call := got[0].ToolCalls[0]
	if call.ID != "call_1" || call.Name != "createBarChart" || call.Arguments != `{"title":"Sales"}` {
		t.Fatalf("got tool call %+v", call)
	}
	if got[1].Role != bifrostai.RoleTool || got[1].ToolCallID != "call_1" || got[1].Text != "Success" {
		t.Fatalf("got second message %+v, want tool result \"Success\"", got[1])
	}
}

func TestUIMessage_ToEngineMessagesToolErrorUsesErrorTextAsResult(t *testing.T) {
	m := uiMessage{Role: "assistant", Parts: rawParts(t, map[string]any{
		"type": "tool-http", "toolCallId": "call_1", "state": "output-error",
		"input": map[string]any{"url": "http://x"}, "errorText": "boom",
	})}
	got := m.toEngineMessages()
	if len(got) != 2 || got[1].Text != "boom" {
		t.Fatalf("got %+v, want the tool result text to be the error text", got)
	}
}

func TestUIMessage_ToEngineMessagesSkipsPendingToolCall(t *testing.T) {
	m := uiMessage{Role: "assistant", Parts: rawParts(t, map[string]any{
		"type": "tool-python-execution", "toolCallId": "call_1", "state": "input-available",
		"input": map[string]any{"code": "print(1)"},
	})}
	got := m.toEngineMessages()
	if len(got) != 0 {
		t.Fatalf("got %+v, want no engine messages for a still-pending (client) tool call", got)
	}
}

// The text an assistant said before calling a tool belongs on the same
// message as the tool call, the way OpenAI models one assistant turn
// (content + tool_calls together). Emitting it as a separate preceding turn
// replays as two turns, and models re-narrate and re-issue the tool call on
// the next step -- which surfaced as the assistant repeating itself and
// running a client-executed tool twice.
func TestUIMessage_ToEngineMessagesKeepsPreambleOnTheToolCallTurn(t *testing.T) {
	m := uiMessage{Role: "assistant", Parts: rawParts(t,
		map[string]any{"type": "text", "text": "Let me check."},
		map[string]any{"type": "tool-http", "toolCallId": "call_1", "state": "output-available",
			"input": map[string]any{"url": "http://x"}, "output": map[string]any{"ok": true}},
		map[string]any{"type": "text", "text": "Done."},
	)}
	got := m.toEngineMessages()
	if len(got) != 3 {
		t.Fatalf("got %d messages, want 3 (assistant[text+tool-call], tool-result, text): %+v", len(got), got)
	}
	if got[0].Text != "Let me check." || len(got[0].ToolCalls) != 1 {
		t.Fatalf("got first message %+v, want one assistant turn carrying both the preamble and the tool call", got[0])
	}
	if got[0].ToolCalls[0].ID != "call_1" {
		t.Fatalf("got tool call %+v, want call_1", got[0].ToolCalls[0])
	}
	if got[1].Role != bifrostai.RoleTool || got[1].ToolCallID != "call_1" {
		t.Fatalf("got second message %+v, want the tool result for call_1", got[1])
	}
	if got[2].Text != "Done." || got[2].Role != bifrostai.RoleAssistant {
		t.Fatalf("got last message %+v, want the trailing text turn", got[2])
	}
}

func TestUIMessage_ToEngineMessagesAttachesFilePartsToTheTextMessage(t *testing.T) {
	m := uiMessage{Role: "user", Parts: rawParts(t,
		map[string]any{"type": "file", "url": "http://x/f.png", "mediaType": "image/png", "filename": "f.png"},
		map[string]any{"type": "text", "text": "what is this?"},
	)}
	got := m.toEngineMessages()
	if len(got) != 1 {
		t.Fatalf("got %d messages, want 1 combined text+attachment turn: %+v", len(got), got)
	}
	if got[0].Text != "what is this?" {
		t.Fatalf("got text %q, want %q", got[0].Text, "what is this?")
	}
	if len(got[0].Attachments) != 1 || got[0].Attachments[0].URL != "http://x/f.png" || got[0].Attachments[0].MediaType != "image/png" {
		t.Fatalf("got attachments %+v, want the one file part", got[0].Attachments)
	}
}

func TestUIMessage_ToEngineMessagesFilePartAloneStillProducesAMessage(t *testing.T) {
	m := uiMessage{Role: "user", Parts: rawParts(t,
		map[string]any{"type": "file", "url": "http://x/f.png", "mediaType": "image/png"},
	)}
	got := m.toEngineMessages()
	if len(got) != 1 {
		t.Fatalf("got %d messages, want 1 (attachment-only turn should still flush): %+v", len(got), got)
	}
	if got[0].Text != "" || len(got[0].Attachments) != 1 {
		t.Fatalf("got %+v, want an empty-text message carrying the one attachment", got[0])
	}
}

func TestDbMessageToEngines_UnmarshalsStoredParts(t *testing.T) {
	m := models.ChatMessage{
		ID: "msg-1", Role: "assistant",
		Parts: []byte(`[{"type":"text","text":"stored reply"}]`),
	}
	got := dbMessageToEngines(m)
	if len(got) != 1 || got[0].Role != bifrostai.RoleAssistant || got[0].Text != "stored reply" {
		t.Fatalf("got %+v", got)
	}
}

func TestDbMessageToEngines_MalformedPartsYieldsNoMessages(t *testing.T) {
	m := models.ChatMessage{ID: "msg-1", Role: "user", Parts: []byte(`not json`)}
	got := dbMessageToEngines(m)
	if len(got) != 0 {
		t.Fatalf("got %+v, want no messages for malformed parts", got)
	}
}

func TestStringifyToolOutput_UnwrapsJSONString(t *testing.T) {
	got := stringifyToolOutput(json.RawMessage(`"Success"`))
	if got != "Success" {
		t.Fatalf("got %q, want unwrapped string", got)
	}
}

func TestStringifyToolOutput_ForwardsNonStringJSONVerbatim(t *testing.T) {
	got := stringifyToolOutput(json.RawMessage(`{"ok":true}`))
	if got != `{"ok":true}` {
		t.Fatalf("got %q, want the raw JSON text", got)
	}
}

func TestStringifyToolOutput_EmptyInputYieldsEmptyString(t *testing.T) {
	if got := stringifyToolOutput(nil); got != "" {
		t.Fatalf("got %q, want empty", got)
	}
}
