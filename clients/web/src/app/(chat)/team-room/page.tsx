"use client";

import { TeamSpaceView } from "@/components/team/team-space-view";
import { useSession } from "@/lib/backend/session-context";
import { Suspense } from "react";

// useSearchParams() (?agent=) needs a Suspense boundary under output: "export".
export default function TeamRoomPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return (
    <Suspense fallback={null}>
      <TeamSpaceView />
    </Suspense>
  );
}
