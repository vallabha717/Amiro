"use client";

import { ChannelsPage } from "@/components/channels/channels-page";
import { useSession } from "@/lib/backend/session-context";

export default function ChannelsRoutePage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <ChannelsPage />;
}
