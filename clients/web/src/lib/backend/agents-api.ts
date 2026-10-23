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

/** Channel first, then the most recently active chats. */
export function sortAgentThreads(threads: AgentThread[]): AgentThread[] {
  return [...threads].sort((a, b) => {
    if (a.channel !== b.channel) return a.channel ? -1 : 1;
    return (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "");
  });
}

/** A team agent's tool switches; every one starts off. */
export interface AgentTools {
  shell: boolean;
  files: boolean;
  browser: boolean;
}

/**
 * What the agent page says about the boundary: `none` (no tools at all),
 * `container` (tools run in the agent's own container) or `unavailable`
 * (tools are on but the sandbox is down, so calls fail instead of running
 * on this machine). See backend/src/routes/agent_computer.rs.
 */
export type AgentIsolation = "none" | "container" | "unavailable";

export interface AgentComputer {
  tools: AgentTools;
  /** The sandbox supervisor's address and secrets are set up. */
  configured: boolean;
  /** The supervisor answered and Docker is up. */
  available: boolean;
  state: "missing" | "running" | "stopped" | null;
  network: string | null;
  runtime: string | null;
  isolation: AgentIsolation;
}

/** The boundary as measured from inside the agent's container. */
export interface AgentComputerCheck {
  uid: number | null;
  gid: number | null;
  capEff: string;
  noCapabilities: boolean;
  noNewPrivs: boolean;
  dockerSocket: boolean;
  readOnlyRoot: boolean;
  homeWritable: boolean;
  homeMounts: string[];
  network: string;
  runtime: string;
}

export function agentComputerKey(id: string) {
  return `${agentKey(id)}/computer`;
}

export function useAgentComputer(id: string | null | undefined) {
  return useSWR<AgentComputer>(id ? agentComputerKey(id) : null, fetcher);
}

export function setAgentTools(id: string, tools: Partial<Pick<AgentTools, "shell" | "files">>) {
  return apiJson<AgentComputer>(agentComputerKey(id), {
    method: "PATCH",
    body: JSON.stringify({ tools }),
  });
}

export function checkAgentComputer(id: string) {
  return apiJson<AgentComputerCheck>(`${agentComputerKey(id)}/check`, {
    method: "POST",
  });
}
