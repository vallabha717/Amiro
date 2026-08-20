"use client";

import type { Skill, SkillsListResponse } from "@/types/skill";
import { apiJson } from "./client";

/**
 * Lists all discovered Agent Skills across project and user scopes.
 * Optional project parameter filters to the specified project directory root.
 */
export async function listSkills(project?: string): Promise<SkillsListResponse> {
  const params = new URLSearchParams();
  if (project) {
    params.set("project", project);
  }
  const qs = params.toString();
  return apiJson<SkillsListResponse>(qs ? `/api/skills?${qs}` : "/api/skills");
}

/**
 * Retrieves a single Agent Skill by name.
 */
export async function getSkill(name: string, project?: string): Promise<Skill> {
  const params = new URLSearchParams();
  if (project) {
    params.set("project", project);
  }
  const qs = params.toString();
  const encodedName = encodeURIComponent(name);
  return apiJson<Skill>(
    qs ? `/api/skills/items/${encodedName}?${qs}` : `/api/skills/items/${encodedName}`,
  );
}
