"use client";

import { apiJson } from "@/lib/backend/client";
import useSWR from "swr";
import { fetcher } from "@/lib/backend/client";

export const UPDATE_KEY = "/api/system/update";

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  publishedAt: string | null;
  checkFailed: boolean;
  noReleases: boolean;
}

export function useUpdateStatus(enabled = true) {
  return useSWR<UpdateStatus>(enabled ? UPDATE_KEY : null, fetcher, {
    revalidateOnFocus: false,
    errorRetryCount: 1,
  });
}

export async function refreshUpdateStatus() {
  return apiJson<UpdateStatus>(`${UPDATE_KEY}?refresh=1`);
}

export async function startServerUpdate(version?: string) {
  return apiJson<{ started: boolean; version: string; pid?: number }>(
    UPDATE_KEY,
    {
      method: "POST",
      body: JSON.stringify(version ? { version } : {}),
    },
  );
}
