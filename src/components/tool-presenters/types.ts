import type { ToolUIPart } from "ai";
import type { FC } from "react";

/**
 * How a tool run ended, in the one vocabulary every surface shares.
 *
 * Chat describes a tool run's three outcomes with one shape --
 * `ToolUIPart.state` / `errorText`. Presenters take this instead of that, so
 * a presenter that needs to render somewhere else later does not have to
 * learn a second shape to do it.
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
   * Rendered on the collapsed chat header of a tool call.
   * Must tolerate a pending/absent output.
   */
  glance: (props: PresenterProps) => string;
  /** Compact body: the approval card sizes itself to this. */
  Compact?: FC<PresenterProps>;
  /** Full detail: the chat message card. */
  Expanded?: FC<PresenterProps>;
}

export type ToolPresenterRegistry = Record<string, ToolPresenter>;
