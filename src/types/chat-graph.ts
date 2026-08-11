import { Node } from "@xyflow/react";

/**
 * Node kinds for the live, auto-derived chat workflow view.
 * Deliberately separate from `NodeKind` in `lib/ai/workflow/workflow.interface.ts`,
 * which models the user-authored workflow *builder* (DB-persisted, editable).
 * These nodes are derived read-only from chat messages and never saved.
 */
export type ChatGraphNodeKind =
  | "prompt"
  | "llm"
  | "tool"
  | "chart"
  | "code"
  | "http"
  | "template"
  | "response";

export type ChatGraphNodeStatus = "running" | "success" | "fail";

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
