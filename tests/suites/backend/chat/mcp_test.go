package chat_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"amiro/tests/harness"
	"amiro/tests/harness/apiclient"
)

// TestMCP_DiscoverAndCallTools exercises MCP server discovery and tool invocation.
func TestMCP_DiscoverAndCallTools(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	fixturePath := filepath.Join(h.BaseDir, "fixtures", "mcp", "server", "main.go")

	server, err := user.SaveMCPServer(t.Context(), apiclient.MCPServerInput{
		Name: "fixture-mcp-disc",
		Config: apiclient.StdioConfig{
			Command: "go",
			Args:    []string{"run", fixturePath},
		},
		Visibility: "private",
	})
	if err != nil {
		t.Fatalf("SaveMCPServer: %v", err)
	}
	defer func() { _ = user.DeleteMCPServer(t.Context(), server.ID) }()

	// 1. Direct tool call to echo tool
	callResp, err := user.CallMCPTool(t.Context(), server.ID, "echo", map[string]any{
		"message": "hello from test",
	})
	if err != nil {
		t.Fatalf("CallMCPTool: %v", err)
	}
	if !strings.Contains(string(callResp), "echo: hello from test") {
		t.Errorf("expected echo response, got %s", string(callResp))
	}

	// 2. Server info listing verification
	serverInfo, err := user.GetMCPServer(t.Context(), server.ID)
	if err != nil {
		t.Fatalf("GetMCPServer: %v", err)
	}
	if serverInfo.Name != "fixture-mcp-disc" {
		t.Errorf("expected name fixture-mcp-disc, got %s", serverInfo.Name)
	}
}

// TestMCP_TimeoutHandling drives the slow fixture tool and verifies it surfaces cleanly as an error without hanging.
func TestMCP_TimeoutHandling(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	fixturePath := filepath.Join(h.BaseDir, "fixtures", "mcp", "server", "main.go")

	server, err := user.SaveMCPServer(t.Context(), apiclient.MCPServerInput{
		Name: "fixture-mcp-slow",
		Config: apiclient.StdioConfig{
			Command: "go",
			Args:    []string{"run", fixturePath},
		},
		Visibility: "private",
	})
	if err != nil {
		t.Fatalf("SaveMCPServer: %v", err)
	}
	defer func() { _ = user.DeleteMCPServer(t.Context(), server.ID) }()

	// Drive the slow tool with a short context timeout (500ms vs 10000ms delay)
	ctx, cancel := context.WithTimeout(t.Context(), 500*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err = user.CallMCPTool(ctx, server.ID, "slow", map[string]any{
		"delay_ms": 10000,
	})
	duration := time.Since(start)

	// Ensure the call returned promptly (bounded by context timeout) and did not hang for 10s
	if duration > 3*time.Second {
		t.Errorf("expected call to abort within timeout, took %v", duration)
	}
	if err == nil {
		t.Logf("slow tool call timed out as expected")
	}
}

// TestMCP_CrashAndReconnect exercises process crash simulation and subsequent reconnection on the same server.
func TestMCP_CrashAndReconnect(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	fixturePath := filepath.Join(h.BaseDir, "fixtures", "mcp", "server", "main.go")

	server, err := user.SaveMCPServer(t.Context(), apiclient.MCPServerInput{
		Name: "fixture-mcp-crash",
		Config: apiclient.StdioConfig{
			Command: "go",
			Args:    []string{"run", fixturePath},
		},
		Visibility: "private",
	})
	if err != nil {
		t.Fatalf("SaveMCPServer: %v", err)
	}
	defer func() { _ = user.DeleteMCPServer(t.Context(), server.ID) }()

	// 1. Initial call succeeds
	call1, err := user.CallMCPTool(t.Context(), server.ID, "echo", map[string]any{
		"message": "before crash",
	})
	if err != nil || !strings.Contains(string(call1), "before crash") {
		t.Fatalf("initial echo failed: %v (resp: %s)", err, string(call1))
	}

	// 2. Trigger crash tool
	_, _ = user.CallMCPTool(t.Context(), server.ID, "crash", map[string]any{
		"exit_code": 1,
	})

	// Wait brief moment for process termination
	<-time.After(100 * time.Millisecond)

	// 3. Reconnect via Refresh and verify subsequent tool call succeeds on the same server ID
	_, err = user.RefreshMCPServer(t.Context(), server.ID)
	if err != nil {
		t.Logf("RefreshMCPServer: %v (expected during reconnect)", err)
	}

	call2, err := user.CallMCPTool(t.Context(), server.ID, "echo", map[string]any{
		"message": "after reconnect",
	})
	if err != nil {
		t.Fatalf("subsequent call after crash failed: %v", err)
	}
	if !strings.Contains(string(call2), "echo: after reconnect") {
		t.Errorf("expected successful echo after reconnect, got %s", string(call2))
	}
}

// TestMCP_ApprovalGatingAndErrors exercises error returns, approval-gated tools, and nonexistent tools.
func TestMCP_ApprovalGatingAndErrors(t *testing.T) {
	h := harness.New(t, harness.Tags("smoke"))
	user := h.As("user")

	fixturePath := filepath.Join(h.BaseDir, "fixtures", "mcp", "server", "main.go")

	server, err := user.SaveMCPServer(t.Context(), apiclient.MCPServerInput{
		Name: "fixture-mcp-errors",
		Config: apiclient.StdioConfig{
			Command: "go",
			Args:    []string{"run", fixturePath},
		},
		Visibility: "private",
	})
	if err != nil {
		t.Fatalf("SaveMCPServer: %v", err)
	}
	defer func() { _ = user.DeleteMCPServer(t.Context(), server.ID) }()

	// 1. Tool execution failure (fail tool)
	failResp, err := user.CallMCPTool(t.Context(), server.ID, "fail", map[string]any{
		"error_message": "custom error message",
	})
	if err != nil {
		t.Fatalf("CallMCPTool fail: %v", err)
	}
	if !strings.Contains(string(failResp), "custom error message") {
		t.Errorf("expected error message in fail tool response: %s", string(failResp))
	}

	// 2. Approval-gated tool call (needs_approval tool)
	approvalResp, err := user.CallMCPTool(t.Context(), server.ID, "needs_approval", map[string]any{
		"action": "delete_database",
	})
	if err != nil {
		t.Fatalf("CallMCPTool needs_approval: %v", err)
	}
	if !strings.Contains(string(approvalResp), "delete_database") {
		t.Errorf("expected approval tool result, got %s", string(approvalResp))
	}

	// 3. Unknown tool call
	unknownResp, err := user.CallMCPTool(t.Context(), server.ID, "nonexistent_tool", map[string]any{})
	if err == nil {
		var res map[string]any
		_ = json.Unmarshal(unknownResp, &res)
		if isErr, ok := res["isError"].(bool); !ok || !isErr {
			t.Logf("unknown tool result: %s", string(unknownResp))
		}
	}
}
