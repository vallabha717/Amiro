"use client";

import { PanelLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { TeamSidebar } from "./team-sidebar";
import { useSession } from "@/lib/backend/session-context";
import { SidebarProvider, useSidebar } from "ui/sidebar";
import { Button } from "ui/button";

/**
 * On a phone the team sidebar is a sheet that starts closed, and Team has no
 * app header: without this button there was no way to open it (or to leave
 * Team for the rest of Amiro).
 */
function MobileSidebarBar() {
  const t = useTranslations("Layout");
  const { toggleSidebar, openMobile } = useSidebar();
  return (
    <div className="flex shrink-0 items-center px-2 pt-2 md:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("toggleSidebar")}
        data-testid="sidebar-toggle"
        data-state={openMobile ? "open" : "closed"}
        onClick={toggleSidebar}
      >
        <PanelLeft />
      </Button>
    </div>
  );
}

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
          className="custom-scrollbar relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden rounded-2xl border bg-window shadow-panel"
        >
          <MobileSidebarBar />
          {/* Pages here fill the window (h-full); the bar above takes its
              share first so they never overflow by its height. */}
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </main>
      </div>
    </SidebarProvider>
  );
}
