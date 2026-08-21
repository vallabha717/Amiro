"use client";

import useSWR, { type SWRConfiguration } from "swr";
import { handleErrorWithToast } from "ui/shared-toast";
import { fetcher } from "lib/utils";
import type { SkillsListResponse } from "@/types/skill";

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
