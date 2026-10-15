import { Node } from "@xyflow/react";

/**
 * Node kinds for the live, auto-derived chat graph view.
 *
 * These nodes are derived read-only from chat messages and never saved; they
 * are unrelated to the retired user-authored workflow builder.
 */
export type ChatGraphNodeKind =
  | "prompt"
  | "llm"
  | "tool"
  | "chart"
  | "code"
  | "http"
  | "template"
  | "response"
  /**
   * A decision the run is stopped on: `propose_plan`. Its own kind rather
   * than a generic "tool" because it is the only node the user is expected
   * to *act* on, and one that looks like every other step is one they will
   * scroll past while wondering why nothing is happening.
   */
  | "gate"
  /** The end-of-turn `walkthrough`: what changed, in reading order. */
  | "summary";

/**
 * `waiting` is a tool call the loop suspended -- it is not running, it is
 * stopped, and what it is stopped on is a human.
 *
 * This had to be distinct from `running`. A suspended call sits in
 * `input-available` forever, which the old derivation read as "still going",
 * so the node showed a spinner. A spinner on a node that is in fact waiting
 * for *you* tells the user the exact opposite of what is true: it says "be
 * patient" when the honest message is "nothing will happen until you answer".
 */
export type ChatGraphNodeStatus = "running" | "waiting" | "success" | "fail";

export type ChatGraphNodeData = {
  kind: ChatGraphNodeKind;
  label: string;
  status: ChatGraphNodeStatus;
  messageId: string;
  /** Which chat turn (prompt -> execution -> answer cycle) this node belongs to. */
  turnIndex: number;
  /**
   * Layout column. A turn spans three lanes - INPUT, the vertical execution
   * stack, then OUTPUT - so the graph reads as one horizontal spine. The
   * canvas re-flows each lane from measured DOM sizes, so it needs this
   * grouping to survive the estimated layout produced by `deriveChatGraph`.
   */
  laneIndex: number;
  toolCallId?: string;
  toolName?: string;
  isMcp?: boolean;
  serverName?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  text?: string;
};

export type ChatGraphNode = Node<ChatGraphNodeData>;

/**
 * Threads created before this moment never show the Workflow View toggle -
 * this feature only applies going forward, there is no historical backfill.
 */
export const WORKFLOW_VIEW_LAUNCH_DATE = new Date("2026-08-09T00:00:00.000Z");
