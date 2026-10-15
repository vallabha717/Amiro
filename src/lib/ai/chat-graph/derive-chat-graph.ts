import { Edge } from "@xyflow/react";
import { getToolName, isToolUIPart, TextUIPart, UIMessage } from "ai";
import { DefaultToolName } from "lib/ai/tools";
import {
  ChatGraphNode,
  ChatGraphNodeData,
  ChatGraphNodeKind,
  ChatGraphNodeStatus,
} from "app-types/chat-graph";

export const CHAT_GRAPH_HORIZONTAL_GAP = 520;
export const CHAT_GRAPH_VERTICAL_GAP = 220;
/** INPUT lane, execution lane, OUTPUT lane. */
export const CHAT_GRAPH_LANES_PER_TURN = 3;
/** Vertical gap between two stacked cards in the same turn. */
export const CHAT_GRAPH_CARD_SPACING = 60;
/** Horizontal gap between the right edge of one turn column and the next. */
export const CHAT_GRAPH_COLUMN_GAP = 160;

const CHART_TOOL_NAMES: string[] = [
  DefaultToolName.CreatePieChart,
  DefaultToolName.CreateBarChart,
  DefaultToolName.CreateLineChart,
  DefaultToolName.CreateTable,
];

const CODE_TOOL_NAMES: string[] = [
  "terminal-execution",
  "run_shell",
  "terminal",
  "python-execution",
  "python-executor",
  "execute-code",
  "code-runner",
  "run-code",
];

const HTTP_TOOL_NAMES: string[] = [
  "fetch-url",
  "http-request",
  "webSearch",
  "web-search",
  "exa-search",
  "browser_navigate",
  "playwright",
];

const LABEL_MAX_LENGTH = 60;

function truncateLabel(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > LABEL_MAX_LENGTH
    ? `${trimmed.slice(0, LABEL_MAX_LENGTH)}…`
    : trimmed;
}

function isToolPart(part: any): boolean {
  if (!part || typeof part !== "object") return false;
  if (isToolUIPart(part)) return true;
  const type = String(part.type || "");
  return (
    type.startsWith("tool-") ||
    type === "tool-invocation" ||
    type === "tool-call" ||
    type === "tool-result" ||
    "toolCallId" in part
  );
}

function extractToolName(part: any): string {
  try {
    const name = getToolName(part);
    if (name) return name;
  } catch {}
  if (part.toolName) return part.toolName;
  const type = String(part.type || "");
  if (type.startsWith("tool-")) return type.slice(5);
  return "tool";
}

function getToolStateStatus(part: any): {
  status: ChatGraphNodeStatus;
  isRunning: boolean;
} {
  const state = String(part.state || "");
  if (
    state === "output-error" ||
    state === "error" ||
    part.errorText ||
    part.isError
  ) {
    return { status: "fail", isRunning: false };
  }
  if (
    state === "output-available" ||
    state === "result" ||
    state === "complete" ||
    part.output !== undefined ||
    part.result !== undefined
  ) {
    return { status: "success", isRunning: false };
  }
  // A suspended call: the loop stopped here and will not move until the
  // browser sends a result. `propose_plan` is the case that matters, and the
  // difference from "running" is the whole point -- one says wait, the other
  // says answer. isRunning stays false so the edge into this node does not
  // animate; an animated edge into a stopped node is the same lie the
  // spinner was.
  if (state === "input-available" && isSuspendingTool(part)) {
    return { status: "waiting", isRunning: false };
  }
  return { status: "running", isRunning: true };
}

/**
 * Tools whose "input-available" means "waiting for a human", not "waiting for
 * the browser to run it".
 *
 * Client-executed tools (the JS/Python sandbox) also sit in input-available,
 * but those resolve on their own within a second or two and genuinely are
 * running. Listing the suspending tools explicitly keeps the two apart rather
 * than repainting every mid-flight client tool as blocked on the user.
 */
function isSuspendingTool(part: any): boolean {
  return extractToolName(part) === DefaultToolName.ProposePlan;
}

