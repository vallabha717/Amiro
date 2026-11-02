"use client";

import useSWR from "swr";
import { apiJson, fetcher } from "@/lib/backend/client";
import type { Build } from "@/lib/updates/version";

export const UPDATE_KEY = "/api/system/update";

/** How this server updates (backend/src/updates.rs). */
export type UpdateMethod = "installer" | "desktop" | "source" | "manual";

export type UpdateJobState =
  | "idle"
  | "installing"
  | "restarting"
  | "succeeded"
  | "failed";

export interface UpdateJob {
  state: UpdateJobState;
  /** "source" when a source checkout follows its branch (commit targets). */
  kind?: "source";
  branch?: string;
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

export interface SourceCommit {
  sha: string;
  subject: string;
  date: string;
}

/** A source checkout against its branch on origin (method "source"). */
export interface SourceStatus {
  branch?: string;
  running: string | null;
  latest?: string;
  behind: number;
  commits: SourceCommit[];
  dirty: boolean;
  checkFailed: boolean;
  error: string | null;
  checkedAt: string;
}

export interface UpdateStatus {
  repo?: string;
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
  source?: SourceStatus;
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

/**
 * Start the update: `amiro update <version>` on an install.sh server, or
 * `scripts/amiro-server.sh update <commit>` on a source checkout (the
 * branch's latest when nothing is given).
 */
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
  return apiJson<{ current: string; commit?: string | null; job: UpdateJob }>(`${UPDATE_KEY}/job`);
}

export async function saveUpdateSettings(patch: Partial<UpdateSettings>) {
  return apiJson<UpdateSettings>(`${UPDATE_KEY}/settings`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** The running server's version and commit, readable by any signed-in user. */
export async function getServerBuild(): Promise<Build> {
  const res = await apiJson<{ status: string; version?: string; commit?: string | null }>("/health");
  return { version: res.version ?? null, commit: res.commit ?? null };
}
