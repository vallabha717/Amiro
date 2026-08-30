"use client";
import { GitHubStatus, GITHUB_STATUS_KEY } from "@/lib/backend/github-api";
import { fetcher } from "lib/utils";
import useSWR, { SWRConfiguration } from "swr";

/** Whether the signed-in user has a GitHub token connected -- a Settings page's row. */
export function useGitHubStatus(options?: SWRConfiguration) {
  return useSWR<GitHubStatus>(GITHUB_STATUS_KEY, fetcher, {
    revalidateOnFocus: false,
    fallbackData: { connected: false },
    ...options,
  });
}
