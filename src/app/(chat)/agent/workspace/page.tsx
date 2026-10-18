"use client";

import { WorkspaceBrowser } from "@/components/workspace-browser/workspace-browser";
import { useSession } from "@/lib/backend/session-context";

export default function AgentWorkspacePage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <WorkspaceBrowser />;
}
