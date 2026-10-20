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
    // VegaAI shell (app.vegaai.dev): the provider paints the textured canvas;
    // the sidebar and the chat window both float on it as rounded panels
    // (globals.css `workspace-canvas`, `[data-slot="sidebar-inner"]`,
    // `[data-testid="main-window"]`).
    <SidebarProvider
      defaultOpen={!isCollapsed}
      className="h-svh overflow-hidden bg-canvas workspace-canvas motion-reduce:[&_*]:transition-none"
    >
      <SWRConfigProvider>
        <AppPopupProvider
          userSettingsComponent={
            <Suspense fallback={<UserDetailContentSkeleton />}>
              <UserDetailContent view="user" />
            </Suspense>
          }
        />
        <AppSidebar user={session!.user} />
        <div className="flex h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2 md:py-4 md:pr-4 md:pl-2">
          <main
            data-testid="main-window"
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-background shadow-panel"
          >
            <AppHeader />
            <div className="custom-scrollbar min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              {children}
            </div>
          </main>
        </div>
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
