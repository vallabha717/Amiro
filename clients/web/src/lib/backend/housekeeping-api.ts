"use client";

import { apiJson } from "./client";

/** The built-in Cleanup task (Schedules page → System tasks). */
export interface CleanupSettings {
  enabled: boolean;
  /** Delete what nobody has touched for this many hours. */
  olderThanHours: number;
  /** Time of day it runs, HH:MM in the owner's timezone. */
  time: string;
  chats: boolean;
  archived: boolean;
  scheduleRuns: boolean;
  logFiles: boolean;
}

export interface CleanupReport {
  dryRun: boolean;
  olderThanHours: number;
  chats: number;
  chatList: { id: string; title: string | null; lastMessageAt: string | null }[];
  scheduleRuns: number;
  logFiles: number;
  bytes: number;
  text: string;
  error?: string;
}

export interface CleanupView {
  settings: CleanupSettings;
  timezone: string;
  summary: string;
  lastRunAt: string | null;
  lastReport: CleanupReport | null;
  nextRunAt: string | null;
}

export const HOUSEKEEPING_KEY = "/api/housekeeping";

export function getCleanup(): Promise<CleanupView> {
  return apiJson<CleanupView>(HOUSEKEEPING_KEY);
}

export function saveCleanup(patch: Partial<CleanupSettings>): Promise<CleanupView> {
  return apiJson<CleanupView>(HOUSEKEEPING_KEY, { method: "PUT", body: JSON.stringify(patch) });
}

/** Preview (`dryRun`) or run a cleanup now with these settings. */
export function runCleanup(
  settings: Partial<CleanupSettings>,
  dryRun: boolean,
): Promise<{ report: CleanupReport; housekeeping: CleanupView }> {
  return apiJson(`${HOUSEKEEPING_KEY}/run`, { method: "POST", body: JSON.stringify({ ...settings, dryRun }) });
}
