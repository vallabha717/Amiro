"use client";

import { AppSidebarUser } from "@/components/layouts/app-sidebar-user";
import { VrndaLogo } from "@/components/layouts/vrnda-logo";
import { BasicUser } from "app-types/user";
import { cn } from "lib/utils";
import { PanelLeftClose, PanelLeftOpen, UserPlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";

export function TeamSidebar({ user }: { user?: BasicUser }) {
  const t = useTranslations("Team");
  const tFrame = useTranslations("SidebarFrame");
  const { toggleSidebar, state, isMobile, setOpenMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;

  return (
    <Sidebar
      collapsible="icon"
      variant="floating"
      className="md:py-4 md:pl-4 [&_[data-slot=sidebar-inner]]:rounded-2xl motion-reduce:transition-none"
    >
      <SidebarHeader className="h-16 shrink-0 justify-center border-b border-sidebar-border/60 px-3 group-data-[collapsible=icon]:px-0">
        <div
          className={cn(
            "flex items-center gap-2",
            isCollapsed ? "justify-center" : "justify-between",
          )}
        >
          {!isCollapsed && (
            <Link
              href="/team"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
              className="flex min-w-0 items-center gap-2"
              aria-label={t("homeLabel")}
            >
              <VrndaLogo className="size-6" />
              <span className="font-brand font-bold text-xl tracking-tight text-foreground">
                Amiro
              </span>
              <span className="rounded-full border bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t("title")}
              </span>
            </Link>
          )}
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={tFrame(isCollapsed ? "expandSidebar" : "collapseSidebar")}
            title={tFrame(isCollapsed ? "expandSidebar" : "collapseSidebar")}
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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href="/team/new"
                      data-testid="team-sidebar-new-agent"
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                      className="w-full"
                    >
                      <SidebarMenuButton
                        size="lg"
                        className="font-semibold bg-input/20 border border-border/40 hover:bg-accent hover:text-accent-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
                      >
                        <UserPlusIcon className="size-4 shrink-0" />
                        <span className="truncate">{t("newAgent")}</span>
                      </SidebarMenuButton>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center">
                    {t("newAgent")}
                  </TooltipContent>
                </Tooltip>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="flex shrink-0 flex-col items-stretch gap-2 border-t border-sidebar-border/60 p-2">
        <AppSidebarUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
