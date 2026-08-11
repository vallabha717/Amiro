package workflow

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestConvertTiptapJSONToText_PlainParagraph(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [{"type": "text", "text": "hello world"}]}
		]
	}`)
	got := ConvertTiptapJSONToText(raw, nil)
	if got != "hello world" {
		t.Fatalf("got %q", got)
	}
}

func TestConvertTiptapJSONToText_MentionResolvesToOutput(t *testing.T) {
	label, _ := json.Marshal(OutputSchemaSourceKey{NodeID: "n1", Path: []string{"answer"}})
	raw := json.RawMessage(`{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [
				{"type": "text", "text": "value: "},
				{"type": "mention", "attrs": {"id": "n1", "label": ` + string(mustJSON(t, string(label))) + `}}
			]}
		]
	}`)
	getOutput := func(key OutputSchemaSourceKey) interface{} {
		if key.NodeID == "n1" {
			return "resolved"
		}
		return nil
	}
	got := ConvertTiptapJSONToText(raw, getOutput)
	if got != "value: resolved" {
		t.Fatalf("got %q", got)
	}
}

func TestConvertTiptapJSONToText_MentionObjectValueIsJSONStringified(t *testing.T) {
	label, _ := json.Marshal(OutputSchemaSourceKey{NodeID: "n1", Path: nil})
	raw := json.RawMessage(`{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [
				{"type": "mention", "attrs": {"id": "n1", "label": ` + string(mustJSON(t, string(label))) + `}}
			]}
		]
	}`)
	getOutput := func(key OutputSchemaSourceKey) interface{} {
		return map[string]interface{}{"a": float64(1)}
	}
	got := ConvertTiptapJSONToText(raw, getOutput)
	if got != `{"a":1}` {
		t.Fatalf("got %q", got)
	}
}

func TestConvertTiptapJSONToText_HardBreakAndBulletList(t *testing.T) {
	raw := json.RawMessage(`{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [{"type": "text", "text": "before"}, {"type": "hardBreak"}]},
			{"type": "bulletList", "content": [
				{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "item one"}]}]},
				{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "item two"}]}]}
			]}
		]
	}`)
	got := ConvertTiptapJSONToText(raw, nil)
	if !strings.Contains(got, "• item one") || !strings.Contains(got, "• item two") {
		t.Fatalf("expected bulleted items, got %q", got)
	}
}

func TestConvertTiptapJSONToText_EmptyInput(t *testing.T) {
	if got := ConvertTiptapJSONToText(nil, nil); got != "" {
		t.Fatalf("expected empty string for nil input, got %q", got)
	}
}

func TestConvertTiptapJSONToMessage_FencesObjectMentionAsJSONBlock(t *testing.T) {
	label, _ := json.Marshal(OutputSchemaSourceKey{NodeID: "n1"})
	raw := json.RawMessage(`{
		"type": "doc",
		"content": [
			{"type": "paragraph", "content": [
				{"type": "mention", "attrs": {"id": "n1", "label": ` + string(mustJSON(t, string(label))) + `}}
			]}
		]
	}`)
	getOutput := func(key OutputSchemaSourceKey) interface{} {
		return map[string]interface{}{"x": float64(1)}
	}
	msg := ConvertTiptapJSONToMessage("user", raw, getOutput)
	if msg.Role != "user" {
		t.Fatalf("expected role user, got %q", msg.Role)
	}
	if !strings.Contains(msg.Text, "```json") {
		t.Fatalf("expected a fenced json block, got %q", msg.Text)
	}
}

func mustJSON(t *testing.T, s string) []byte {
	t.Helper()
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
