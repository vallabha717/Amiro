"use client";

import { AgentWorkspaceView } from "@/components/agent/agent-workspace-view";
import { useSession } from "@/lib/backend/session-context";

export default function AgentWorkspacePage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <AgentWorkspaceView />;
}
