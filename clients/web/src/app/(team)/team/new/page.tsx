"use client";

import { NewAgentWizard } from "@/components/team/new-agent-wizard";
import { useSession } from "@/lib/backend/session-context";

export default function Page() {
  const { data: session } = useSession();
  if (!session) return null;
  return <NewAgentWizard />;
}
