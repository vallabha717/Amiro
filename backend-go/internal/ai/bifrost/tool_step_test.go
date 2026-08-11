package bifrostai

import (
	"encoding/json"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func TestToBifrostMessage_ToolResultSetsToolCallIDAndContent(t *testing.T) {
	msg := toBifrostMessage(Message{Role: RoleTool, ToolCallID: "call_1", Text: "42"})
	if msg.Role != schemas.ChatMessageRoleTool {
		t.Fatalf("got role %q, want tool", msg.Role)
	}
	if msg.ChatToolMessage == nil || msg.ChatToolMessage.ToolCallID == nil || *msg.ChatToolMessage.ToolCallID != "call_1" {
		t.Fatalf("got ChatToolMessage=%+v, want ToolCallID=call_1", msg.ChatToolMessage)
	}
	if msg.Content == nil || *msg.Content.ContentStr != "42" {
		t.Fatalf("got content=%+v, want \"42\"", msg.Content)
	}
}

func TestToBifrostMessage_AssistantWithToolCallsOmitsContentWhenTextEmpty(t *testing.T) {
	msg := toBifrostMessage(Message{
		Role:      RoleAssistant,
		ToolCalls: []ToolCall{{ID: "call_1", Name: "createBarChart", Arguments: `{"title":"x"}`}},
	})
	if msg.Role != schemas.ChatMessageRoleAssistant {
		t.Fatalf("got role %q, want assistant", msg.Role)
	}
	if msg.Content != nil {
		t.Fatalf("got content=%+v, want nil (no text alongside the tool call)", msg.Content)
	}
	if msg.ChatAssistantMessage == nil || len(msg.ChatAssistantMessage.ToolCalls) != 1 {
		t.Fatalf("got ChatAssistantMessage=%+v, want one tool call", msg.ChatAssistantMessage)
	}
	tc := msg.ChatAssistantMessage.ToolCalls[0]
	if tc.ID == nil || *tc.ID != "call_1" {
		t.Fatalf("got tool call ID=%v, want call_1", tc.ID)
	}
	if tc.Function.Name == nil || *tc.Function.Name != "createBarChart" {
		t.Fatalf("got tool call name=%v, want createBarChart", tc.Function.Name)
	}
	if tc.Function.Arguments != `{"title":"x"}` {
		t.Fatalf("got arguments=%q", tc.Function.Arguments)
	}
}

func TestToBifrostMessage_AssistantWithToolCallsKeepsTextWhenPresent(t *testing.T) {
	msg := toBifrostMessage(Message{
		Role:      RoleAssistant,
		Text:      "Let me check that for you.",
		ToolCalls: []ToolCall{{ID: "call_1", Name: "http", Arguments: `{}`}},
	})
	if msg.Content == nil || *msg.Content.ContentStr != "Let me check that for you." {
		t.Fatalf("got content=%+v, want the leading text preserved", msg.Content)
	}
}

func TestToBifrostMessage_PlainAssistantTextUnaffectedByToolChanges(t *testing.T) {
	msg := toBifrostMessage(Message{Role: RoleAssistant, Text: "hi"})
	if msg.ChatAssistantMessage != nil {
		t.Fatalf("got ChatAssistantMessage=%+v, want nil for a plain text turn", msg.ChatAssistantMessage)
	}
	if msg.Content == nil || *msg.Content.ContentStr != "hi" {
		t.Fatalf("got content=%+v, want \"hi\"", msg.Content)
	}
}

func TestBuildChatTools_EmptySpecsReturnsNil(t *testing.T) {
	tools, err := buildChatTools(nil)
	if err != nil || tools != nil {
		t.Fatalf("got tools=%v err=%v, want nil, nil", tools, err)
	}
}

func TestBuildChatTools_ConvertsNameDescriptionAndSchema(t *testing.T) {
	specs := []ToolSpec{{
		Name:             "createTable",
		Description:      "Create a table",
		ParametersSchema: json.RawMessage(`{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}`),
	}}
	tools, err := buildChatTools(specs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("got %d tools, want 1", len(tools))
	}
	tool := tools[0]
	if tool.Type != schemas.ChatToolTypeFunction {
		t.Fatalf("got type %q, want function", tool.Type)
	}
	if tool.Function == nil || tool.Function.Name != "createTable" {
		t.Fatalf("got function=%+v, want name createTable", tool.Function)
	}
	if tool.Function.Description == nil || *tool.Function.Description != "Create a table" {
		t.Fatalf("got description=%v", tool.Function.Description)
	}
	if tool.Function.Parameters == nil || tool.Function.Parameters.Type != "object" {
		t.Fatalf("got parameters=%+v, want type object", tool.Function.Parameters)
	}
}

func TestBuildChatTools_InvalidSchemaReturnsError(t *testing.T) {
	specs := []ToolSpec{{Name: "bad", ParametersSchema: json.RawMessage(`not json`)}}
	if _, err := buildChatTools(specs); err == nil {
		t.Fatal("expected an error for invalid parameters schema JSON")
	}
}

func TestBuildChatTools_PreservesOrderAcrossMultipleSpecs(t *testing.T) {
	specs := []ToolSpec{
		{Name: "a", ParametersSchema: json.RawMessage(`{"type":"object"}`)},
		{Name: "b", ParametersSchema: json.RawMessage(`{"type":"object"}`)},
	}
	tools, err := buildChatTools(specs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tools[0].Function.Name != "a" || tools[1].Function.Name != "b" {
		t.Fatalf("got order %q, %q, want a, b", tools[0].Function.Name, tools[1].Function.Name)
	}
}
