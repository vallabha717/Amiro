import { describe, it, expect } from "vitest";
import { UIMessage } from "ai";
import { deriveChatGraph } from "./derive-chat-graph";
import { DefaultToolName } from "lib/ai/tools";

function userMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

function assistantMessage(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

describe("deriveChatGraph", () => {
  it("returns no nodes for an empty thread", () => {
    const { nodes, edges } = deriveChatGraph([]);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("creates a single prompt node for a user-only message", () => {
    const { nodes, edges } = deriveChatGraph([
      userMessage("m1", "Hello there"),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: "m1-prompt",
      data: { kind: "prompt", status: "success", label: "Hello there" },
    });
    expect(edges).toEqual([]);
  });

  it("maps tool-call state transitions to node status", () => {
    const running = deriveChatGraph([
      assistantMessage("m2", [
        {
          type: "tool-webSearch",
          toolCallId: "call1",
          state: "input-available",
          input: { query: "x" },
        } as any,
      ]),
    ]);
    expect(running.nodes[0].data.status).toBe("running");
    expect(running.nodes[0].data.kind).toBe("tool");

    const success = deriveChatGraph([
      assistantMessage("m2", [
        {
          type: "tool-webSearch",
          toolCallId: "call1",
          state: "output-available",
          input: { query: "x" },
          output: { results: [] },
        } as any,
      ]),
    ]);
    expect(success.nodes[0].data.status).toBe("success");
    expect(success.nodes[0].data.output).toEqual({ results: [] });

    const failed = deriveChatGraph([
      assistantMessage("m2", [
        {
          type: "tool-webSearch",
          toolCallId: "call1",
          state: "output-error",
          input: { query: "x" },
          errorText: "boom",
        } as any,
      ]),
    ]);
    expect(failed.nodes[0].data.status).toBe("fail");
    expect(failed.nodes[0].data.errorText).toBe("boom");
  });

  it("classifies chart/table tools into the chart kind", () => {
    const { nodes } = deriveChatGraph([
      assistantMessage("m3", [
        {
          type: `tool-${DefaultToolName.CreateBarChart}`,
          toolCallId: "call1",
          state: "output-available",
          input: { title: "t", data: [] },
          output: "Success",
        } as any,
      ]),
    ]);
    expect(nodes[0].data.kind).toBe("chart");
  });

  it("chains prompt -> tool -> response nodes across a turn, in order", () => {
    const { nodes, edges } = deriveChatGraph([
      userMessage("m1", "What's the weather?"),
      assistantMessage("m2", [
        {
          type: "tool-webSearch",
          toolCallId: "call1",
          state: "output-available",
          input: {},
          output: {},
        } as any,
        { type: "text", text: "It's sunny." },
      ]),
      userMessage("m3", "Thanks"),
    ]);

    expect(nodes.map((n) => n.data.kind)).toEqual([
      "prompt",
      "tool",
      "response",
      "prompt",
    ]);
    expect(edges).toHaveLength(3);
    expect(edges[0]).toMatchObject({ source: "m1-prompt", target: "m2-call1" });
    expect(edges[1]).toMatchObject({
      source: "m2-call1",
      target: "m2-text-1",
    });
    expect(edges[2]).toMatchObject({
      source: "m2-text-1",
      target: "m3-prompt",
    });
  });

  it("keeps INPUT and OUTPUT on one horizontal spine across turns", () => {
    const { nodes, edges } = deriveChatGraph([
      userMessage("m1", "hi"),
      assistantMessage("m2", [{ type: "text", text: "hello" }]),
      userMessage("m3", "next query"),
      assistantMessage("m4", [{ type: "text", text: "next response" }]),
    ]);

    // Every spine card sits on the same row, advancing left to right.
    expect(new Set(nodes.map((n) => n.position.y)).size).toBe(1);
    expect(nodes[1].position.x).toBeGreaterThan(nodes[0].position.x); // OUTPUT 1
    expect(nodes[2].position.x).toBeGreaterThan(nodes[1].position.x); // INPUT 2
    expect(nodes[3].position.x).toBeGreaterThan(nodes[2].position.x); // OUTPUT 2

    // Turns are chained OUTPUT -> next INPUT, right to left.
    expect(edges[1]).toMatchObject({
      source: nodes[1].id,
      target: nodes[2].id,
      sourceHandle: "right",
      targetHandle: "left",
    });
  });

  it("runs execution steps as a vertical column between INPUT and OUTPUT", () => {
    const { nodes, edges } = deriveChatGraph([
      userMessage("m1", "do two things"),
      assistantMessage("m2", [
        {
          type: "tool-webSearch",
          toolCallId: "call1",
          state: "output-available",
          input: {},
          output: {},
        } as any,
        {
          type: "tool-fetch-url",
          toolCallId: "call2",
          state: "output-available",
          input: {},
          output: {},
        } as any,
        { type: "text", text: "done" },
      ]),
    ]);

    const [input, stepOne, stepTwo, output] = nodes;
    expect(nodes.map((n) => n.data.kind)).toEqual([
      "prompt",
      "tool",
      "http",
      "response",
    ]);

    // INPUT and OUTPUT stay level with each other, execution sits between them.
    expect(input.position.y).toBe(output.position.y);
    expect(output.position.x).toBeGreaterThan(input.position.x);

    // The execution column shares one lane and stacks downwards.
    expect(stepOne.position.x).toBe(stepTwo.position.x);
    expect(stepOne.position.x).toBeGreaterThan(input.position.x);
    expect(stepTwo.position.x).toBeLessThan(output.position.x);
    expect(stepTwo.position.y).toBeGreaterThan(stepOne.position.y);

    // The column is centred on the spine, so it opens above the INPUT and
    // closes below it rather than hanging off one end.
    expect(stepOne.position.y).toBeLessThan(input.position.y);
    expect(stepTwo.position.y).toBeGreaterThan(input.position.y);

    // Entering and leaving the column curves; within it, orthogonal steps.
    expect(edges[0]).toMatchObject({
      type: "default",
      sourceHandle: "right",
      targetHandle: "left",
    });
    expect(edges[1]).toMatchObject({
      type: "smoothstep",
      sourceHandle: "bottom",
      targetHandle: "top",
    });
    expect(edges[2]).toMatchObject({
      source: stepTwo.id,
      target: output.id,
      type: "default",
      sourceHandle: "right",
      targetHandle: "left",
    });
  });

  it("shows model text before the final answer as INFO, not OUTPUT", () => {
    const { nodes } = deriveChatGraph([
      userMessage("m1", "check something"),
      assistantMessage("m2", [
        { type: "text", text: "Let me look that up." },
        {
          type: "tool-webSearch",
          toolCallId: "call1",
          state: "output-available",
          input: {},
          output: {},
        } as any,
        { type: "text", text: "It is sunny." },
      ]),
    ]);

    expect(nodes.map((n) => n.data.kind)).toEqual([
      "prompt",
      "llm",
      "tool",
      "response",
    ]);
    // The interim remark runs in the execution lane; only the closing text
    // graduates to the OUTPUT lane.
    expect(nodes[1].data.laneIndex).toBe(nodes[2].data.laneIndex);
    expect(nodes[3].data.laneIndex).toBeGreaterThan(nodes[2].data.laneIndex);
  });

  it("leaves a turn without an OUTPUT while it is still running a tool", () => {
    const { nodes } = deriveChatGraph([
      userMessage("m1", "search"),
      assistantMessage("m2", [
        { type: "text", text: "Searching now." },
        {
          type: "tool-webSearch",
          toolCallId: "call1",
          state: "input-available",
          input: {},
        } as any,
      ]),
    ]);

    expect(nodes.map((n) => n.data.kind)).toEqual(["prompt", "llm", "tool"]);
    expect(nodes.some((n) => n.data.kind === "response")).toBe(false);
  });

  it("classifies code, http, and mcp tools appropriately", () => {
    const { nodes } = deriveChatGraph([
      assistantMessage("m2", [
        {
          type: "tool-python-execution",
          toolCallId: "call1",
          state: "output-available",
          input: { code: "print('hi')" },
          output: "hi\n",
        } as any,
        {
          type: "tool-fetch-url",
          toolCallId: "call2",
          state: "output-available",
          input: { url: "https://example.com" },
          output: "ok",
        } as any,
        {
          type: "tool-mcp_github__get_issue",
          toolCallId: "call3",
          state: "output-available",
          input: { id: 1 },
          output: "issue",
        } as any,
      ]),
    ]);

    expect(nodes[0].data.kind).toBe("code");
    expect(nodes[1].data.kind).toBe("http");
    expect(nodes[2].data.kind).toBe("tool");
    expect(nodes[2].data.isMcp).toBe(true);
  });

  it("skips empty/whitespace-only text parts and user messages", () => {
    const { nodes } = deriveChatGraph([
      userMessage("m1", "   "),
      assistantMessage("m2", [{ type: "text", text: "" }]),
    ]);
    expect(nodes).toEqual([]);
  });
});
