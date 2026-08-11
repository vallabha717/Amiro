"use client";

// Replaces better-auth/react's createAuthClient with a thin adapter over
// the Go sidecar's own bearer-token auth (backend/session-context.tsx) --
// better-auth is not vendored on the Go side at all (plan section 3's
// resolved decision). Kept as a same-shaped `authClient.signIn.email` /
// `.signOut` / `.useSession()` object so the handful of components that
// used to call better-auth directly needed a minimal diff, not a rewrite.
//
// Not carried over: `signIn.social` (OAuth/social sign-in) and the
// `adminClient` plugin (role/ban/session management across users) --
// internal/auth (Phase 2) only ever implements Register/Login/Logout/
// ValidateSession for one user acting as themselves, with no OAuth
// provider wiring and no admin-plugin equivalent. Call sites for both
// were updated in the same pass as this file to drop those paths, not
// left pointing at a method that no longer exists.
import { useSession, login, register, logout } from "@/lib/backend/session-context";

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
  signUp: {
    email: async (
      {
        email,
        password,
        name,
      }: { email: string; password: string; name: string },
      opts?: { onError?: ErrorCallback },
    ) => {
      try {
        const user = await register(name, email, password);
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
