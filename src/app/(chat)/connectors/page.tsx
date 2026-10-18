"use client";

import ComposioDashboard from "@/components/composio-dashboard";
import { useSession } from "@/lib/backend/session-context";

export default function Page() {
  const { data: session } = useSession();
  if (!session) return null;
  return <ComposioDashboard />;
}
