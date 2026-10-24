"use client";

import { ConnectorsPage } from "@/components/connectors/connectors-page";
import { useSession } from "@/lib/backend/session-context";

export default function Page() {
  const { data: session } = useSession();
  if (!session) return null;
  return <ConnectorsPage />;
}
