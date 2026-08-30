"use client";
import {
  BACKGROUND_JOBS_KEY,
  BackgroundJob,
  selectBackgroundJobs,
} from "@/lib/backend/background-jobs-api";
import useSWR, { SWRConfiguration } from "swr";

/**
 * The signed-in user's background agent runs
 * (docs/coding-agent-parity/05-background-agent-runs.md), polled rather
 * than pushed -- there is no live-update channel for a job's status, so the
 * panel re-checks on an interval the way a dashboard tile would.
 */
export function useBackgroundJobs(options?: SWRConfiguration) {
  return useSWR<BackgroundJob[]>(BACKGROUND_JOBS_KEY, selectBackgroundJobs, {
    revalidateOnFocus: false,
    refreshInterval: 5000,
    fallbackData: [],
    ...options,
  });
}
