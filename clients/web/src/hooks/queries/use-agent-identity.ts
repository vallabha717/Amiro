"use client";

import useSWR, { useSWRConfig } from "swr";
import { apiJson } from "@/lib/backend/client";
import { useAgentScope } from "@/lib/backend/agent-scope";
import type { CharacterTraits } from "@/lib/agent/character-catalog";

export interface AgentMemoryStats {
  total: number;
  allRecords?: number;
  active: number;
  superseded: number;
  projectCount: number;
  globalCount: number;
  uniqueTags: number;
  byCategory: Record<string, number>;
}

export interface AgentIdentity {
  name: string;
  handle: string;
  tagline: string;
  traits: CharacterTraits;
  accentHex: string;
  customImageUrl: string | null;
  sliders: Record<string, number>;
  personalitySummary: string;
  updatedAt: string;
  memoryStats?: AgentMemoryStats;
}

export const AGENT_IDENTITY_KEY = "/api/agent/identity";

export function useAgentIdentity() {
  const scope = useAgentScope();
  const key = scope
    ? `${AGENT_IDENTITY_KEY}?scope=${encodeURIComponent(scope)}`
    : AGENT_IDENTITY_KEY;
  return useSWR<AgentIdentity>(
    key,
    () => apiJson<AgentIdentity>(AGENT_IDENTITY_KEY),
    {
      revalidateOnFocus: false,
      dedupingInterval: 5000,
    },
  );
}

export function useInvalidateAgentIdentity() {
  const { mutate } = useSWRConfig();
  const scope = useAgentScope();
  const key = scope
    ? `${AGENT_IDENTITY_KEY}?scope=${encodeURIComponent(scope)}`
    : AGENT_IDENTITY_KEY;
  return () => {
    mutate(AGENT_IDENTITY_KEY);
    if (scope) mutate(key);
  };
}

export async function updateAgentIdentity(
  patch: Partial<{
    name: string;
    handle: string;
    tagline: string;
    traits: CharacterTraits;
    accentHex: string | null;
    customImageUrl: string | null;
    sliders: Record<string, number>;
  }>,
): Promise<AgentIdentity> {
  return apiJson<AgentIdentity>("/api/agent/identity", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function updateAgentPersonality(payload: {
  sliders: Record<string, number>;
  name?: string;
}): Promise<AgentIdentity> {
  return apiJson<AgentIdentity>("/api/agent/personality", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}
