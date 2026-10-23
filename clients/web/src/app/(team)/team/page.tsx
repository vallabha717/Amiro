"use client";

import { TeamView } from "@/components/team/team-view";
import { useSession } from "@/lib/backend/session-context";
import { Suspense } from "react";

// useSearchParams() (?agent=) needs a Suspense boundary under output: "export".
export default function Page() {
  const { data: session } = useSession();
  if (!session) return null;
  return (
    <Suspense fallback={null}>
      <TeamView />
    </Suspense>
  );
}
