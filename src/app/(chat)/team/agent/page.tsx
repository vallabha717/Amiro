"use client";

import { AgentPage } from "@/components/team/agent-page";
import { MAIN_AGENT_ID } from "@/lib/backend/agents-api";
import { useSession } from "@/lib/backend/session-context";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function AgentPageContent() {
  const id = useSearchParams().get("id") || MAIN_AGENT_ID;
  return <AgentPage key={id} agentId={id} />;
}

// The agent id is a query parameter: static export cannot pre-render runtime ids.
export default function Page() {
  const { data: session } = useSession();
  if (!session) return null;
  return (
    <Suspense fallback={null}>
      <AgentPageContent />
    </Suspense>
  );
}
