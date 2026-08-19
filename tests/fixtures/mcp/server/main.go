package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

type JSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type JSONRPCResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result,omitempty"`
	Error   any    `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var req JSONRPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			continue
		}

		handleRequest(req)
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "mcp server scanner error: %v\n", err)
	}
}

func handleRequest(req JSONRPCRequest) {
	switch req.Method {
	case "initialize":
		sendResponse(req.ID, map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"serverInfo": map[string]any{
				"name":    "deterministic-mcp-fixture",
				"version": "1.0.0",
			},
		})
	case "notifications/initialized":
		// No-op for notification
	case "ping":
		sendResponse(req.ID, map[string]any{})
	case "tools/list":
		sendResponse(req.ID, map[string]any{
			"tools": []map[string]any{
				{
					"name":        "echo",
					"description": "Echoes back the message",
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"message": map[string]any{"type": "string"},
						},
						"required": []string{"message"},
					},
				},
				{
					"name":        "slow",
					"description": "Delays response for testing timeouts",
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"delay_ms": map[string]any{"type": "integer"},
						},
					},
				},
				{
					"name":        "fail",
					"description": "Fails with an error message",
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"error_message": map[string]any{"type": "string"},
						},
					},
				},
				{
					"name":        "crash",
					"description": "Crashes the MCP process immediately",
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"exit_code": map[string]any{"type": "integer"},
						},
					},
				},
				{
					"name":        "big",
					"description": "Returns a large payload",
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"size_kb": map[string]any{"type": "integer"},
						},
					},
				},
				{
					"name":        "needs_approval",
					"description": "A tool that requires user approval",
					"inputSchema": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"action": map[string]any{"type": "string"},
						},
						"required": []string{"action"},
					},
				},
			},
		})
	case "tools/call":
		handleToolCall(req)
	default:
		if req.ID != nil {
			sendResponse(req.ID, map[string]any{
				"error": map[string]any{
					"code":    -32601,
					"message": "Method not found",
				},
			})
		}
	}
}

func handleToolCall(req JSONRPCRequest) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	_ = json.Unmarshal(req.Params, &params)

	switch params.Name {
	case "echo":
		var in struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(params.Arguments, &in)
		sendResponse(req.ID, map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": "echo: " + in.Message},
			},
		})
	case "slow":
		var in struct {
			DelayMS int `json:"delay_ms"`
		}
		_ = json.Unmarshal(params.Arguments, &in)
		if in.DelayMS <= 0 {
			in.DelayMS = 1000
		}
		time.Sleep(time.Duration(in.DelayMS) * time.Millisecond)
		sendResponse(req.ID, map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": fmt.Sprintf("slept for %d ms", in.DelayMS)},
			},
		})
	case "fail":
		var in struct {
			ErrorMessage string `json:"error_message"`
		}
		_ = json.Unmarshal(params.Arguments, &in)
		if in.ErrorMessage == "" {
			in.ErrorMessage = "tool execution failed intentionally"
		}
		sendResponse(req.ID, map[string]any{
			"isError": true,
			"content": []map[string]any{
				{"type": "text", "text": in.ErrorMessage},
			},
		})
	case "crash":
		var in struct {
			ExitCode int `json:"exit_code"`
		}
		_ = json.Unmarshal(params.Arguments, &in)
		if in.ExitCode == 0 {
			in.ExitCode = 1
		}
		os.Exit(in.ExitCode)
	case "big":
		var in struct {
			SizeKB int `json:"size_kb"`
		}
		_ = json.Unmarshal(params.Arguments, &in)
		if in.SizeKB <= 0 {
			in.SizeKB = 10
		}
		data := strings.Repeat("A", in.SizeKB*1024)
		sendResponse(req.ID, map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": data},
			},
		})
	case "needs_approval":
		var in struct {
			Action string `json:"action"`
		}
		_ = json.Unmarshal(params.Arguments, &in)
		sendResponse(req.ID, map[string]any{
			"content": []map[string]any{
				{"type": "text", "text": "executed approved action: " + in.Action},
			},
		})
	default:
		sendResponse(req.ID, map[string]any{
			"isError": true,
			"content": []map[string]any{
				{"type": "text", "text": "unknown tool: " + params.Name},
			},
		})
	}
}

func sendResponse(id any, result any) {
	if id == nil {
		return
	}
	resp := JSONRPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
	b, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(os.Stdout, "%s\n", b)
}
