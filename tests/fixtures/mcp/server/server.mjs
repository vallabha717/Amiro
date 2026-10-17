#!/usr/bin/env node
// Deterministic MCP server test fixture in Node.js (zero external dependencies).
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  handleRequest(req);
});

function sendResponse(id, result, error = null) {
  if (id === undefined || id === null) return;
  const resp = { jsonrpc: "2.0", id };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + "\n");
}

function handleRequest(req) {
  const { id, method, params } = req;
  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "deterministic-mcp-fixture",
          version: "1.0.0",
        },
      });
      break;
    case "notifications/initialized":
      break;
    case "ping":
      sendResponse(id, {});
      break;
    case "tools/list":
      sendResponse(id, {
        tools: [
          {
            name: "echo",
            description: "Echoes back the message",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
          {
            name: "slow",
            description: "Delays response for testing timeouts",
            inputSchema: {
              type: "object",
              properties: { delay_ms: { type: "integer" } },
            },
          },
          {
            name: "fail",
            description: "Fails with an error message",
            inputSchema: {
              type: "object",
              properties: { error_message: { type: "string" } },
            },
          },
          {
            name: "crash",
            description: "Crashes the MCP process immediately",
            inputSchema: {
              type: "object",
              properties: { exit_code: { type: "integer" } },
            },
          },
          {
            name: "big",
            description: "Returns a large payload",
            inputSchema: {
              type: "object",
              properties: { size_kb: { type: "integer" } },
            },
          },
          {
            name: "needs_approval",
            description: "A tool that requires user approval",
            inputSchema: {
              type: "object",
              properties: { action: { type: "string" } },
              required: ["action"],
            },
          },
        ],
      });
      break;
    case "tools/call":
      handleToolCall(id, params || {});
      break;
    default:
      if (id !== undefined && id !== null) {
        sendResponse(id, null, { code: -32601, message: "Method not found" });
      }
      break;
  }
}

function handleToolCall(id, params) {
  const name = params.name;
  const args = params.arguments || {};

  switch (name) {
    case "echo":
      sendResponse(id, {
        content: [{ type: "text", text: "echo: " + (args.message ?? "") }],
      });
      break;
    case "slow": {
      const delay = Math.max(args.delay_ms || 1000, 1);
      setTimeout(() => {
        sendResponse(id, {
          content: [{ type: "text", text: `slept for ${delay} ms` }],
        });
      }, delay);
      break;
    }
    case "fail":
      sendResponse(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: args.error_message || "tool execution failed intentionally",
          },
        ],
      });
      break;
    case "crash":
      process.exit(args.exit_code || 1);
      break;
    case "big": {
      const sizeKB = Math.max(args.size_kb || 10, 1);
      const data = "A".repeat(sizeKB * 1024);
      sendResponse(id, {
        content: [{ type: "text", text: data }],
      });
      break;
    }
    case "needs_approval":
      sendResponse(id, {
        content: [
          {
            type: "text",
            text: "executed approved action: " + (args.action ?? ""),
          },
        ],
      });
      break;
    default:
      sendResponse(id, {
        isError: true,
        content: [{ type: "text", text: "unknown tool: " + name }],
      });
      break;
  }
}
