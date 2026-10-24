import { apiJson } from "./client";

export const GITHUB_STATUS_KEY = "/api/github/status";

/**
 * Whether a GitHub personal access token is currently stored -- presence
 * only, mirroring backend-go/internal/api/github's own contract (the token
 * itself never appears in a response).
 */
export interface GitHubStatus {
  connected: boolean;
}

export async function selectGitHubStatus(): Promise<GitHubStatus> {
  return apiJson<GitHubStatus>(GITHUB_STATUS_KEY, { method: "GET" });
}

/** Stores a new token, connecting (or reconnecting) GitHub. */
export async function connectGitHub(token: string): Promise<GitHubStatus> {
  return apiJson<GitHubStatus>("/api/github/connect", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** Removes the stored token. */
export async function disconnectGitHub(): Promise<void> {
  await apiJson("/api/github/disconnect", { method: "POST" });
}
