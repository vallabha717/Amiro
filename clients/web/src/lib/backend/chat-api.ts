"use client";

// Replaces src/app/api/chat/actions.ts's client-callable exports (a
// "use server" file, Phase 7) with plain fetches against the Go sidecar.
// rememberMcpServerCustomizationsAction/rememberAgentAction are not
// ported: both are only ever called from chat/route.ts's own tool-calling
// loop (Phase 3 left that loop unported, see internal/api/chat's doc
// comment), never from a client component -- there's nothing to convert.
import { apiJson } from "./client";
import type { ChatModel, ChatThread } from "app-types/chat";

export async function deleteMessage(messageId: string) {
  await apiJson(`/api/thread/messages/${messageId}`, { method: "DELETE" });
}

export async function deleteMessagesAfter(messageId: string) {
  await apiJson(`/api/thread/messages/${messageId}/truncate`, {
    method: "POST",
  });
}

export async function deleteThread(threadId: string) {
  await apiJson(`/api/thread/${threadId}`, { method: "DELETE" });
}

export async function updateThread(
  id: string,
  thread: Partial<Omit<ChatThread, "id" | "createdAt" | "updatedAt" | "userId">>,
) {
  await apiJson(`/api/thread/${id}`, {
    method: "PUT",
    body: JSON.stringify({ title: thread.title }),
  });
}

export async function deleteAllThreads() {
  await apiJson("/api/thread", { method: "DELETE" });
}

export async function deleteUnarchivedThreads() {
  await apiJson("/api/thread?scope=unarchived", { method: "DELETE" });
}

export async function exportChat(options: {
  threadId: string;
  expiresAt?: Date;
}) {
  return apiJson("/api/chat/export", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function generateObject<T = unknown>(options: {
  model?: ChatModel;
  prompt: { system?: string; user?: string };
  schema: unknown;
}): Promise<T> {
  return apiJson<T>("/api/ai/generate-object", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function generateExampleToolSchema<T = unknown>(options: {
  model?: ChatModel;
  toolInfo: { name: string; description: string; inputSchema?: unknown };
  prompt?: string;
}): Promise<T> {
  return apiJson<T>("/api/ai/generate-example-tool-schema", {
    method: "POST",
    body: JSON.stringify(options),
  });
}
