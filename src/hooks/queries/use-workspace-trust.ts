"use client";
import {
  WorkspaceTrustGrant,
  WorkspaceTrustStatus,
} from "@/lib/backend/workspace-trust-api";
import { fetcher } from "lib/utils";
import useSWR, { SWRConfiguration } from "swr";

/**
 * Whether the signed-in user has already granted `root`. The key is `null`
 * (SWR's "don't fetch yet" convention) until a root is actually selected,
 * so the project picker's empty state never fires a request with an empty
 * `root` query param.
 */
export function useWorkspaceTrustStatus(
  root: string | undefined,
  options?: SWRConfiguration,
) {
  return useSWR<WorkspaceTrustStatus>(
    root
      ? `/api/workspace-trust/status?root=${encodeURIComponent(root)}`
      : null,
    fetcher,
    {
      revalidateOnFocus: false,
      errorRetryCount: 0,
      ...options,
    },
  );
}

/** Every root the signed-in user has granted -- a Settings page's list. */
export function useWorkspaceTrustGrants(options?: SWRConfiguration) {
  return useSWR<{ grants: WorkspaceTrustGrant[] }>(
    "/api/workspace-trust",
    fetcher,
    {
      revalidateOnFocus: false,
      fallbackData: { grants: [] },
      ...options,
    },
  );
}
