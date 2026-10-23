"use client";

import { Suspense } from "react";
import { AgentOverview } from "@/components/agent/agent-overview";
import { useSession } from "@/lib/backend/session-context";

export default function AgentPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return (
    <Suspense
      fallback={
        <div className="p-8 text-sm text-muted-foreground" role="status">
          Loading your agent…
        </div>
      }
    >
      <AgentOverview />
    </Suspense>
  );
}
