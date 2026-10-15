"use client";

import { AgentMemoryView } from "@/components/agent/agent-memory-view";
import { useSession } from "@/lib/backend/session-context";

export default function AgentMemoryPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <AgentMemoryView />;
}
