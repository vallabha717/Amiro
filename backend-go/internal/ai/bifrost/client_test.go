package bifrostai

import (
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func TestToBifrostMessages_PrependsSystemPromptWhenNonEmpty(t *testing.T) {
	msgs := toBifrostMessages("be nice", []Message{{Role: RoleUser, Text: "hi"}})
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2", len(msgs))
	}
	if msgs[0].Role != schemas.ChatMessageRoleSystem || *msgs[0].Content.ContentStr != "be nice" {
		t.Fatalf("first message = %+v, want the system prompt", msgs[0])
	}
	if msgs[1].Role != schemas.ChatMessageRoleUser || *msgs[1].Content.ContentStr != "hi" {
		t.Fatalf("second message = %+v, want the user turn", msgs[1])
	}
}

func TestToBifrostMessage_ImageAttachmentBecomesImageURLBlock(t *testing.T) {
	msg := toBifrostMessage(Message{
		Role: RoleUser, Text: "what is this?",
		Attachments: []Attachment{{URL: "data:image/png;base64,abc", MediaType: "image/png"}},
	})
	if msg.Content.ContentStr != nil {
		t.Fatalf("expected ContentBlocks, got a plain ContentStr: %+v", msg.Content)
	}
	if len(msg.Content.ContentBlocks) != 2 {
		t.Fatalf("got %d blocks, want 2 (text + image): %+v", len(msg.Content.ContentBlocks), msg.Content.ContentBlocks)
	}
	if msg.Content.ContentBlocks[0].Type != schemas.ChatContentBlockTypeText || *msg.Content.ContentBlocks[0].Text != "what is this?" {
		t.Fatalf("first block = %+v, want the leading text block", msg.Content.ContentBlocks[0])
	}
	img := msg.Content.ContentBlocks[1]
	if img.Type != schemas.ChatContentBlockTypeImage || img.ImageURLStruct == nil || img.ImageURLStruct.URL != "data:image/png;base64,abc" {
		t.Fatalf("second block = %+v, want an image_url block with the data URL", img)
	}
}

func TestToBifrostMessage_NonImageAttachmentBecomesFileBlock(t *testing.T) {
	msg := toBifrostMessage(Message{
		Role:        RoleUser,
		Attachments: []Attachment{{URL: "data:application/pdf;base64,abc", MediaType: "application/pdf", Filename: "doc.pdf"}},
	})
	if len(msg.Content.ContentBlocks) != 1 {
		t.Fatalf("got %d blocks, want 1 (no text, so no leading text block): %+v", len(msg.Content.ContentBlocks), msg.Content.ContentBlocks)
	}
	file := msg.Content.ContentBlocks[0]
	if file.Type != schemas.ChatContentBlockTypeFile || file.File == nil || *file.File.FileData != "data:application/pdf;base64,abc" || *file.File.Filename != "doc.pdf" {
		t.Fatalf("got %+v, want a file block carrying the data URL and filename", file)
	}
}

func TestToBifrostMessage_NoAttachmentsStillUsesPlainContentStr(t *testing.T) {
	msg := toBifrostMessage(Message{Role: RoleUser, Text: "hi"})
	if msg.Content.ContentStr == nil || *msg.Content.ContentStr != "hi" {
		t.Fatalf("expected a plain ContentStr for an attachment-free message, got %+v", msg.Content)
	}
	if msg.Content.ContentBlocks != nil {
		t.Fatalf("expected no ContentBlocks, got %+v", msg.Content.ContentBlocks)
	}
}

func TestToBifrostMessages_OmitsSystemMessageWhenEmpty(t *testing.T) {
	msgs := toBifrostMessages("", []Message{{Role: RoleUser, Text: "hi"}})
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1 (no system message)", len(msgs))
	}
}

func TestToBifrostMessages_MapsEveryRole(t *testing.T) {
	msgs := toBifrostMessages("", []Message{
		{Role: RoleUser, Text: "u"},
		{Role: RoleAssistant, Text: "a"},
		{Role: RoleSystem, Text: "s"},
	})
	want := []schemas.ChatMessageRole{schemas.ChatMessageRoleUser, schemas.ChatMessageRoleAssistant, schemas.ChatMessageRoleSystem}
	for i, w := range want {
		if msgs[i].Role != w {
			t.Fatalf("message %d role = %q, want %q", i, msgs[i].Role, w)
		}
	}
}

func TestToBifrostMessages_UnknownRoleDefaultsToUser(t *testing.T) {
	msgs := toBifrostMessages("", []Message{{Role: MessageRole("bogus"), Text: "x"}})
	if msgs[0].Role != schemas.ChatMessageRoleUser {
		t.Fatalf("role = %q, want user fallback", msgs[0].Role)
	}
}

func TestToError_UsesTheBifrostErrorMessageWhenPresent(t *testing.T) {
	be := &schemas.BifrostError{Error: &schemas.ErrorField{Message: "invalid_api_key"}}
	err := toError(be)
	if err == nil || err.Error() != "invalid_api_key" {
		t.Fatalf("got %v, want %q", err, "invalid_api_key")
	}
}

func TestToError_FallsBackToAGenericMessageWhenErrorFieldIsNil(t *testing.T) {
	err := toError(&schemas.BifrostError{})
	if err == nil || err.Error() == "" {
		t.Fatal("expected a non-empty fallback error")
	}
}

func TestToError_HandlesNilBifrostError(t *testing.T) {
	err := toError(nil)
	if err == nil {
		t.Fatal("expected a non-nil error even for a nil *BifrostError")
	}
}

// An assistant turn replaying its own tool calls must carry type:"function"
// on every call. Without it the field is omitted (it is a *string with
// omitempty) and the *second* step of every tool call fails: OpenAI/Azure
// reject the turn outright, and Bifrost's Anthropic conversion silently
// drops the tool_use block so the tool_result that follows is orphaned.
// Either way the model never sees what a tool returned.
func TestToBifrostMessage_ToolCallsCarryTheFunctionType(t *testing.T) {
	msg := toBifrostMessage(Message{
		Role: RoleAssistant,
		ToolCalls: []ToolCall{
			{ID: "call_1", Name: "createPieChart", Arguments: `{"title":"Q3"}`},
			{ID: "call_2", Name: "createTable", Arguments: `{}`},
		},
	})

	if msg.ChatAssistantMessage == nil {
		t.Fatalf("expected an assistant message carrying tool calls, got %+v", msg)
	}
	calls := msg.ChatAssistantMessage.ToolCalls
	if len(calls) != 2 {
		t.Fatalf("got %d tool calls, want 2", len(calls))
	}
	for i, c := range calls {
		if c.Type == nil || *c.Type != "function" {
			t.Fatalf("call %d Type = %v, want \"function\"", i, c.Type)
		}
		if c.ID == nil || *c.ID == "" {
			t.Fatalf("call %d lost its id", i)
		}
		if c.Index != uint16(i) {
			t.Fatalf("call %d Index = %d, want %d", i, c.Index, i)
		}
	}
	if *calls[0].Function.Name != "createPieChart" || calls[0].Function.Arguments != `{"title":"Q3"}` {
		t.Fatalf("first call = %+v, want name and raw arguments preserved", calls[0].Function)
	}
}
