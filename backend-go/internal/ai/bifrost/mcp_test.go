package bifrostai

import (
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
)

func TestToBifrostMCPConfig_StdioConvertsEnvMapToKeyValueStrings(t *testing.T) {
	bc, err := toBifrostMCPConfig(MCPClientConfig{
		ID: "id-1", Name: "myserver", ConnectionType: MCPConnectionSTDIO,
		Command: "npx", Args: []string{"-y", "some-server"},
		Env: map[string]string{"API_KEY": "secret"},
	})
	if err != nil {
		t.Fatalf("toBifrostMCPConfig: %v", err)
	}
	if bc.ConnectionType != schemas.MCPConnectionTypeSTDIO {
		t.Fatalf("connection type = %q", bc.ConnectionType)
	}
	if bc.StdioConfig == nil || bc.StdioConfig.Command != "npx" {
		t.Fatalf("stdio config = %+v", bc.StdioConfig)
	}
	if len(bc.StdioConfig.Envs) != 1 || bc.StdioConfig.Envs[0] != "API_KEY=secret" {
		t.Fatalf("envs = %v, want [\"API_KEY=secret\"]", bc.StdioConfig.Envs)
	}
}

func TestToBifrostMCPConfig_RemoteWithNoHeadersUsesNoneAuth(t *testing.T) {
	bc, err := toBifrostMCPConfig(MCPClientConfig{
		ID: "id-1", Name: "myserver", ConnectionType: MCPConnectionHTTP, URL: "https://example.invalid/mcp",
	})
	if err != nil {
		t.Fatalf("toBifrostMCPConfig: %v", err)
	}
	if bc.AuthType != schemas.MCPAuthTypeNone {
		t.Fatalf("auth type = %q, want none", bc.AuthType)
	}
	if bc.ConnectionString == nil || bc.ConnectionString.GetValue() != "https://example.invalid/mcp" {
		t.Fatalf("connection string = %v", bc.ConnectionString)
	}
}

func TestToBifrostMCPConfig_RemoteWithHeadersUsesHeadersAuth(t *testing.T) {
	bc, err := toBifrostMCPConfig(MCPClientConfig{
		ID: "id-1", Name: "myserver", ConnectionType: MCPConnectionHTTP, URL: "https://example.invalid/mcp",
		Headers: map[string]string{"Authorization": "Bearer tok"},
	})
	if err != nil {
		t.Fatalf("toBifrostMCPConfig: %v", err)
	}
	if bc.AuthType != schemas.MCPAuthTypeHeaders {
		t.Fatalf("auth type = %q, want headers", bc.AuthType)
	}
	v, ok := bc.Headers["Authorization"]
	if !ok || v.GetValue() != "Bearer tok" {
		t.Fatalf("headers = %+v", bc.Headers)
	}
}

func TestToBifrostMCPConfig_UnknownConnectionTypeErrors(t *testing.T) {
	_, err := toBifrostMCPConfig(MCPClientConfig{ID: "id-1", Name: "x", ConnectionType: "bogus"})
	if err == nil {
		t.Fatal("expected an error for an unknown connection type")
	}
}

func TestToMCPStatus_MapsEveryBifrostState(t *testing.T) {
	cases := map[schemas.MCPConnectionState]MCPClientStatus{
		schemas.MCPConnectionStateConnected:    MCPStatusConnected,
		schemas.MCPConnectionStateError:        MCPStatusError,
		schemas.MCPConnectionStateDisconnected: MCPStatusDisconnected,
		schemas.MCPConnectionStatePendingTools: MCPStatusDisconnected,
		schemas.MCPConnectionStateDisabled:     MCPStatusDisconnected,
	}
	for state, want := range cases {
		if got := toMCPStatus(state); got != want {
			t.Fatalf("toMCPStatus(%q) = %q, want %q", state, got, want)
		}
	}
}

func fakeToolFunction(name, desc string) *schemas.ChatToolFunction {
	return &schemas.ChatToolFunction{Name: name, Description: &desc}
}

// TestToMCPToolInfo_RecoversTrueOriginalNameFromToolMapKey locks in the
// real, empirically-verified ToolMap key format ("{clientName}-{originalToolName}",
// hyphens and all, unsanitized) found by running a real MCP server
// (@modelcontextprotocol/server-everything) through AddMCPClient during
// Phase 4's live verification -- an earlier version of this function
// instead tried to "recover" the name via ToolNameMapping (a different
// registry, for LLM-facing sanitized function names), which produced the
// wrong original name and broke CallMCPTool's matching lookup. Deliberately
// does NOT set ToolNameMapping on the fixture, so a regression back to
// that approach would fail this test immediately.
func TestToMCPToolInfo_RecoversTrueOriginalNameFromToolMapKey(t *testing.T) {
	cfg := &schemas.MCPClientConfig{ID: "id-1", Name: "everything"}
	state := schemas.MCPClientState{
		ExecutionConfig: cfg,
		ToolMap: map[string]schemas.ChatTool{
			"everything-get-sum": {Function: fakeToolFunction("everything-get-sum", "Returns the sum of two numbers")},
		},
	}
	tools := toMCPToolInfo(state)
	if len(tools) != 1 {
		t.Fatalf("got %d tools, want 1", len(tools))
	}
	if tools[0].Name != "get-sum" {
		t.Fatalf("name = %q, want the true original MCP tool name %q (hyphens preserved)", tools[0].Name, "get-sum")
	}
	if tools[0].Description != "Returns the sum of two numbers" {
		t.Fatalf("description = %q", tools[0].Description)
	}
}

func TestPrefixedToolName_ReturnsClientNamePlusOriginalToolNameUnchanged(t *testing.T) {
	cfg := &schemas.MCPClientConfig{ID: "id-1", Name: "everything"}
	state := schemas.MCPClientState{ExecutionConfig: cfg}
	got := prefixedToolName(state, "get-sum")
	if got != "everything-get-sum" {
		t.Fatalf("got %q, want %q", got, "everything-get-sum")
	}
}

func TestPrefixedToolName_RoundTripsWithToMCPToolInfo(t *testing.T) {
	cfg := &schemas.MCPClientConfig{ID: "id-1", Name: "calc"}
	state := schemas.MCPClientState{ExecutionConfig: cfg, ToolMap: map[string]schemas.ChatTool{
		"calc-add": {Function: fakeToolFunction("calc-add", "")},
	}}
	tools := toMCPToolInfo(state)
	got := prefixedToolName(state, tools[0].Name)
	if got != "calc-add" {
		t.Fatalf("got %q, want %q", got, "calc-add")
	}
}
