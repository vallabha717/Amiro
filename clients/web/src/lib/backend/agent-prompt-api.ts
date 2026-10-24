"use client";

import { apiJson } from "./client";

export const AGENT_PROMPT_KEY = "/api/agent/prompt";

/** One home file the runtime loads as the agent's prompt, notes stripped. */
export interface AgentPromptFile {
  name: string;
  content: string;
}

/**
 * The agent's default prompt (`IDENTITY.md`, then `SOUL.md`) as the runtime
 * loads it. Follows the agent scope like every agent route, so during a new
 * Team agent's setup it is that agent's prompt (backend/src/agent.rs).
 */
export function fetchAgentPrompt() {
  return apiJson<{ files: AgentPromptFile[] }>(AGENT_PROMPT_KEY);
}
