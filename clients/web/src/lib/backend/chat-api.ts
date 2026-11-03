"use client";

// Replaces src/app/api/chat/actions.ts's client-callable exports (a
// "use server" file, Phase 7) with plain fetches against the Go sidecar.
// rememberMcpServerCustomizationsAction/rememberAgentAction are not
// ported: both are only ever called from chat/route.ts's own tool-calling
// loop (Phase 3 left that loop unported, see internal/api/chat's doc
// comment), never from a client component -- there's nothing to convert.
import { apiJson } from "./client";
import type { ChatModel, ChatThread } from "app-types/chat";

/**
 * Hand a message to the thread's running turn. `queued`: the agent reads it
 * at its next gap (after the current tools, or where it would have stopped).
 * `started`: the turn had just ended, so the runtime began a new one with it.
 * Throws an `ApiError` with status 409 when no turn is taking messages.
 */
export async function interjectChat(
  threadId: string,
  body: { clientId: string; text: string },
) {
  return apiJson<{ state: "queued" | "started" }>(
    `/api/chat/${encodeURIComponent(threadId)}/interject`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Take back messages the agent has not read yet; returns the ids removed. */
export async function withdrawInterjections(
  threadId: string,
  clientIds: string[],
) {
  const result = await apiJson<{ withdrawn: string[] }>(
    `/api/chat/${encodeURIComponent(threadId)}/interject/withdraw`,
    { method: "POST", body: JSON.stringify({ clientIds }) },
  );
  return result.withdrawn ?? [];
}

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
