"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/backend/client";

/**
 * GET /api/auth/status -- currently just `isFirstUser`, the "this instance
 * has no accounts at all yet" flag. better-chatbot read the equivalent
 * server-side (`await getIsFirstUser()` in the sign-in page's Server
 * Component); this app renders auth fully client-side, so it comes over
 * HTTP instead.
 *
 * Unauthenticated route, so no session is needed -- which matters, because
 * the whole point is answering it *before* anyone can sign in.
 */
export function useAuthStatus() {
  return useSWR<{ isFirstUser: boolean; registrationEnabled?: boolean }>(
    "/api/auth/status",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateIfStale: false,
      shouldRetryOnError: false,
    },
  );
}
