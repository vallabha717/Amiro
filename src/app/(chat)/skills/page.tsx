"use client";

import { SkillsList } from "@/components/skill/skills-list";
import { useSession } from "@/lib/backend/session-context";

export default function SkillsPage() {
  const { data: session } = useSession();
  if (!session) return null;
  return <SkillsList />;
}
