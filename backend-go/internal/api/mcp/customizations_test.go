package mcp

import (
	"encoding/json"
	"testing"
	"time"

	"amiro/backend/internal/db/models"
)

func TestToServerCustomizationResponse_UsesCamelCaseWireShape(t *testing.T) {
	prompt := "be terse"
	c := &models.McpServerCustomization{
		ID: "c1", UserID: "u1", McpServerID: "s1", Prompt: &prompt,
		CreatedAt: time.Unix(0, 0).UTC(), UpdatedAt: time.Unix(0, 0).UTC(),
	}
	b, err := json.Marshal(toServerCustomizationResponse(c))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	for _, key := range []string{"id", "userId", "mcpServerId", "prompt", "createdAt", "updatedAt"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("missing camelCase key %q in %v", key, got)
		}
	}
	// Guards against the Go-field-name leak this DTO was added to fix
	// (found live: GORM model field names like "McpServerID" showing up
	// verbatim in an API response instead of "mcpServerId").
	for _, key := range []string{"ID", "UserID", "McpServerID", "CreatedAt", "UpdatedAt"} {
		if _, ok := got[key]; ok {
			t.Fatalf("found raw Go field name %q in response, want only camelCase keys: %v", key, got)
		}
	}
}

func TestToToolCustomizationResponse_UsesCamelCaseWireShape(t *testing.T) {
	c := models.McpToolCustomization{
		ID: "c1", UserID: "u1", ToolName: "add", McpServerID: "s1",
		CreatedAt: time.Unix(0, 0).UTC(), UpdatedAt: time.Unix(0, 0).UTC(),
	}
	b, err := json.Marshal(toToolCustomizationResponse(c))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	for _, key := range []string{"id", "userId", "toolName", "mcpServerId", "createdAt", "updatedAt"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("missing camelCase key %q in %v", key, got)
		}
	}
}
