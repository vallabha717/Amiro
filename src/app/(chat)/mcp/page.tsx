"use client";

import MCPDashboard from "@/components/mcp-dashboard";
import { useSession } from "@/lib/backend/session-context";

// IS_VERCEL_ENV/NOT_ALLOW_ADD_MCP_SERVERS dropped: both are Vercel-hosting-
// specific hints (sync delay, admin-disabled adding) that don't apply to
// the desktop sidecar / a self-hosted web deploy either.
export default function Page() {
  const { data: session } = useSession();
  if (!session) return null;
  return <MCPDashboard user={session.user} />;
}
