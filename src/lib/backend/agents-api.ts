"use client";

import type { CharacterTraits } from "@/lib/agent/character-catalog";
import useSWR from "swr";
import { apiJson, fetcher } from "./client";

/** The agent everyone already has; see backend/src/routes/agents.rs. */
export const MAIN_AGENT_ID = "main";

/** One team agent, as GET /api/agents reports it. */
export interface TeamAgent {
  id: string;
  name: string;
  role: string;
  instructions: string;
  traits: CharacterTraits;
  accentHex: string;
  customImageUrl?: string | null;
  isMain: boolean;
  /** The caller's permanent channel thread with this agent. */
  channelThreadId: string;
  workspaceDir: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentThread {
  id: string;
  title: string;
  channel: boolean;
  createdAt?: string | null;
  lastMessageAt?: string | null;
}

export interface AgentFile {
  path: string;
  kind: "file" | "dir";
  size?: number;
}

export interface AgentInput {
  name: string;
  role?: string;
  instructions?: string;
  traits?: CharacterTraits;
}

export const AGENTS_KEY = "/api/agents";

export function agentKey(id: string) {
  return `/api/agents/${encodeURIComponent(id)}`;
}

export function useAgents() {
  return useSWR<{ agents: TeamAgent[] }>(AGENTS_KEY, fetcher, {
    revalidateOnFocus: true,
  });
}

export function useAgent(id: string | null | undefined) {
  return useSWR<TeamAgent>(id ? agentKey(id) : null, fetcher);
}

export function useAgentThreads(id: string | null | undefined) {
  return useSWR<{ threads: AgentThread[] }>(
    id ? `${agentKey(id)}/threads` : null,
    fetcher,
    { revalidateOnFocus: true },
  );
}

export function useAgentFiles(id: string | null | undefined) {
  return useSWR<{ files: AgentFile[] }>(
    id ? `${agentKey(id)}/files` : null,
    fetcher,
  );
}

export function createAgent(input: AgentInput) {
  return apiJson<TeamAgent>(AGENTS_KEY, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAgent(id: string, input: Partial<AgentInput>) {
  return apiJson<TeamAgent>(agentKey(id), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteAgent(id: string) {
  return apiJson<void>(agentKey(id), { method: "DELETE" });
}

/** The Team view URL for an agent's channel. */
export function teamPath(agentId: string) {
  return agentId === MAIN_AGENT_ID
    ? "/team"
    : `/team?agent=${encodeURIComponent(agentId)}`;
}

/** The agent page URL (profile, chats, files). */
export function agentPagePath(agentId: string) {
  return `/team/agent?id=${encodeURIComponent(agentId)}`;
}

/** Channel first, then the most recently active chats. */
export function sortAgentThreads(threads: AgentThread[]): AgentThread[] {
  return [...threads].sort((a, b) => {
    if (a.channel !== b.channel) return a.channel ? -1 : 1;
    return (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "");
  });
}
