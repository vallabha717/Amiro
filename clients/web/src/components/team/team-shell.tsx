"use client";

import { TeamSidebar } from "./team-sidebar";
import { useSession } from "@/lib/backend/session-context";
import { SidebarProvider } from "ui/sidebar";

/**
 * The frame for Team: the dedicated team sidebar on the left (can open and close,
 * contains Create agent and user profile), followed by the floating team window
 * hosting agent profiles and the chat channel.
 */
export function TeamShell({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();

  return (
    <SidebarProvider
      defaultOpen={true}
      className="h-svh overflow-hidden bg-canvas workspace-canvas motion-reduce:[&_*]:transition-none"
    >
      {session?.user && <TeamSidebar user={session.user} />}
      <div className="flex h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2 md:py-4 md:pr-4 md:pl-2">
        <main
          data-testid="team-window"
          className="custom-scrollbar relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden rounded-2xl border bg-background shadow-panel"
        >
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
