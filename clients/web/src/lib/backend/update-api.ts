"use client";

import useSWR from "swr";
import { apiJson, fetcher } from "@/lib/backend/client";

export const UPDATE_KEY = "/api/system/update";

/** How this server updates (backend/src/updates.rs). */
export type UpdateMethod = "installer" | "desktop" | "manual";

export type UpdateJobState =
  | "idle"
  | "installing"
  | "restarting"
  | "succeeded"
  | "failed";

export interface UpdateJob {
  state: UpdateJobState;
  from?: string;
  target?: string;
  trigger?: "manual" | "auto";
  startedAt?: string;
  finishedAt?: string | null;
  error?: string | null;
  log?: string | null;
}

export interface UpdateSettings {
  autoCheck: boolean;
  autoInstall: boolean;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  publishedAt: string | null;
  notes: string | null;
  checkedAt: string;
  checkFailed: boolean;
  noReleases: boolean;
  method: UpdateMethod;
  canSelfUpdate: boolean;
  settings: UpdateSettings;
  job: UpdateJob;
}

export function useUpdateStatus(enabled = true) {
  return useSWR<UpdateStatus>(enabled ? UPDATE_KEY : null, fetcher, {
    revalidateOnFocus: false,
    errorRetryCount: 1,
  });
}

/** Ask GitHub again now instead of using the 10-minute cache. */
export async function refreshUpdateStatus() {
  return apiJson<UpdateStatus>(`${UPDATE_KEY}?refresh=1`);
}

/** Start `amiro update` on an install.sh server (latest when no version). */
export async function startServerUpdate(version?: string) {
  return apiJson<{ started: boolean; version: string; job: UpdateJob }>(
    UPDATE_KEY,
    {
      method: "POST",
      body: JSON.stringify(version ? { version } : {}),
    },
  );
}

/** The update job and the version answering now; polled during a restart. */
export async function getUpdateJob() {
  return apiJson<{ current: string; job: UpdateJob }>(`${UPDATE_KEY}/job`);
}

export async function saveUpdateSettings(patch: Partial<UpdateSettings>) {
  return apiJson<UpdateSettings>(`${UPDATE_KEY}/settings`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** The running server's version, readable by any signed-in user. */
export async function getServerVersion() {
  const res = await apiJson<{ status: string; version?: string }>("/health");
  return res.version ?? null;
}
