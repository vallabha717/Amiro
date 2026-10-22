"use client";

import { AppSidebarUser } from "@/components/layouts/app-sidebar-user";
import { VrndaLogo } from "@/components/layouts/vrnda-logo";
import { BasicUser } from "app-types/user";
import { cn } from "lib/utils";
import {
  ArrowUpRightIcon,
  BarChart3,
  PanelLeftClose,
  PanelLeftOpen,
  PlusIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  const pathname = usePathname();
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
              aria-label="Teams"
            >
              <VrndaLogo className="size-6" />
              <span className="font-brand font-bold text-xl tracking-tight text-foreground">
                Amiro
              </span>
              <span className="rounded-full border bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                Teams
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
            {/* Create Agent Action */}
            <SidebarMenu className="mb-2">
              <SidebarMenuItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href="/team/new"
                      data-testid="team-new-agent"
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                      className="w-full"
                    >
                      <SidebarMenuButton className="flex font-semibold group/new-agent bg-input/20 border border-border/40 hover:bg-sidebar-accent hover:text-sidebar-foreground">
                        <PlusIcon className="size-4 shrink-0" />
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

            {/* Teams Navigation items matching main sidebar styling */}
            <SidebarMenu>
              <SidebarMenuItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href="/team"
                      data-testid="team-sidebar-agents-link"
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                    >
                      <SidebarMenuButton
                        className="font-semibold"
                        isActive={pathname === "/team"}
                      >
                        <UsersRoundIcon className="size-4" />
                        <span>Agents</span>
                      </SidebarMenuButton>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center">
                    Agents
                  </TooltipContent>
                </Tooltip>
              </SidebarMenuItem>
            </SidebarMenu>

            <SidebarMenu>
              <SidebarMenuItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href="/team/usage"
                      data-testid="team-sidebar-usage-link"
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                    >
                      <SidebarMenuButton
                        className="font-semibold"
                        isActive={pathname.startsWith("/team/usage")}
                      >
                        <BarChart3 className="size-4" />
                        <span>Usage</span>
                      </SidebarMenuButton>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center">
                    Usage
                  </TooltipContent>
                </Tooltip>
              </SidebarMenuItem>
            </SidebarMenu>

            <SidebarMenu>
              <SidebarMenuItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href="/amiro"
                      data-testid="team-open-amiro"
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                    >
                      <SidebarMenuButton className="font-semibold">
                        <ArrowUpRightIcon className="size-4" />
                        <span>{t("openAmiro")}</span>
                      </SidebarMenuButton>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center">
                    {t("openAmiro")}
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
