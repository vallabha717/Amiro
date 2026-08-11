"use client";

import WorkflowListPage from "@/components/workflow/workflow-list-page";
import { useSession } from "@/lib/backend/session-context";

export default function Page() {
  const { data: session } = useSession();
  if (!session) return null;
  return <WorkflowListPage userRole={session.user.role} />;
}
