"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "ui/sidebar";

import { AppSidebarMenus } from "./app-sidebar-menus";
import { AppSidebarSkills } from "./app-sidebar-skills";
import { AppSidebarThreads } from "./app-sidebar-threads";
import { AppSidebarUser } from "./app-sidebar-user";
import { VrndaLogo } from "./vrnda-logo";
import { agentScopedPath } from "@/components/team/team-paths";
import { useAgentScope } from "@/lib/backend/agent-scope";

import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { BasicUser } from "app-types/user";
import { Shortcuts, isShortcutEvent } from "lib/keyboard-shortcuts";
import { cn } from "lib/utils";

/**
 * The sidebar (new chat, connectors, schedules, admin, archive, agent, recent
 * chats, account menu) in the VegaAI frame (app.vegaai.dev): a floating
 * rounded panel on the workspace canvas with a collapse toggle in its header.
 * Collapses to an icon rail with the toggle or Ctrl/Cmd+B.
 */
export function AppSidebar({ user }: { user?: BasicUser }) {
  const router = useRouter();
  const t = useTranslations("SidebarFrame");
  const { toggleSidebar, state, isMobile, setOpenMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;
  const agentScope = useAgentScope();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isShortcutEvent(e, Shortcuts.openNewChat)) {
        e.preventDefault();
        router.push(agentScopedPath(agentScope, "/"));
        router.refresh();
      } else if (isShortcutEvent(e, Shortcuts.toggleSidebar)) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router, toggleSidebar, agentScope]);

  return (
    <Sidebar
      collapsible="icon"
      variant="floating"
      className="md:py-4 md:pl-4 [&_[data-slot=sidebar-inner]]:rounded-2xl motion-reduce:transition-none"
    >
      <SidebarHeader className="shrink-0 pt-2 pb-1.5 border-b border-sidebar-border/60 px-2.5 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-1.5">
        <div
          className={cn(
            "flex items-center gap-1.5",
            isCollapsed ? "justify-center" : "justify-between",
          )}
        >
          {!isCollapsed && (
            <Link
              href={agentScopedPath(agentScope, "/")}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
              className="flex min-w-0 items-center"
              aria-label={t("home")}
            >
              <span className="flex items-center gap-1.5">
                <VrndaLogo className="size-6 shrink-0" />
                <span className="font-brand font-bold text-[26px] tracking-tight text-foreground">
                  Amiro
                </span>
              </span>
            </Link>
          )}
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={t(isCollapsed ? "expandSidebar" : "collapseSidebar")}
            title={t(isCollapsed ? "expandSidebar" : "collapseSidebar")}
            data-testid="sidebar-inline-toggle"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none transition-colors duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:scale-95"
          >
            {isCollapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <PanelLeftClose className="size-4" />
            )}
          </button>
        </div>
      </SidebarHeader>

      <SidebarContent className="custom-scrollbar relative">
        <div className="flex flex-col">
          <AppSidebarMenus user={user} />
          <AppSidebarSkills />
          <AppSidebarThreads />
        </div>
      </SidebarContent>

      <SidebarFooter className="flex shrink-0 flex-col items-stretch gap-2 border-t border-sidebar-border/60 p-2">
        <div className="group-data-[collapsible=icon]:hidden">
          <SetupChecklist />
        </div>
        <AppSidebarUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