/**
 * Pre-measurement size estimates. These only position nodes for the first
 * frame - the canvas re-flows everything from real measured DOM sizes as soon
 * as React Flow has measured the cards, which is what actually guarantees no
 * overlap. Keep them in sync with the card widths in `chat-graph-node.tsx`.
 */
export function getEstimatedNodeHeight(data: ChatGraphNodeData): number {
  if (data.kind === "chart") return 460;
  if (data.kind === "code" || data.kind === "http" || data.kind === "tool")
    return 240;
  // A gate carries two buttons under its title, so it is taller than the
  // 180 default. Getting this wrong only costs one frame of overlap before
  // the canvas re-flows from measured sizes, but that frame lands exactly
  // when the run halts and the user looks at it.
  if (data.kind === "gate") return 220;
  return 180;
}

/** `w-96` for chart cards, `w-72` for everything else. */
export function getEstimatedNodeWidth(data: ChatGraphNodeData): number {
  return data.kind === "chart" ? 384 : 288;
}

/** Top edge that puts a lone card's middle on the spine (y = 0). */
function centredY(node: ChatGraphNode): number {
  return -getEstimatedNodeHeight(node.data) / 2;
}

function classifyToolKind(toolName: string): {
  kind: ChatGraphNodeKind;
  isMcp: boolean;
  serverName?: string;
} {
  const lowerName = toolName.toLowerCase();
  const isMcp =
    lowerName.startsWith("mcp") ||
    lowerName.includes("mcp_") ||
    lowerName.includes("playwright");

  let serverName: string | undefined;
  if (isMcp && toolName.includes("__")) {
    const parts = toolName.split("__");
    serverName = parts[0];
  } else if (lowerName.includes("playwright")) {
    serverName = "playwright";
  }

  // Checked before the generic families: a plan gate is the one node in the
  // graph the user has to act on, and letting it fall through to "tool"
  // would render the decision point identically to a file read.
  if (toolName === DefaultToolName.ProposePlan) {
    return { kind: "gate", isMcp: false, serverName: undefined };
  }
  if (toolName === DefaultToolName.Walkthrough) {
    return { kind: "summary", isMcp: false, serverName: undefined };
  }
  if (CHART_TOOL_NAMES.includes(toolName)) {
    return { kind: "chart", isMcp, serverName };
  }
  if (CODE_TOOL_NAMES.some((n) => lowerName.includes(n))) {
    return { kind: "code", isMcp, serverName };
  }
  if (HTTP_TOOL_NAMES.some((n) => lowerName.includes(n))) {
    return { kind: "http", isMcp, serverName };
  }
  return { kind: "tool", isMcp, serverName };
}

function makeNode(id: string, data: ChatGraphNodeData): ChatGraphNode {
  return {
    id,
    type: "chatGraphNode",
    position: { x: 0, y: 0 },
    draggable: true,
    connectable: false,
    data,
  };
}

const SPINE_STROKE = "var(--color-primary, #3b82f6)";
const STEP_STROKE = "var(--color-border, #94a3b8)";

/**
 * Left-to-right link along the INPUT -> execution -> OUTPUT spine.
 *
 * Bezier (React Flow's `default`) rather than orthogonal: these links fan out
 * from a centred INPUT to the top of its execution column and back down to the
 * OUTPUT, and the curve reads that branch far better than a stepped line. The
 * steps inside a column stay orthogonal, so the two are easy to tell apart.
 */
function spineEdge(source: ChatGraphNode, target: ChatGraphNode): Edge {
  return {
    id: `${source.id}->${target.id}`,
    source: source.id,
    target: target.id,
    sourceHandle: "right",
    targetHandle: "left",
    type: "default",
    style: { strokeWidth: 2, stroke: SPINE_STROKE },
  };
}

