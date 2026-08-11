"use client";

import EditAgent from "@/components/agent/edit-agent";
import { useSession } from "@/lib/backend/session-context";
import { fetcher } from "lib/utils";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";
import { Skeleton } from "ui/skeleton";

// Was agent/[id] -- flattened to a ?id= query param, see (chat)/page.tsx's
// doc comment for why (static export needs build-time param lists a
// runtime agent id can't provide). Was a Server Component reading
// agentRepository.selectAgentById directly; now a client-side GET
// /api/agent/{id} (auth.RequireSession-gated on the sidecar, same
// ownership/visibility rule as before -- see internal/api/agent's doc
// comment).
function AgentPageContent() {
  const id = useSearchParams().get("id") ?? "new";
  const { data: session } = useSession();
  const { data: agent, isLoading } = useSWR(
    id !== "new" ? `/api/agent/${id}` : null,
    fetcher,
  );

  if (!session) return null;

  if (id === "new") {
    return <EditAgent userId={session.user.id} />;
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-8 max-w-3xl mx-auto w-full">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!agent) {
    return null;
  }

  const isOwner = agent.userId === session.user.id;
  const hasEditAccess = isOwner || agent.visibility === "public";

  return (
    <EditAgent
      key={id}
      initialAgent={agent}
      userId={session.user.id}
      isOwner={isOwner}
      hasEditAccess={hasEditAccess}
      isBookmarked={agent.isBookmarked || false}
    />
  );
}

export default function AgentPage() {
  return (
    <Suspense fallback={null}>
      <AgentPageContent />
    </Suspense>
  );
}
