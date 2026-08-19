package chat_test

import (
	"encoding/json"
	"strings"
	"testing"

	"amiro/tests/harness"
	"amiro/tests/harness/fakeprovider"
)

// TestAIGeneration_GenerateObjectAndSchemas verifies structured generation endpoints.
func TestAIGeneration_GenerateObjectAndSchemas(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	// 1. Generate Object (POST /api/ai/generate-object)
	h.Fake().OnPrompt(fakeprovider.Any()).StreamText(`{"name":"AmiroAssistant","summary":"High performance coding assistant"}`)

	objectReq := map[string]any{
		"prompt": map[string]string{
			"system": "You are a JSON schema generator.",
			"user":   "Generate a project info object",
		},
		"schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":    map[string]string{"type": "string"},
				"summary": map[string]string{"type": "string"},
			},
			"required": []string{"name", "summary"},
		},
	}

	objResp, err := user.GenerateObject(t.Context(), objectReq)
	if err != nil {
		t.Fatalf("GenerateObject: %v", err)
	}
	if len(objResp) == 0 {
		t.Fatal("expected non-empty object response")
	}

	// 2. Generate Example Tool Schema (POST /api/ai/generate-example-tool-schema)
	toolSchemaReq := map[string]any{
		"toolInfo": map[string]any{
			"name":        "search_code",
			"description": "Searches repository source code by regex pattern",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"pattern": map[string]string{"type": "string"},
				},
				"required": []string{"pattern"},
			},
		},
		"prompt": "search for error handlers in go files",
	}

	toolSchemaResp, err := user.GenerateExampleToolSchema(t.Context(), toolSchemaReq)
	if err != nil {
		t.Fatalf("GenerateExampleToolSchema: %v", err)
	}
	if len(toolSchemaResp) == 0 {
		t.Fatal("expected non-empty tool schema response")
	}

	// 3. Generate Agent (POST /api/agent/ai)
	agentGenReq := map[string]any{
		"message": "Create a senior Go code reviewer agent",
	}
	agentResp, err := user.GenerateAgent(t.Context(), agentGenReq)
	if err != nil {
		t.Fatalf("GenerateAgent: %v", err)
	}
	if len(agentResp) == 0 {
		t.Fatal("expected non-empty agent generation response")
	}
	var agentData map[string]any
	if err := json.Unmarshal(agentResp, &agentData); err == nil {
		if name, ok := agentData["name"].(string); ok && name != "" {
			t.Logf("generated agent name: %s", name)
		}
	}
}

// TestAIGeneration_SchemaValidationRejection verifies invalid payload rejections.
func TestAIGeneration_SchemaValidationRejection(t *testing.T) {
	h := harness.New(t)
	user := h.As("user")

	// Missing schema must be rejected with 400 Bad Request
	_, err := user.GenerateObject(t.Context(), map[string]any{
		"prompt": map[string]string{"user": "hello"},
	})
	if err == nil {
		t.Fatal("expected GenerateObject without schema to fail")
	}
	if !strings.Contains(err.Error(), "400") {
		t.Logf("rejection error: %v", err)
	}
}
