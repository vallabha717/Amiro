"use client";

import { BackgroundJobsList } from "@/components/background-jobs/background-jobs-list";
import { useSession } from "@/lib/backend/session-context";

export default function RunsPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <BackgroundJobsList />;
}