/** Top-to-bottom link between two steps inside a turn's execution column. */
function stepEdge(
  source: ChatGraphNode,
  target: ChatGraphNode,
  animated: boolean,
): Edge {
  return {
    id: `${source.id}->${target.id}`,
    source: source.id,
    target: target.id,
    sourceHandle: "bottom",
    targetHandle: "top",
    type: "smoothstep",
    animated,
    style: {
      strokeWidth: 2,
      stroke: animated ? SPINE_STROKE : STEP_STROKE,
    },
  };
}

type AssistantStep = { message: UIMessage; part: any; partIndex: number };

type ChatTurn = {
  prompt?: { message: UIMessage; text: string };
  steps: AssistantStep[];
};

function isRenderableStep(part: any): boolean {
  if (!part || typeof part !== "object") return false;
  if ((part.type as string) === "reasoning") return !!part.reasoning?.trim();
  if (isToolPart(part)) return true;
  if (part.type === "text")
    return typeof part.text === "string" && !!part.text.trim();
  return false;
}

/**
 * Splits the thread into prompt -> execution -> answer cycles. Assistant
 * messages attach to the prompt that preceded them; assistant output with no
 * preceding prompt still forms a turn so nothing is silently dropped.
 */
function groupIntoTurns(messages: UIMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      const text = message.parts
        .filter((part): part is TextUIPart => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (!text.trim()) continue;
      current = { prompt: { message, text }, steps: [] };
      turns.push(current);
      continue;
    }

    if (message.role !== "assistant") continue;

    if (!current) {
      current = { steps: [] };
      turns.push(current);
    }
    const turn = current;
    message.parts.forEach((part, partIndex) => {
      if (isRenderableStep(part)) turn.steps.push({ message, part, partIndex });
    });
  }

  return turns.filter((turn) => turn.prompt || turn.steps.length > 0);
}

/**
 * Builds the node for one assistant step.
 *
 * `asOutput` decides how plain model text is presented: the text that closes a
 * turn is the OUTPUT, while anything the model says on the way there is
 * intermediate commentary and renders as INFO.
 */
function buildStepNode(
  step: AssistantStep,
  options: { turnIndex: number; laneIndex: number; asOutput: boolean },
): { node: ChatGraphNode; isRunning: boolean } {
  const { message, part, partIndex } = step;
  const { turnIndex, laneIndex, asOutput } = options;

  if ((part.type as string) === "reasoning") {
    const reasoningText = part.reasoning as string;
    return {
      isRunning: false,
      node: makeNode(`${message.id}-reasoning-${partIndex}`, {
        kind: "llm",
        label: truncateLabel(reasoningText),
        status: "success",
        messageId: message.id,
        turnIndex,
        laneIndex,
        text: reasoningText,
      }),
    };
  }

  if (isToolPart(part)) {
    const toolName = extractToolName(part);
    const { kind, isMcp, serverName } = classifyToolKind(toolName);
    const { status, isRunning } = getToolStateStatus(part);
    const toolCallId = part.toolCallId || `part-${partIndex}`;
    return {
      isRunning,
      node: makeNode(`${message.id}-${toolCallId}`, {
        kind,
        label: toolName,
        status,
        messageId: message.id,
        turnIndex,
        laneIndex,
        toolCallId,
        toolName,
        isMcp,
        serverName,
        input: part.input || part.args,
        output: part.output || part.result,
        errorText: part.errorText || part.error,
      }),
    };
  }

  const text = part.text as string;
  return {
    isRunning: false,
    // Id stays stable whether this text ends up INFO or OUTPUT, so the node
    // keeps its identity (and its measured size) if the turn streams on past it.
    node: makeNode(`${message.id}-text-${partIndex}`, {
      kind: asOutput ? "response" : "llm",
      label: truncateLabel(text),
      status: "success",
      messageId: message.id,
      turnIndex,
      laneIndex,
      text,
    }),
  };
}

