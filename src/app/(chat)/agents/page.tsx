"use client";

import { AgentsList } from "@/components/agent/agents-list";
import { useSession } from "@/lib/backend/session-context";

// AgentsList already re-fetches "/api/agent?filters=mine,shared" itself
// via useSWR (the initial*Agents props were only ever SWR fallbackData) --
// this page no longer needs its own agentRepository read, just the
// session's userId/userRole (see (chat)/layout.tsx's doc comment for why
// there's no server-side session read left to do that with).
export default function AgentsPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return (
    <AgentsList
      initialMyAgents={[]}
      initialSharedAgents={[]}
      userId={session.user.id}
      userRole={session.user.role}
    />
  );
}
