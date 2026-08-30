import { apiJson } from "./client";

export const WORKSPACE_TRUST_KEY = "/api/workspace-trust";

/**
 * One root the current user has granted the agent write/exec/external
 * access to. Mirrors backend-go/internal/api/workspacetrust's grantResponse.
 */
export interface WorkspaceTrustGrant {
  resolvedRoot: string;
  grantedAt: string;
  grantedVia: "prompt" | "env";
}

export interface WorkspaceTrustStatus {
  trusted: boolean;
  resolvedRoot: string;
}

/**
 * Whether the current user has already granted `root` -- the check a
 * first-open-of-project prompt makes before deciding whether to show
 * itself. `root` is resolved server-side (symlinks, absolute form), so the
 * caller does not need to normalize it first.
 */
export async function selectWorkspaceTrustStatus(
  root: string,
): Promise<WorkspaceTrustStatus> {
  return apiJson<WorkspaceTrustStatus>(
    `${WORKSPACE_TRUST_KEY}/status?root=${encodeURIComponent(root)}`,
    { method: "GET" },
  );
}

export async function selectWorkspaceTrustGrants(): Promise<
  WorkspaceTrustGrant[]
> {
  const res = await apiJson<{ grants: WorkspaceTrustGrant[] }>(
    WORKSPACE_TRUST_KEY,
    { method: "GET" },
  );
  return res.grants;
}

/** The human answer to the trust prompt. */
export async function grantWorkspaceTrust(
  root: string,
): Promise<WorkspaceTrustStatus> {
  return apiJson<WorkspaceTrustStatus>(`${WORKSPACE_TRUST_KEY}/grant`, {
    method: "POST",
    body: JSON.stringify({ root }),
  });
}

/**
 * Forward-only: does not undo anything a turn already in flight is doing,
 * only changes what a future turn against `root` may do.
 */
export async function revokeWorkspaceTrust(root: string): Promise<void> {
  await apiJson(`${WORKSPACE_TRUST_KEY}/revoke`, {
    method: "POST",
    body: JSON.stringify({ root }),
  });
}
