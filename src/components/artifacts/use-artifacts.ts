"use client";

import { type UIMessage, getToolName, isToolUIPart } from "ai";
import { DefaultToolName } from "lib/ai/tools";
import { useMemo } from "react";

/**
 * Artifacts are a *projection of the transcript*, never state of their own.
 *
 * The plan, the task list and the walkthrough are all read back out of the
 * message parts that already persist -- the same move message.tsx makes for
 * pending approvals. Three consequences, all of them the reason for it:
 *
 *   - A reload finds them again, because the parts were saved with the turn.
 *   - They cannot drift from what actually happened, because there is only
 *     one record and this reads it.
 *   - Nothing new persists. No table, no endpoint, no artifact store to keep
 *     in sync with the conversation it describes.
 *
 * The cost is that everything here is derived on every render, which is why
 * it is one pass over the messages behind a useMemo rather than four hooks
 * each walking the list.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ArtifactTab = "plan" | "tasks" | "walkthrough" | "files";

/** One anchored comment on a plan. Mirrors planComment in plan.go. */
export interface PlanComment {
  id: string;
  /** Nearest heading above the anchor, for the model's orientation. */
  section?: string;
  /** The exact text the user selected. This is the anchor. */
  quote: string;
  note: string;
  /**
   * Hash of the block the quote was found in when the comment was made.
   * Used to re-attach on a revision; see anchorState.
   */
  blockId: string;
}

/** What the browser writes where propose_plan's result goes. */
export interface PlanDecision {
  decision: "proceed" | "revise";
  grantedMode?: string;
  comments?: { section?: string; quote: string; note: string }[];
}

/**
 * Build the answer to a propose_plan call.
 *
 * A pure function rather than an object literal inside usePlanDecision's
 * callback, because this *is* the contract with the model -- plan.go's
 * `planDecision` is the other half of it, and proposePlanDescription promises
 * the model what each field means. A contract that can only be exercised by
 * rendering a hook is a contract with no test.
 */
export function buildPlanDecision(
  decision: "proceed" | "revise",
  comments: Pick<PlanComment, "section" | "quote" | "note">[],
  grantedMode?: string,
): PlanDecision {
  return {
    decision,
    grantedMode: decision === "proceed" ? grantedMode : undefined,
    // Comments ride along on a "proceed" too. Someone who annotated three
    // things and then decided the plan was good enough anyway still meant
    // those annotations, and dropping them would silently discard the most
    // considered feedback in the conversation.
    comments: comments.map(({ section, quote, note }) => ({
      section,
      quote,
      note,
    })),
  };
}

export interface PlanArtifact {
  toolCallId: string;
  messageId: string;
  title: string;
  /** The markdown body -- grows live as the model's tool-call arguments stream in. */
  markdown: string;
  /**
   * True while the model is still writing the call's arguments (raw JSON
   * deltas, not yet a complete parsed input). The document is real and
   * growing, but it is not a document you can act on yet: there is nothing
   * to comment against that won't move, and nothing to approve that isn't
   * finished. Distinct from `pending` -- see there for why the two cannot be
   * merged into one flag.
   */
  streaming: boolean;
  /**
   * True once the call is suspended awaiting an answer -- arguments
   * complete, no decision yet. This is the flag the Proceed button, the
   * halted graph node, and the comment gutter hang off.
   *
   * Kept separate from `streaming` on purpose. Both used to collapse into
   * one "not pending" bucket, which meant a plan still being typed rendered
   * with the *answered* header ("Returned for revision") -- the negation of
   * "awaiting decision" is not "decided", it is "awaiting decision OR still
   * being written", and those need different UI.
   */
  pending: boolean;
  /** The answer, once given. Undefined while streaming or pending. */
  decision?: PlanDecision;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
}

export interface TodoArtifact {
  items: TodoItem[];
  done: number;
  inProgress: number;
  pending: number;
  /** True while the turn that last wrote this list is still running. */
  live: boolean;
}

export interface WalkthroughChange {
  path: string;
  why: string;
}

