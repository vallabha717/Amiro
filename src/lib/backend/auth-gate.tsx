"use client";

import { useAuthStatus } from "@/hooks/queries/use-auth-status";
import { useOnboarding } from "@/lib/onboarding/onboarding-api";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "./session-context";

/**
 * Client-side replacement for the two server-side auth gates Next removed
 * by going all-client (Phase 7): src/proxy.ts's cookie-presence redirect
 * and every page/layout's own inline `getSession()` + `redirect()` call.
 * There is no middleware layer anymore -- the sidecar itself is the only
 * real enforcement point (every route already requires a valid bearer
 * token via auth.RequireSession); this is purely a UX redirect so a
 * logged-out user sees /sign-in instead of a page that 401s.
 *
 * On a fresh instance with no account at all, both gates send the user to
 * the onboarding wizard instead of the sign-in form; a signed-in owner who
 * has not finished onboarding is sent back to it.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const { data: status, isLoading } = useAuthStatus();
  const isOwner = session?.user.role === "admin";
  // The owner finishes (or skips through) onboarding before the app proper.
  // A failed request never blocks the app: only an explicit `false` redirects.
  const { data: onboarding } = useOnboarding(isOwner);
  const router = useRouter();
  const needsOnboarding = isOwner && onboarding?.completed === false;

  useEffect(() => {
    if (isPending || isLoading) return;
    if (!session) {
      router.replace(status?.needsSetup ? "/onboarding" : "/sign-in");
    } else if (needsOnboarding) {
      router.replace("/onboarding");
    }
  }, [isPending, isLoading, session, status, needsOnboarding, router]);

  if (isPending || isLoading || !session || needsOnboarding) {
    return null;
  }
  return <>{children}</>;
}

/**
 * Used by the (auth) route group. Signed-in users skip the auth pages; a
 * fresh instance is forced onto /setup, and a configured instance cannot
 * reach /setup.
 */
export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const { data: status, isLoading } = useAuthStatus();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (isPending || isLoading) return;
    if (session) {
      router.replace("/team");
      return;
    }
    if (status?.needsSetup) {
      router.replace("/onboarding");
    } else if (pathname === "/setup") {
      router.replace("/sign-in");
    }
  }, [isPending, isLoading, session, status, pathname, router]);

  if (isPending || isLoading || session) {
    return null;
  }
  return <>{children}</>;
}

/** For routes gated on `role === "admin"` (the (chat)/(admin) group). */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const { data: status, isLoading } = useAuthStatus();
  const router = useRouter();

  useEffect(() => {
    if (isPending || isLoading) return;
    if (!session) {
      router.replace(status?.needsSetup ? "/onboarding" : "/sign-in");
    }
  }, [isPending, isLoading, session, status, router]);

  if (isPending || isLoading || !session) {
    return null;
  }
  if (session.user.role !== "admin") {
    return (
      <div
        className="mx-auto flex max-w-lg flex-col gap-4 px-8 py-16"
        role="alert"
      >
        <h1 className="text-2xl font-semibold">
          Administrator access required
        </h1>
        <p className="text-muted-foreground">
          Providers and Search Providers can only be configured by the instance
          owner.
        </p>
        <p className="text-muted-foreground">
          Sign in with the owner account to continue.
        </p>
        <a href="/" className="text-primary underline">
          Back to chat
        </a>
      </div>
    );
  }
  return <>{children}</>;
}
