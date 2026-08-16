package bifrostai

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

func TestJSONSchemaResponseFormat_WrapsSchemaAsNonStrictJSONSchema(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"city":{"type":"string"}}}`)
	rf, err := jsonSchemaResponseFormat("answer", schema)
	if err != nil {
		t.Fatal(err)
	}
	m, ok := rf.(map[string]interface{})
	if !ok || m["type"] != "json_schema" {
		t.Fatalf("got %#v", rf)
	}
	js, ok := m["json_schema"].(map[string]interface{})
	if !ok {
		t.Fatalf("got %#v", m["json_schema"])
	}
	if js["name"] != "answer" {
		t.Fatalf("name = %v", js["name"])
	}
	if js["strict"] != false {
		t.Fatalf("expected strict:false so permissive user-authored schemas aren't rejected, got %v", js["strict"])
	}
	inner, ok := js["schema"].(map[string]interface{})
	if !ok || inner["type"] != "object" {
		t.Fatalf("schema = %#v", js["schema"])
	}
}

func TestJSONSchemaResponseFormat_EmptySchemaDefaultsToObject(t *testing.T) {
	rf, err := jsonSchemaResponseFormat("answer", nil)
	if err != nil {
		t.Fatal(err)
	}
	m := rf.(map[string]interface{})
	js := m["json_schema"].(map[string]interface{})
	inner := js["schema"].(map[string]interface{})
	if inner["type"] != "object" {
		t.Fatalf("expected a default object schema, got %#v", inner)
	}
}

func TestResponseText_ExtractsContentString(t *testing.T) {
	text := "hello"
	resp := &schemas.BifrostChatResponse{
		Choices: []schemas.BifrostResponseChoice{{
			ChatNonStreamResponseChoice: &schemas.ChatNonStreamResponseChoice{
				Message: &schemas.ChatMessage{Content: &schemas.ChatMessageContent{ContentStr: &text}},
			},
		}},
	}
	got, err := responseText(resp)
	if err != nil || got != "hello" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestResponseText_EmptyResponseErrors(t *testing.T) {
	if _, err := responseText(&schemas.BifrostChatResponse{}); err == nil {
		t.Fatal("expected an error for a response with no choices")
	}
	if _, err := responseText(nil); err == nil {
		t.Fatal("expected an error for a nil response")
	}
}

func TestResponseUsage_NilWhenAbsent(t *testing.T) {
	if responseUsage(nil) != nil {
		t.Fatal("expected nil usage for a nil response")
	}
	if responseUsage(&schemas.BifrostChatResponse{}) != nil {
		t.Fatal("expected nil usage when Usage is unset")
	}
}

func TestResponseUsage_MapsFields(t *testing.T) {
	resp := &schemas.BifrostChatResponse{Usage: &schemas.BifrostLLMUsage{PromptTokens: 1, CompletionTokens: 2, TotalTokens: 3}}
	u := responseUsage(resp)
	if u == nil || u.PromptTokens != 1 || u.CompletionTokens != 2 || u.TotalTokens != 3 {
		t.Fatalf("got %+v", u)
	}
}

// TestClient_GenerateAndGenerateObjectAndGenerateWithTool_AgainstRealOpenAI
// is the non-streaming counterpart to client_live_test.go's streaming
// proof: skips (not fails) without a real OPENAI_API_KEY.
func TestClient_GenerateAndGenerateObjectAndGenerateWithTool_AgainstRealOpenAI(t *testing.T) {
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" || len(apiKey) < 20 {
		t.Skip("OPENAI_API_KEY not set to a real key; skipping live Bifrost call")
	}

	repo := fakeRepo{{id: "openai", provider: "openai", name: "OpenAI", apiKey: apiKey}}
	client, err := NewClient(context.Background(), repo)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer client.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resolved := Resolve("openai", "gpt-4.1-mini")

	t.Run("Generate", func(t *testing.T) {
		res, err := client.Generate(ctx, resolved, "", []Message{{Role: RoleUser, Text: "Reply with exactly the word: pong"}})
		if err != nil {
			t.Fatalf("Generate: %v", err)
		}
		if res.Text == "" {
			t.Fatal("expected non-empty generated text")
		}
	})

	t.Run("GenerateObject", func(t *testing.T) {
		schema := json.RawMessage(`{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}`)
		raw, _, err := client.GenerateObject(ctx, resolved, "", []Message{{Role: RoleUser, Text: "The capital of France is Paris. Return it as JSON."}}, schema)
		if err != nil {
			t.Fatalf("GenerateObject: %v", err)
		}
		var decoded struct {
			City string `json:"city"`
		}
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("unmarshal %s: %v", raw, err)
		}
		if decoded.City == "" {
			t.Fatalf("expected a non-empty city in %s", raw)
		}
	})

	t.Run("GenerateWithTool", func(t *testing.T) {
		schema := json.RawMessage(`{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}`)
		args, err := client.GenerateWithTool(ctx, resolved, "Add 2 and 3", "add", "Adds two numbers", schema)
		if err != nil {
			t.Fatalf("GenerateWithTool: %v", err)
		}
		if len(args) == 0 {
			t.Fatal("expected non-empty tool call arguments")
		}
	})
}