/**
 * Derives the chat graph as a single horizontal spine.
 *
 * Every turn reads left to right as INPUT -> OUTPUT. Between them, the model's
 * execution for that turn (tool calls plus any INFO commentary) stacks
 * vertically in its own lane, so the spine stays readable no matter how much
 * work a turn does. The next turn's INPUT continues from the previous OUTPUT.
 *
 *   INPUT ─→ step ─→ OUTPUT ─→ INPUT ─→ step ─→ OUTPUT
 *              │                          │
 *            step                       step
 *
 * Positions here are estimates for the first frame only - the canvas re-flows
 * every lane from measured DOM sizes (see `layoutChatGraph`).
 */
export function deriveChatGraph(messages: UIMessage[]): {
  nodes: ChatGraphNode[];
  edges: Edge[];
} {
  const nodes: ChatGraphNode[] = [];
  const edges: Edge[] = [];
  const turns = groupIntoTurns(messages);

  let previousTurnTail: ChatGraphNode | null = null;

  turns.forEach((turn, turnIndex) => {
    const inputLane = turnIndex * CHAT_GRAPH_LANES_PER_TURN;
    const execLane = inputLane + 1;
    const outputLane = inputLane + 2;

    // Text that closes the turn is the OUTPUT. If the turn currently ends on a
    // tool call it is still executing, so it has no OUTPUT node yet.
    const lastStep = turn.steps.at(-1);
    const outputStep =
      lastStep && lastStep.part.type === "text" ? lastStep : null;
    const execSteps = outputStep ? turn.steps.slice(0, -1) : turn.steps;

    let inputNode: ChatGraphNode | null = null;
    if (turn.prompt) {
      inputNode = makeNode(`${turn.prompt.message.id}-prompt`, {
        kind: "prompt",
        label: truncateLabel(turn.prompt.text),
        status: "success",
        messageId: turn.prompt.message.id,
        turnIndex,
        laneIndex: inputLane,
        text: turn.prompt.text,
      });
      inputNode.position = {
        x: inputLane * CHAT_GRAPH_HORIZONTAL_GAP,
        y: centredY(inputNode),
      };
      nodes.push(inputNode);
      if (previousTurnTail) edges.push(spineEdge(previousTurnTail, inputNode));
    }

    // Execution steps stack vertically in the lane in front of the input, and
    // the stack is centred on the spine so the INPUT and OUTPUT either side of
    // it line up with its middle.
    const execBuilt = execSteps.map((step) =>
      buildStepNode(step, {
        turnIndex,
        laneIndex: execLane,
        asOutput: false,
      }),
    );
    const execStackHeight =
      execBuilt.reduce(
        (total, { node }) => total + getEstimatedNodeHeight(node.data),
        0,
      ) +
      CHAT_GRAPH_CARD_SPACING * Math.max(0, execBuilt.length - 1);

    let execY = -execStackHeight / 2;
    let previousExec: ChatGraphNode | null = null;

    for (const { node, isRunning } of execBuilt) {
      node.position = { x: execLane * CHAT_GRAPH_HORIZONTAL_GAP, y: execY };
      execY += getEstimatedNodeHeight(node.data) + CHAT_GRAPH_CARD_SPACING;
      nodes.push(node);

      if (previousExec) edges.push(stepEdge(previousExec, node, isRunning));
      else if (inputNode) edges.push(spineEdge(inputNode, node));

      previousExec = node;
    }

    let outputNode: ChatGraphNode | null = null;
    if (outputStep) {
      outputNode = buildStepNode(outputStep, {
        turnIndex,
        laneIndex: outputLane,
        asOutput: true,
      }).node;
      outputNode.position = {
        x: outputLane * CHAT_GRAPH_HORIZONTAL_GAP,
        y: centredY(outputNode),
      };
      nodes.push(outputNode);

      // Rejoin the spine from the bottom of the execution column, or straight
      // from the input when the turn ran no steps at all.
      const source = previousExec ?? inputNode;
      if (source) edges.push(spineEdge(source, outputNode));
    }

    previousTurnTail = outputNode ?? previousExec ?? inputNode;
  });

  return { nodes, edges };
}
