"use client";

import EditSkill from "@/components/skill/edit-skill";
import { fetcher } from "lib/utils";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import useSWR from "swr";
import { Skeleton } from "ui/skeleton";
import type { Skill } from "@/types/skill";

// A ?name= query param rather than a dynamic /skill/[name] route: Amiro's
// dashboard is a static Next.js export (no server-side dynamic routing), so
// every per-item page reads its identifier from the query string instead. A
// skill's name is its identity (the directory name), so this reads
// GET /api/skills/items/{name} instead of an id.
function SkillPageContent() {
  const name = useSearchParams().get("name") ?? "new";
  const { data: skill, isLoading } = useSWR<Skill>(
    name !== "new" ? `/api/skills/items/${encodeURIComponent(name)}` : null,
    fetcher,
  );

  if (name === "new") {
    return <EditSkill />;
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-8 max-w-3xl mx-auto w-full">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!skill) {
    return null;
  }

  return <EditSkill key={name} initialSkill={skill} />;
}

export default function SkillPage() {
  return (
    <Suspense fallback={null}>
      <SkillPageContent />
    </Suspense>
  );
}
