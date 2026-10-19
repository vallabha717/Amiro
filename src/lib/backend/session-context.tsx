"use client";

import { useEffect, useSyncExternalStore, useMemo } from "react";
import { ApiError, apiJson } from "./client";
import { getSessionToken, setSessionToken } from "./config";

export type BackendUser = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type SessionState = {
  user: BackendUser | null;
  isPending: boolean;
};

/**
 * Replaces better-auth's cookie-based session (read server-side via
 * `getSession()`/`auth.api.getSession`) with the Go sidecar's bearer-token
 * session (internal/auth, Phase 2): the token lives in localStorage
 * (backend/config.ts), and this module resolves *who* it belongs to once
 * via GET /api/auth/session, the same request every page used to get for
 * free from the server-rendered session cookie.
 *
 * A module-level store (not React context) so `login`/`setupOwner`/`logout`
 * work as plain async functions callable from event handlers -- exactly
 * how the old `authClient.signIn.email(...)` was called -- while still
 * being observable by components via useSyncExternalStore.
 */
let state: SessionState = { user: null, isPending: true };
const listeners = new Set<() => void>();

function setState(next: SessionState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

function getServerSnapshot(): SessionState {
  return { user: null, isPending: true };
}

let refreshed = false;

/**
 * On a real desktop launch, Rust injects the sidecar's freshly-minted
 * desktop-default-user session token as window.__BACKEND_SESSION_TOKEN__
 * before this script runs (see config.ts). backend-go's
 * EnsureDesktopDefaultUser clears any previous session for that user on
 * every startup (service.go's own doc comment), so the token from a prior
 * launch is already invalid -- always adopting the freshly-injected one
 * here, unconditionally, is what actually delivers "no login screen by
 * default on desktop" (plan section 3's resolved decision) rather than
 * leaving a stale, now-401ing token in localStorage from the previous run.
 */
function adoptInjectedSessionToken() {
  if (typeof window === "undefined") return;
  const injected = window.__BACKEND_SESSION_TOKEN__;
  if (injected) {
    setSessionToken(injected);
  }
}

export async function refreshSession() {
  const token = getSessionToken();
  if (!token) {
    setState({ user: null, isPending: false });
    return;
  }
  try {
    const user = await apiJson<BackendUser>("/api/auth/session");
    setState({ user, isPending: false });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setSessionToken(null);
    }
    setState({ user: null, isPending: false });
  }
}

export async function login(email: string, password: string) {
  const resp = await apiJson<{ user: BackendUser; token: string }>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
  );
  setSessionToken(resp.token);
  setState({ user: resp.user, isPending: false });
  return resp.user;
}

export async function setupOwner(
  email: string,
  password: string,
  name?: string,
  timezone?: string,
) {
  const resp = await apiJson<{ user: BackendUser; token: string }>(
    "/api/auth/setup",
    {
      method: "POST",
      body: JSON.stringify({ email, password, name, timezone }),
    },
  );
  setSessionToken(resp.token);
  setState({ user: resp.user, isPending: false });
  return resp.user;
}

/**
 * Change the owner's login email and/or password. The backend verifies the
 * current password and invalidates every other session, so this one keeps
 * working while any other device is signed out.
 */
export async function changeCredentials(input: {
  currentPassword: string;
  newEmail?: string;
  newPassword?: string;
}) {
  const resp = await apiJson<{ user: BackendUser }>("/api/auth/credentials", {
    method: "PUT",
    body: JSON.stringify(input),
  });
  setState({ user: resp.user, isPending: false });
  return resp.user;
}

export async function logout() {
  try {
    await apiJson("/api/auth/logout", { method: "POST" });
  } finally {
    setSessionToken(null);
    setState({ user: null, isPending: false });
  }
}

/** Mounted once near the root (app/layout.tsx) to kick off the initial
 * GET /api/auth/session resolution. */
export function BackendSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!refreshed) {
      refreshed = true;
      adoptInjectedSessionToken();
      refreshSession();
    }
  }, []);
  return <>{children}</>;
}

/** Shape-compatible with the old `authClient.useSession()` hook's return
 * value (`{data, isPending}`) so most call sites needed no import-shape
 * changes beyond swapping the import source. */
export function useSession(): {
  data: { user: BackendUser } | null;
  isPending: boolean;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  // Stable identity while the user is unchanged: callers put `data` in
  // effect deps, and a fresh object per render turned "load on session"
  // effects into fetch loops (the Schedules page refetched thousands of times).
  const user = snapshot.user;
  const data = useMemo(() => (user ? { user } : null), [user]);
  return useMemo(() => ({ data, isPending: snapshot.isPending }), [data, snapshot.isPending]);
}
