import type { ToolUIPart } from "ai";
import type { FC } from "react";

/**
 * How a tool run ended, in the one vocabulary every surface shares.
 *
 * Chat and the chat graph describe the same three outcomes with
 * completely different shapes -- `ToolUIPart.state` / `errorText` on one
 * side, a chat-graph node's runtime history on the other. Presenters take
 * this instead of either, which is what lets one component render into both
 * without knowing where it is.
 */
export type ToolRunStatus = "pending" | "success" | "error";

/**
 * An approval answer sitting where a tool's result goes.
 *
 * Between the user clicking Approve and the server's next response landing,
 * the SDK has written `{__tag:"manual-tool-confirm"}` into the tool part's
 * output -- that is how the answer is transported. It is not a result, and
 * a presenter handed it renders nonsense from missing fields ("+0 −0" for
 * an edit that in fact applied cleanly). The call genuinely is still in
 * flight at that moment, so the honest rendering is "pending".
 */
function isApprovalAnswer(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { __tag?: unknown }).__tag === "manual-tool-confirm"
  );
}

/** Chat adapter: derive status from a streamed tool part. */
export function statusFromToolPart(part: ToolUIPart): ToolRunStatus {
  if (part.errorText) return "error";
  if (part.state === "output-error") return "error";
  if (!part.state?.startsWith("output")) return "pending";
  if (isApprovalAnswer(part.output)) return "pending";
  return "success";
}

/**
 * The props a presenter should be given for a streamed tool part.
 *
 * One helper rather than three call sites each reaching into `part`, so the
 * approval-answer normalization above cannot be applied in the chat card
 * and forgotten in the work log's glance line.
 */
export function presenterPropsFromToolPart(part: ToolUIPart): PresenterProps {
  return {
    input: part.input,
    output: isApprovalAnswer(part.output) ? undefined : part.output,
    status: statusFromToolPart(part),
    errorText: part.errorText,
  };
}

/** Chat-graph adapter: derive status from a node's runtime history entry. */
export function statusFromNodeHistory(history: {
  status?: string;
  error?: unknown;
}): ToolRunStatus {
  if (history.error) return "error";
  if (history.status === "fail" || history.status === "error") return "error";
  if (history.status === "running" || history.status === undefined)
    return "pending";
  return "success";
}

export interface PresenterProps {
  /** The tool's arguments, as the model produced them. */
  input: any;
  /** The tool's result. Undefined while pending or on error. */
  output: any;
  status: ToolRunStatus;
  /** Present when status is "error". */
  errorText?: string;
}

/**
 * One tool's visual identity, in three sizes.
 *
 * A tool is not finished until it has one of these. The rule exists because
 * a 40-step agent run is only reviewable if each step answers "what changed"
 * at a glance -- raw JSON forces the reader to decode arguments, which
 * nobody does, which is how a wrong edit survives to compound into the next
 * turn.
 */
export interface ToolPresenter {
  /**
   * One line, ~60 chars, answering *what happened* -- never "a tool ran".
   * Rendered on the chat graph node face and as the collapsed chat header.
   * Must tolerate a pending/absent output.
   */
  glance: (props: PresenterProps) => string;
  /** Node-sized: fits a ~280px chat graph node body, no internal scroll. */
  Compact?: FC<PresenterProps>;
  /** Full detail: chat message card, and the chat graph's detail panel. */
  Expanded?: FC<PresenterProps>;
}

export type ToolPresenterRegistry = Record<string, ToolPresenter>;
