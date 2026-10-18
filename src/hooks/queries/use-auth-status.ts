"use client";

import { fetcher } from "@/lib/backend/client";
import useSWR from "swr";

/**
 * GET /api/auth/status -- `needsSetup` is true while the instance has no
 * account at all yet, which is when the first-run "Set up Amiro" page owns
 * account creation. `isFirstUser` is kept as an alias for older callers.
 *
 * Unauthenticated route, so no session is needed -- which matters, because
 * the whole point is answering it *before* anyone can sign in.
 */
export function useAuthStatus() {
  return useSWR<{ needsSetup: boolean; isFirstUser?: boolean }>(
    "/api/auth/status",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      shouldRetryOnError: false,
    },
  );
}
