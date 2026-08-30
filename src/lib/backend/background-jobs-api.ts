import { apiJson } from "./client";

export const BACKGROUND_JOBS_KEY = "/api/background-jobs";

/**
 * One background agent run, mirroring
 * backend-go/internal/api/backgroundjob's unexported jobResponse
 * (docs/coding-agent-parity/05-background-agent-runs.md).
 */
export interface BackgroundJob {
  id: string;
  threadId: string;
  workspaceRoot: string;
  prompt: string;
  mode: string;
  status: "running" | "suspended" | "done" | "failed" | "interrupted";
  autoPr: boolean;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface CreateBackgroundJobRequest {
  prompt: string;
  mode: "edit" | "auto";
  workspaceRoot?: string;
  autoPr?: boolean;
}

export async function selectBackgroundJobs(): Promise<BackgroundJob[]> {
  const res = await apiJson<{ jobs: BackgroundJob[] }>(BACKGROUND_JOBS_KEY, {
    method: "GET",
  });
  return res.jobs;
}

export async function createBackgroundJob(
  req: CreateBackgroundJobRequest,
): Promise<BackgroundJob> {
  return apiJson<BackgroundJob>(BACKGROUND_JOBS_KEY, {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function selectBackgroundJob(id: string): Promise<BackgroundJob> {
  return apiJson<BackgroundJob>(`${BACKGROUND_JOBS_KEY}/${id}`, {
    method: "GET",
  });
}
