"use client";

import { apiJson } from "./client";

export type ScheduleMode = "execute" | "notify";

export type ScheduleKind =
  | { kind: "once"; at: string }
  | { kind: "cron"; expression: string }
  | { kind: "interval"; minutes: number };

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  mode: ScheduleMode;
  timezone: string;
  schedule: ScheduleKind;
  model: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "ok" | "failed" | "skipped" | null;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Backend may emit ok/failed/skipped or running/done/interrupted depending on execution path. */
  status: "ok" | "failed" | "skipped" | "running" | "done" | "error" | "interrupted" | string;
  outputPreview?: string | null;
  error?: string | null;
  threadId?: string | null;
  jobId?: string | null;
}

export const SCHEDULES_KEY = "/api/schedules";

export async function listSchedules(): Promise<Schedule[]> {
  const res = await apiJson<{ schedules: Schedule[] }>(SCHEDULES_KEY, {
    method: "GET",
  });
  return res.schedules ?? [];
}

export async function getSchedule(id: string): Promise<Schedule> {
  const res = await apiJson<{ schedule: Schedule }>(
    `${SCHEDULES_KEY}/${encodeURIComponent(id)}`,
    { method: "GET" },
  );
  return res.schedule;
}

export interface CreateScheduleInput {
  name: string;
  prompt: string;
  mode: ScheduleMode;
  timezone: string;
  schedule: ScheduleKind;
  model?: string | null;
  enabled?: boolean;
}

export async function createSchedule(
  input: CreateScheduleInput,
): Promise<Schedule> {
  const res = await apiJson<{ schedule: Schedule }>(SCHEDULES_KEY, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return res.schedule;
}

export type UpdateScheduleInput = Partial<CreateScheduleInput> & {
  enabled?: boolean;
};

export async function updateSchedule(
  id: string,
  patch: UpdateScheduleInput,
): Promise<Schedule> {
  const res = await apiJson<{ schedule: Schedule }>(
    `${SCHEDULES_KEY}/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  return res.schedule;
}

export async function deleteSchedule(id: string): Promise<void> {
  await apiJson<void>(`${SCHEDULES_KEY}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function runScheduleNow(
  id: string,
): Promise<{ schedule: Schedule; run: ScheduleRun }> {
  return apiJson<{ schedule: Schedule; run: ScheduleRun }>(
    `${SCHEDULES_KEY}/${encodeURIComponent(id)}/run`,
    { method: "POST" },
  );
}

export async function listScheduleRuns(id: string): Promise<ScheduleRun[]> {
  const res = await apiJson<{ runs: ScheduleRun[] }>(
    `${SCHEDULES_KEY}/${encodeURIComponent(id)}/runs`,
    { method: "GET" },
  );
  return res.runs ?? [];
}

export async function previewSchedule(params: {
  schedule: ScheduleKind;
  timezone: string;
}): Promise<string[]> {
  const res = await apiJson<{ nextRuns: string[] }>(
    `${SCHEDULES_KEY}/preview`,
    { method: "POST", body: JSON.stringify(params) },
  );
  return res.nextRuns ?? [];
}