export interface WalkthroughArtifact {
  toolCallId: string;
  /** The message this walkthrough belongs to -- see PlanArtifact.messageId. */
  messageId: string;
  /** True while the model is still writing the summary/changes arguments. */
  streaming: boolean;
  summary: string;
  changes: WalkthroughChange[];
  testing?: string;
  followUps: string[];
  notice?: string;
  /**
   * Files this turn demonstrably edited that the walkthrough never mentions.
   *
   * Computed here rather than server-side because the evidence -- the turn's
   * own edit_file/write_file/multi_edit parts -- is already in hand on this
   * side. Doing it in the tool would have meant a per-session ledger of
   * edited paths, maintained by the write tools, kept in sync by hand.
   *
   * Only meaningful once the tool has actually run -- while streaming, the
   * change list is a partial JSON parse that may be missing its last entry
   * mid-word, and flagging that entry as "unmentioned" would be flagging the
   * model's own typing.
   */
  unmentioned: string[];
}

export interface Artifacts {
  plan?: PlanArtifact;
  todos?: TodoArtifact;
  walkthrough?: WalkthroughArtifact;
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

const EDIT_TOOLS = new Set<string>([
  DefaultToolName.EditFile,
  DefaultToolName.WriteFile,
  DefaultToolName.MultiEdit,
  "edit",
  "write",
  "apply_patch",
  "replace",
]);

/** A tool part is unanswered exactly while its state has not passed input. */
function isSuspended(part: any): boolean {
  return part?.state === "input-available";
}

/**
 * The model is still emitting this call's raw JSON arguments.
 *
 * `input` already updates live during this state -- the AI SDK incrementally
 * parses the raw text as it arrives -- so there is real, growing content to
 * show. What there is not yet is a *complete* document: the last field may
 * be cut off mid-string, which is why streaming content is shown but never
 * treated as something to comment on or approve.
 */
function isStreaming(part: any): boolean {
  return part?.state === "input-streaming";
}

function asPlanDecision(output: unknown): PlanDecision | undefined {
  if (!output || typeof output !== "object") return undefined;
  const decision = (output as PlanDecision).decision;
  if (decision !== "proceed" && decision !== "revise") return undefined;
  return output as PlanDecision;
}

function extractPatchPath(patchText?: string): string | undefined {
  if (!patchText || typeof patchText !== "string") return undefined;
  const updateMatch = patchText.match(/\*\*\*\s+(?:Update|Add)\s+File:\s*([^\s\n]+)/i);
  if (updateMatch) return updateMatch[1];
  const diffMatch = patchText.match(/diff --git a\/([^\s\n]+)/);
  if (diffMatch) return diffMatch[1];
  const plusMatch = patchText.match(/\+\+\+\s+(?:b\/)?([^\s\n]+)/);
  if (plusMatch && plusMatch[1] !== "/dev/null") return plusMatch[1];
  return undefined;
}

/**
 * Paths a message's tool calls actually wrote to.
 *
 * Only successful calls count. A refused edit (a bad anchor) changed
 * nothing, and flagging the walkthrough for not mentioning a file that was
 * never written would train the reader to ignore the flag.
 */
function editedPaths(message: UIMessage): string[] {
  const paths: string[] = [];
  for (const part of message.parts ?? []) {
    if (!isToolUIPart(part)) continue;
    if (!EDIT_TOOLS.has(getToolName(part))) continue;
    if ((part as any).state !== "output-available") continue;
    const path =
      (part as any).output?.path ??
      (part as any).input?.file_path ??
      (part as any).input?.path ??
      extractPatchPath((part as any).input?.patch_text);
    if (typeof path === "string" && path) paths.push(path);
  }
  return paths;
}

/**
 * Compare two paths the way a reader would.
 *
 * The model writes `src/lib/utils.ts` in the walkthrough and the edit tool
 * reported `src/lib/utils.ts`, but it may equally have written just
 * `utils.ts` in prose. Matching on the trailing segment keeps the flag
 * pointed at genuinely absent files rather than at spelling.
 */
function mentions(mentioned: string[], path: string): boolean {
  const tail = path.split("/").pop() ?? path;
  return mentioned.some(
    (m) => m === path || m.endsWith(`/${tail}`) || m === tail,
  );
}

function deriveArtifacts(messages: UIMessage[], isRunning: boolean): Artifacts {
  let plan: PlanArtifact | undefined;
  let todos: TodoArtifact | undefined;
  let walkthrough: WalkthroughArtifact | undefined;
  let todosFromLastMessage = false;

  messages.forEach((message, messageIndex) => {
    const isLast = messageIndex === messages.length - 1;

    for (const part of message.parts ?? []) {
      if (!isToolUIPart(part)) continue;
      const name = getToolName(part);
      const input = (part as any).input ?? {};
      const output = (part as any).output;

      if (name === DefaultToolName.ProposePlan) {
        // The latest proposal wins outright. A revised plan supersedes the
        // one it revises -- keeping both would leave the user reading a
        // document the agent has already abandoned.
        plan = {
          toolCallId: (part as any).toolCallId,
          messageId: message.id,
          title: typeof input.title === "string" ? input.title : "",
          markdown: typeof input.plan === "string" ? input.plan : "",
          streaming: isStreaming(part),
          pending: isSuspended(part),
          decision: asPlanDecision(output),
        };
        continue;
      }

      if (
        name === DefaultToolName.TodoWrite ||
        name === DefaultToolName.TodoRead ||
        name === "todo"
      ) {
        // Prefer the server's counts, fall back to the input: the plan is
        // worth showing the instant the model writes it rather than a round
        // trip later. Same rule the todo presenter already follows.
        //
        // Guarded with Array.isArray rather than trusted outright: mid-stream,
        // a tool call's `input` is whatever the partial-JSON repair in the ai
        // package's parsePartialJson produced from a truncated argument
        // string, which is `undefined` on a parse it can't repair -- but not
        // reliably an array shape even when it is defined, since a value that
        // hasn't reached its opening `[` yet can still land here as `{}`.
        const rawItems = Array.isArray(output?.items)
          ? output.items
          : Array.isArray(input?.items)
            ? input.items
            : Array.isArray(output?.todos)
              ? output.todos
              : Array.isArray(input?.todos)
                ? input.todos
                : [];

        const items: TodoItem[] = rawItems.map((item: any) => ({
          content: typeof item?.content === "string" ? item.content : "",
          status:
            item?.status === "completed" || item?.status === "done"
              ? "done"
              : item?.status === "in_progress"
                ? "in_progress"
                : "pending",
        }));

        todos = {
          items,
          done:
            output?.done ?? items.filter((i) => i?.status === "done").length,
          inProgress:
            output?.in_progress ??
            items.filter((i) => i?.status === "in_progress").length,
          pending:
            output?.pending ??
            items.filter((i) => i?.status === "pending").length,
          live: false,
        };
        todosFromLastMessage = isLast;
        continue;
      }

      if (name === DefaultToolName.Walkthrough) {
        // Built from input the instant the call exists, output once it's
        // available -- the same rule the todo list already follows, and for
        // the same reason: the whole point is showing this while it grows,
        // not waiting for the round trip through Execute.
        const source = output ?? input;
        if (!source) continue;
        // Same Array.isArray guard as the todo list above, and for the same
        // reason: mid-stream this is partial-JSON-repaired input, not yet
        // guaranteed to have reached array shape.
        const changes: WalkthroughChange[] = Array.isArray(source.changes)
          ? source.changes
          : [];
        const mentioned = changes
          .map((c: WalkthroughChange) => c?.path)
          .filter(Boolean);
        walkthrough = {
          toolCallId: (part as any).toolCallId,
          messageId: message.id,
          streaming: isStreaming(part),
          summary: source.summary ?? "",
          changes,
          testing: source.testing || undefined,
          followUps: Array.isArray(source.follow_ups) ? source.follow_ups : [],
          notice: output?.notice || undefined,
          // The cross-check needs the tool's own validated, path-normalized
          // output -- comparing edited paths against a half-typed input
          // field would flag the model's own typing as a missing mention.
          unmentioned: output
            ? Array.from(new Set(editedPaths(message))).filter(
                (p) => !mentions(mentioned, p),
              )
            : [],
        };
      }
    }
  });

  if (todos) todos.live = isRunning && todosFromLastMessage;
  return { plan, todos, walkthrough };
}

export function useArtifacts(
  messages: UIMessage[],
  isRunning = false,
): Artifacts {
  return useMemo(
    () => deriveArtifacts(messages, isRunning),
    [messages, isRunning],
  );
}

/** Exported for the tests, which want the pure function without a renderer. */
export const __deriveArtifacts = deriveArtifacts;

/**
 * Which tab an artifact should open on, so the three call sites that open
 * the pane (chat card, graph node, auto-open) cannot disagree.
 */
export function tabForTool(toolName: string): ArtifactTab | undefined {
  if (toolName === DefaultToolName.ProposePlan) return "plan";
  if (toolName === DefaultToolName.Walkthrough) return "walkthrough";
  if (
    toolName === DefaultToolName.TodoWrite ||
    toolName === DefaultToolName.TodoRead ||
    toolName === "todo"
  )
    return "tasks";
  return undefined;
}
