import { type UIMessage, getToolName, isToolUIPart } from "ai";
import type { ChatMetadata } from "app-types/chat";
import { editRowSummary } from "lib/ai/tools/step-kind";
import { extractInlineImages, type InlineImage } from "./inline-images";
import {
  type ToolCategory,
  connectorNameOf,
  toolCategoryOf,
} from "./tool-categories";
import { type RuntimeTodo, todosFromToolPart } from "./todos";

/**
 * Everything the right-hand session panel shows, read back out of the
 * transcript.
 *
 * Derived rather than tracked: a reopened thread must show the same panel as
 * the live one, and the transcript is the only thing both have.
 */
export interface SessionSummary {
  todos?: RuntimeTodo[];
  todosLive: boolean;
  outputs: SessionOutput[];
  connectorsUsed: { name: string; calls: number; failed: number }[];
  toolCounts: Record<ToolCategory, number>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  model?: string;
  /** The runtime's own context figures from the last finished turn. */
  context?: SessionContext;
  /** Agents this transcript's `swarm` calls spawned, newest last. */
  spawned: SpawnedAgent[];
}

export interface SessionContext {
  contextWindow?: number | null;
  contextTokens?: number | null;
  provider?: string | null;
  model?: string | null;
}

export interface SpawnedAgent {
  label: string;
  sessionId?: string;
  prompt?: string;
  /** The spawn call's own state, not the agent's -- see useSwarm for that. */
  state: "spawning" | "spawned" | "failed";
  toolCallId: string;
}

export type SessionOutput =
  | {
      kind: "file";
      path: string;
      name: string;
      verb: string;
      added?: number;
      removed?: number;
      messageId: string;
    }
  | { kind: "image"; image: InlineImage; messageId: string; toolName: string };

const EMPTY_COUNTS: Record<ToolCategory, number> = {
  terminal: 0,
  files: 0,
  web: 0,
  connectors: 0,
  agents: 0,
  planning: 0,
  other: 0,
};

export function summarizeSession(
  messages: UIMessage[],
  isRunning: boolean,
): SessionSummary {
  const toolCounts = { ...EMPTY_COUNTS };
  const files = new Map<string, Extract<SessionOutput, { kind: "file" }>>();
  const images: SessionOutput[] = [];
  const connectors = new Map<
    string,
    { name: string; calls: number; failed: number }
  >();
  let todos: RuntimeTodo[] | undefined;
  let todosMessageIndex = -1;
  let usage: SessionSummary["usage"];
  let model: string | undefined;
  let context: SessionContext | undefined;
  const spawned: SpawnedAgent[] = [];

  messages.forEach((message, mi) => {
    if (message.role === "assistant") {
      const meta = message.metadata as ChatMetadata | undefined;
      // The native backend reports the runtime's names (promptTokens /
      // completionTokens); the AI SDK's are inputTokens / outputTokens.
      const u = meta?.usage as Record<string, number | undefined> | undefined;
      if (u) {
        const input = u.inputTokens ?? u.promptTokens ?? 0;
        const output = u.outputTokens ?? u.completionTokens ?? 0;
        usage = {
          inputTokens: input,
          outputTokens: output,
          totalTokens: u.totalTokens ?? input + output,
        };
      }
      if (meta?.chatModel?.model) model = meta.chatModel.model;
      const ctx = (meta as { context?: SessionContext } | undefined)?.context;
      if (ctx) context = ctx;
    }

    for (const part of message.parts ?? []) {
      if (part.type === "file" && message.role === "assistant") {
        const p = part as {
          url: string;
          mediaType?: string;
          filename?: string;
        };
        if (p.mediaType?.startsWith("image/")) {
          images.push({
            kind: "image",
            image: { src: p.url, alt: p.filename },
            messageId: message.id,
            toolName: "assistant",
          });
        }
        continue;
      }
      // Images a model printed straight into its reply (a data URL or
      // markdown image) belong in Outputs as much as a tool's screenshot.
      if (part.type === "text" && message.role === "assistant") {
        for (const image of extractInlineImages(
          (part as { text: string }).text,
        )) {
          images.push({
            kind: "image",
            image,
            messageId: message.id,
            toolName: "assistant",
          });
        }
        continue;
      }
      if (!isToolUIPart(part)) continue;
      const name = getToolName(part);
      const input = (part as any).input;
      const output = (part as any).output;
      const failed =
        part.state === "output-error" || Boolean((part as any).errorText);
      const category = toolCategoryOf(name, input);
      toolCounts[category]++;

      if (category === "connectors") {
        const cname = connectorNameOf(name) ?? name;
        const entry = connectors.get(cname) ?? {
          name: cname,
          calls: 0,
          failed: 0,
        };
        entry.calls++;
        if (failed) entry.failed++;
        connectors.set(cname, entry);
      }

      if (name === "todo" || name === "todo_write" || name === "todo_read") {
        const list = todosFromToolPart(input, output);
        if (list) {
          todos = list;
          todosMessageIndex = mi;
        }
      }

      if (
        (name === "swarm" || name === "subagent" || name === "communicate") &&
        input?.action === "spawn"
      ) {
        const text =
          typeof output === "string" ? output : JSON.stringify(output ?? "");
        spawned.push({
          label: String(input?.label ?? "agent"),
          sessionId:
            /Spawned new agent:\s*(\S+)/.exec(text)?.[1] ?? output?.session_id,
          prompt: input?.prompt ?? input?.initial_message,
          state: failed
            ? "failed"
            : part.state === "output-available"
              ? "spawned"
              : "spawning",
          toolCallId: part.toolCallId,
        });
      }

      const status = !part.state.startsWith("output")
        ? "pending"
        : failed
          ? "error"
          : "success";
      const edit = editRowSummary(name, { input, output, status });
      if (
        edit &&
        status !== "error" &&
        /^(Edit|Creat|Rewr|Writ)/.test(edit.verb)
      ) {
        const prev = files.get(edit.path);
        files.set(edit.path, {
          kind: "file",
          path: edit.path,
          name: edit.name,
          verb: edit.verb,
          added: (prev?.added ?? 0) + (edit.added ?? 0),
          removed: (prev?.removed ?? 0) + (edit.removed ?? 0),
          messageId: message.id,
        });
      }

      if (part.state === "output-available") {
        for (const image of extractInlineImages(output)) {
          images.push({
            kind: "image",
            image,
            messageId: message.id,
            toolName: name,
          });
        }
      }
    }
  });

  return {
    todos,
    todosLive: isRunning && todosMessageIndex === messages.length - 1,
    outputs: [...images, ...files.values()],
    connectorsUsed: [...connectors.values()],
    toolCounts,
    usage,
    model,
    context,
    spawned,
  };
}
