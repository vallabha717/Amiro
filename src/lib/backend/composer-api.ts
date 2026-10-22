"use client";

import { apiJson } from "@/lib/backend/client";

/**
 * The embedded runtime's commands the composer's `/` menu offers. Each runs
 * in the runtime itself (jcode's own `/compact`, `/context`, …), never as a
 * model turn. The backend (`routes/composer.rs`) holds the same list.
 */
export const COMPOSER_COMMANDS = [
  "compact",
  "context",
  "info",
  "cache",
  "memory",
  "skills",
  "agents",
  "swarm",
  "mcp",
  "refresh-model-list",
] as const;

export type ComposerCommand = (typeof COMPOSER_COMMANDS)[number];

/** Commands matching what was typed after `/`, name-prefix matches first. */
export function matchCommands(query: string): ComposerCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...COMPOSER_COMMANDS];
  const starts = COMPOSER_COMMANDS.filter((c) => c.startsWith(q));
  const contains = COMPOSER_COMMANDS.filter((c) => !c.startsWith(q) && c.includes(q));
  return [...starts, ...contains];
}

export interface ComposerCommandResult {
  command: string;
  /** The runtime's own human-readable rendering. */
  message: string;
  data: unknown;
}

export async function runComposerCommand(input: {
  command: ComposerCommand;
  threadId?: string;
}): Promise<ComposerCommandResult> {
  return await apiJson<ComposerCommandResult>("/api/composer/command", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface ComposerFiles {
  /** The folder searched (the chat's working folder). */
  root: string;
  /** Paths relative to `root`, best match first. */
  files: string[];
  source: "runtime" | "walk";
}

export async function findComposerFiles(input: {
  q: string;
  threadId?: string;
  projectDirectory?: string;
  limit?: number;
}): Promise<ComposerFiles> {
  const params = new URLSearchParams({ q: input.q });
  if (input.threadId) params.set("threadId", input.threadId);
  if (input.projectDirectory) params.set("projectDirectory", input.projectDirectory);
  if (input.limit) params.set("limit", String(input.limit));
  return await apiJson<ComposerFiles>(`/api/composer/files?${params.toString()}`);
}
