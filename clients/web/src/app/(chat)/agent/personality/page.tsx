"use client";

import { AgentPersonalityStudio } from "@/components/agent/agent-personality-studio";
import { useSession } from "@/lib/backend/session-context";

export default function AgentPersonalityPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <AgentPersonalityStudio />;
}
