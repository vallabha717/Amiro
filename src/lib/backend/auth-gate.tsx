"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "./session-context";

/**
 * Client-side replacement for the two server-side auth gates Next removed
 * by going all-client (Phase 7): src/proxy.ts's cookie-presence redirect
 * and every page/layout's own inline `getSession()` + `redirect()` call.
 * There is no middleware layer anymore -- the sidecar itself is the only
 * real enforcement point (every route already requires a valid bearer
 * token via auth.RequireSession); this is purely a UX redirect so a
 * logged-out user sees /sign-in instead of a page that 401s.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isPending && !session) {
      router.replace("/sign-in");
    }
  }, [isPending, session, router]);

  if (isPending || !session) {
    return null;
  }
  return <>{children}</>;
}

/** Used by the (auth) route group: signed-in users skip sign-in/sign-up. */
export function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isPending && session) {
      router.replace("/");
    }
  }, [isPending, session, router]);

  if (isPending || session) {
    return null;
  }
  return <>{children}</>;
}

/** For routes gated on `role === "admin"` (the (chat)/(admin) group). */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (isPending) return;
    if (!session) {
      router.replace("/sign-in");
    }
  }, [isPending, session, router]);

  if (isPending || !session) {
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
          Providers and Search Providers can only be configured by an
          administrator. Newly registered accounts do not have administrator
          permissions.
        </p>
        <p className="text-muted-foreground">
          Sign in with your administrator account, or ask the instance owner to
          grant access.
        </p>
        <a href="/" className="text-primary underline">
          Back to chat
        </a>
      </div>
    );
  }
  return <>{children}</>;
}
