"use client";

import { AgentOverview } from "@/components/agent/agent-overview";
import { useSession } from "@/lib/backend/session-context";

export default function AgentPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <AgentOverview />;
}
