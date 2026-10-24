"use client";

// Replaces better-auth/react's createAuthClient with a thin adapter over
// the sidecar's own bearer-token auth (backend/session-context.tsx) --
// better-auth is not vendored at all. Kept as a same-shaped
// `authClient.signIn.email` / `.signOut` object so the handful of components
// that used to call better-auth directly needed a minimal diff, not a rewrite.
//
// There is no sign-up: Amiro is a single-owner app and the owner is created
// through the first-run setup flow (or AMIRO_OWNER_EMAIL/PASSWORD at boot).
import { login, logout, useSession } from "@/lib/backend/session-context";

type ErrorCallback = (ctx: {
  error: { message?: string; statusText?: string };
}) => void;

function toErrorCtx(e: unknown): { error: { message?: string } } {
  return {
    error: { message: e instanceof Error ? e.message : "Request failed" },
  };
}

export const authClient = {
  useSession,
  signIn: {
    email: async (
      { email, password }: { email: string; password: string },
      opts?: { onError?: ErrorCallback },
    ) => {
      try {
        const user = await login(email, password);
        return { data: { user } };
      } catch (e) {
        opts?.onError?.(toErrorCtx(e));
        throw e;
      }
    },
  },
  signOut: async () => {
    await logout();
  },
};
