"use client";

import { SWRConfigProvider } from "@/app/(chat)/swr-config";
import { AppPopupProvider } from "@/components/layouts/app-popup-provider";
import { UserDetailContent } from "@/components/user/user-detail/user-detail-content";
import { UserDetailContentSkeleton } from "@/components/user/user-detail/user-detail-content-skeleton";
import { RequireAuth } from "@/lib/backend/auth-gate";
import { Suspense } from "react";

/**
 * Team inside an agent's space (`/<agent>/team-room`): like the Team app, a
 * single floating window with no Amiro sidebar. A back link in the window
 * returns to the agent's space.
 */
export default function TeamSpaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <SWRConfigProvider>
        <AppPopupProvider
          userSettingsComponent={
            <Suspense fallback={<UserDetailContentSkeleton />}>
              <UserDetailContent view="user" />
            </Suspense>
          }
        />
        <div className="flex h-svh min-h-0 min-w-0 flex-col overflow-hidden bg-canvas workspace-canvas p-2 md:p-4">
          <main
            data-testid="team-space-window"
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-background shadow-panel"
          >
            {children}
          </main>
        </div>
      </SWRConfigProvider>
    </RequireAuth>
  );
}
