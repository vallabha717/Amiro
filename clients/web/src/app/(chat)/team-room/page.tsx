"use client";

import { TeamRoom } from "@/components/team/team-room";
import { useSession } from "@/lib/backend/session-context";

export default function TeamRoomPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <TeamRoom />;
}
