"use client";

import { SWRConfigProvider } from "@/app/(chat)/swr-config";
import { AppPopupProvider } from "@/components/layouts/app-popup-provider";
import { TeamShell } from "@/components/team/team-shell";
import { UserDetailContent } from "@/components/user/user-detail/user-detail-content";
import { UserDetailContentSkeleton } from "@/components/user/user-detail/user-detail-content-skeleton";
import { RequireAuth } from "@/lib/backend/auth-gate";
import { Suspense } from "react";

/**
 * Team is its own full-page app: no main sidebar or header, only the team.
 * The main Amiro UI stays one click away in the top bar.
 */
export default function TeamLayout({ children }: { children: React.ReactNode }) {
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
        <TeamShell>{children}</TeamShell>
      </SWRConfigProvider>
    </RequireAuth>
  );
}
