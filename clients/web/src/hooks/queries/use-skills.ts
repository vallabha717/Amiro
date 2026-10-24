"use client";

import useSWR, { type SWRConfiguration, useSWRConfig } from "swr";
import { handleErrorWithToast } from "ui/shared-toast";
import { fetcher } from "lib/utils";
import type { Skill, SkillsListResponse, SkillSummary } from "@/types/skill";

export interface UseSkillsOptions extends SWRConfiguration {
  open?: boolean;
  projectDirectory?: string;
}

export function useSkills(options?: UseSkillsOptions) {
  const { open = true, projectDirectory, ...swrOptions } = options ?? {};

  const key = projectDirectory
    ? `/api/skills?project=${encodeURIComponent(projectDirectory)}`
    : "/api/skills";

  return useSWR<SkillsListResponse>(open ? key : null, fetcher, {
    revalidateOnFocus: false,
    errorRetryCount: 0,
    onError: handleErrorWithToast,
    ...swrOptions,
  });
}

function toSummary(skill: Skill | SkillSummary): SkillSummary {
  const { ...summary } = skill as Skill;
  delete (summary as Partial<Skill>).body;
  delete (summary as Partial<Skill>).resources;
  return summary;
}

/**
 * Invalidates every cached `/api/skills*` list (any `?project=` variant)
 * after a create/update/delete/duplicate, so the Skills page *and* the
 * composer's `/` palette (which shares the same SWR cache key -- see
 * skill-palette.tsx and this file's `useSkills`) both pick up the change
 * without a reload. Mirrors useMutateAgents' shape, adapted for the
 * `{items, diagnostics, truncated}` envelope instead of a bare array.
 */
export function useMutateSkills() {
  const { mutate } = useSWRConfig();

  return (updated?: Skill | SkillSummary, deletedName?: string) => {
    mutate(
      (key) => typeof key === "string" && key.startsWith("/api/skills") && !key.includes("/api/skills/items"),
      (cached: SkillsListResponse | undefined) => {
        if (!cached) return cached;
        const currentItems = cached.items ?? [];
        if (deletedName) {
          return {
            ...cached,
            items: currentItems.filter((s) => s.name !== deletedName),
          };
        }
        if (!updated) return cached;
        const summary = toSummary(updated);
        const idx = currentItems.findIndex((s) => s.name === summary.name);
        const items =
          idx >= 0
            ? currentItems.map((s, i) => (i === idx ? summary : s))
            : [summary, ...currentItems];
        return { ...cached, items };
      },
      { revalidate: true },
    );
  };
}
