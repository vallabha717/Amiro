"use client";

import { AgentChatPage } from "@/components/team/agent-chat-page";
import { useSession } from "@/lib/backend/session-context";
import { Suspense } from "react";

export default function Page() {
  const { data: session } = useSession();
  if (!session) return null;
  return (
    <Suspense fallback={null}>
      <AgentChatPage />
    </Suspense>
  );
}
