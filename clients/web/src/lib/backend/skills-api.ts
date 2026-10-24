"use client";

import type {
  Skill,
  SkillsListResponse,
  SkillWriteRequest,
  SkillWriteResponse,
} from "@/types/skill";
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

/** Creates a new writable skill. Throws ApiError with `.info.errors` (SkillFieldError[]) on 400. */
export async function createSkill(
  req: SkillWriteRequest,
): Promise<SkillWriteResponse> {
  return apiJson<SkillWriteResponse>("/api/skills", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** Updates a writable skill. Throws ApiError (409) if the skill is read-only. */
export async function updateSkill(
  name: string,
  req: SkillWriteRequest,
): Promise<SkillWriteResponse> {
  const encodedName = encodeURIComponent(name);
  return apiJson<SkillWriteResponse>(`/api/skills/items/${encodedName}`, {
    method: "PUT",
    body: JSON.stringify(req),
  });
}

/**
 * Deletes a writable skill. Throws ApiError (422) naming unexpected files
 * unless `force` is set, per internal/skills/write.go's UnexpectedFiles check.
 */
export async function deleteSkill(
  name: string,
  force = false,
): Promise<void> {
  const encodedName = encodeURIComponent(name);
  const qs = force ? "?force=true" : "";
  await apiJson<void>(`/api/skills/items/${encodedName}${qs}`, {
    method: "DELETE",
  });
}

/** Duplicates any discovered skill (writable or read-only) into the user's writable skills. */
export async function duplicateSkill(
  name: string,
  project?: string,
): Promise<SkillWriteResponse> {
  const encodedName = encodeURIComponent(name);
  const qs = project ? `?project=${encodeURIComponent(project)}` : "";
  return apiJson<SkillWriteResponse>(
    `/api/skills/items/${encodedName}/duplicate${qs}`,
    { method: "POST" },
  );
}
