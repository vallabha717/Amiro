"use client";

import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import type { TeamAgent } from "@/lib/backend/agents-api";

/** A team agent's plush avatar, tinted with its own colour. */
export function AgentAvatar({
  agent,
  size = 40,
  animated = false,
  className,
}: {
  agent: Pick<TeamAgent, "traits" | "accentHex" | "customImageUrl">;
  size?: number;
  animated?: boolean;
  className?: string;
}) {
  return (
    <AgentCharacterAvatar
      traits={agent.traits}
      customImageUrl={agent.customImageUrl}
      accentColor={agent.accentHex}
      size={size}
      animated={animated}
      className={className}
    />
  );
}
