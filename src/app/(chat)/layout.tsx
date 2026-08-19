"use client";

import { SidebarProvider } from "ui/sidebar";
import { AppSidebar } from "@/components/layouts/app-sidebar";
import { AppHeader } from "@/components/layouts/app-header";

import { COOKIE_KEY_SIDEBAR_STATE } from "lib/const";
import { AppPopupProvider } from "@/components/layouts/app-popup-provider";
import { SWRConfigProvider } from "./swr-config";
import { UserDetailContent } from "@/components/user/user-detail/user-detail-content";
import { UserDetailContentSkeleton } from "@/components/user/user-detail/user-detail-content-skeleton";

import { Suspense, useMemo } from "react";
import { RequireAuth } from "@/lib/backend/auth-gate";
import { useSession } from "@/lib/backend/session-context";

// Was a Server Component reading the session cookie + a sidebar-state
// cookie via next/headers, then redirecting server-side. Now client-side
// throughout: RequireAuth replaces the getSession()+redirect() gate (see
// its doc comment), and the sidebar cookie is read directly from
// document.cookie the same way ui/sidebar.tsx already *writes* it on
// toggle -- no more round trip through next/headers for a value the
// client already owns. experimental_ppr (Partial Prerendering) is
// dropped: it has no meaning for a client component.
function readSidebarCollapsedCookie(): boolean {
  if (typeof document === "undefined") return false;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${COOKIE_KEY_SIDEBAR_STATE}=`));
  if (!match) return false;
  return match.split("=")[1] === "false";
}

function ChatLayoutInner({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const isCollapsed = useMemo(() => readSidebarCollapsedCookie(), []);

  return (
    <SidebarProvider defaultOpen={!isCollapsed}>
      <SWRConfigProvider>
        <AppPopupProvider
          userSettingsComponent={
            <Suspense fallback={<UserDetailContentSkeleton />}>
              <UserDetailContent view="user" />
            </Suspense>
          }
        />
        <AppSidebar user={session!.user} />
        <main className="relative bg-background flex-1 min-w-0 flex flex-col h-screen overflow-hidden">
          <AppHeader />
          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">{children}</div>
        </main>
      </SWRConfigProvider>
    </SidebarProvider>
  );
}

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireAuth>
      <ChatLayoutInner>{children}</ChatLayoutInner>
    </RequireAuth>
  );
}
