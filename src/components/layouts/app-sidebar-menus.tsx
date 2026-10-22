"use client";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "ui/sidebar";
import { SidebarMenu, SidebarMenuItem } from "ui/sidebar";
import { SidebarGroupContent } from "ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";

import { useArchives } from "@/hooks/queries/use-archives";
import { BasicUser } from "app-types/user";
import { Shortcuts, getShortcutKeyList } from "lib/keyboard-shortcuts";
import { cn } from "lib/utils";
import {
  BarChart3,
  Bell,
  CalendarClockIcon,
  ChevronRight,
  Cpu,
  FilesIcon,
  FolderOpenIcon,
  FolderSearchIcon,
  KeyRound,
  MessageSquare,
  PlugZapIcon,
  PlusIcon,
  Puzzle,
  Search,
  Shield,
  SlidersHorizontal,
  UsersRoundIcon,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { SidebarGroup } from "ui/sidebar";
import { Skeleton } from "ui/skeleton";
import { WriteIcon } from "ui/write-icon";
import { ArchiveDialog } from "../archive-dialog";
import { useOpenArtifact } from "../artifacts/plan-card";
import { AppSidebarAdmin } from "./app-sidebar-menu-admin";
import { agentScopedPath, matchSubPath } from "@/components/team/team-paths";
import { useAgentScope } from "@/lib/backend/agent-scope";

export type SidebarActivityMode = "conversations" | "admin";

type AdminNavItem = {
  id: string;
  title: string;
  href: string;
  icon: LucideIcon;
  testId: string;
};

const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  {
    id: "providers",
    title: "Models & Providers",
    href: "/admin/providers",
    icon: Cpu,
    testId: "sidebar-admin-nav-providers",
  },
  {
    id: "credentials",
    title: "Credentials",
    href: "/admin/credentials",
    icon: KeyRound,
    testId: "sidebar-admin-nav-credentials",
  },
  {
    id: "integrations",
    title: "Integrations & MCP",
    href: "/admin/integrations",
    icon: Puzzle,
    testId: "sidebar-admin-nav-integrations",
  },
  {
    id: "search",
    title: "Search Providers",
    href: "/admin/search",
    icon: Search,
    testId: "sidebar-admin-nav-search",
  },
  {
    id: "voice",
    title: "Voice & Speech",
    href: "/admin/voice",
    icon: Volume2,
    testId: "sidebar-admin-nav-voice",
  },
  {
    id: "notifications",
    title: "Notifications",
    href: "/admin/notifications",
    icon: Bell,
    testId: "sidebar-admin-nav-notifications",
  },
  {
    id: "usage",
    title: "Usage & Users",
    href: "/admin/usage",
    icon: BarChart3,
    testId: "sidebar-admin-nav-usage",
  },
  {
    id: "general",
    title: "General",
    href: "/admin/general",
    icon: SlidersHorizontal,
    testId: "sidebar-admin-nav-general",
  },
];

export function AppSidebarMenus({
  user,
  mode = "conversations",
  onModeChange,
}: {
  user?: BasicUser;
  mode?: SidebarActivityMode;
  onModeChange?: (mode: SidebarActivityMode) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentArchiveId = searchParams?.get("id");
  const t = useTranslations("");
  const { setOpenMobile } = useSidebar();
  const agentScope = useAgentScope();
  const [expandedArchive, setExpandedArchive] = useState(() =>
    matchSubPath(pathname, "/archive"),
  );
  const [addArchiveDialogOpen, setAddArchiveDialogOpen] = useState(false);

  useEffect(() => {
    if (matchSubPath(pathname, "/archive")) {
      setExpandedArchive(true);
    }
  }, [pathname]);

  const openArtifact = useOpenArtifact();
  const openArtifacts = useCallback(() => {
    setOpenMobile(false);
    const homePath = agentScopedPath(agentScope, "/");
    if (!matchSubPath(pathname, "/")) router.push(homePath);
    openArtifact("files");
  }, [openArtifact, pathname, router, setOpenMobile, agentScope]);

  const { data: archives, isLoading: isLoadingArchives } = useArchives();
  const toggleArchive = useCallback(() => {
    setExpandedArchive((prev) => !prev);
  }, []);

  const isAdminMode = mode === "admin";

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        {/* Theme-switch style Segmented Toggle: Conversations vs Admin (above New Chat) */}
        <div
          role="group"
          aria-label="Sidebar view mode"
          data-testid="sidebar-activity-switch"
          className="mb-2 flex items-center rounded-full border border-sidebar-border/80 bg-input/25 p-0.5 group-data-[collapsible=icon]:hidden"
        >
          <button
            type="button"
            data-testid="sidebar-switch-conversations"
            aria-pressed={!isAdminMode}
            onClick={() => onModeChange?.("conversations")}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              !isAdminMode
                ? "bg-accent text-foreground ring-1 ring-muted-foreground/30 shadow-2xs font-semibold"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Conversations</span>
          </button>
          <button
            type="button"
            data-testid="sidebar-switch-admin"
            aria-pressed={isAdminMode}
            onClick={() => onModeChange?.("admin")}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              isAdminMode
                ? "bg-accent text-foreground ring-1 ring-muted-foreground/30 shadow-2xs font-semibold"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Shield className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Admin</span>
          </button>
        </div>

        <SidebarMenu>
          <Tooltip>
            <SidebarMenuItem className="mb-1">
              <Link
                href={agentScopedPath(agentScope, "/")}
                data-testid="sidebar-new-chat-button"
                onClick={(e) => {
                  e.preventDefault();
                  setOpenMobile(false);
                  onModeChange?.("conversations");
                  router.push(agentScopedPath(agentScope, "/"));
                  router.refresh();
                }}
              >
                <SidebarMenuButton className="flex font-semibold group/new-chat bg-input/20 border border-border/40">
                  <WriteIcon className="size-4" />
                  {t("Layout.newChat")}
                  <div className="flex items-center gap-1 text-xs font-medium ml-auto opacity-0 group-hover/new-chat:opacity-100 transition-opacity">
                    {getShortcutKeyList(Shortcuts.openNewChat).map((key) => (
                      <span
                        key={key}
                        className="border w-5 h-5 flex items-center justify-center bg-accent rounded"
                      >
                        {key}
                      </span>
                    ))}
                  </div>
                </SidebarMenuButton>
              </Link>
            </SidebarMenuItem>
          </Tooltip>
        </SidebarMenu>

        {isAdminMode ? (
          <>
            <SidebarMenu>
              <SidebarMenuItem>
                <Link
                  href="/team"
                  data-testid="sidebar-team-link"
                  onClick={() => setOpenMobile(false)}
                >
                  <SidebarMenuButton
                    className="font-semibold"
                    isActive={pathname.startsWith("/team")}
                  >
                    <UsersRoundIcon className="size-4" />
                    {t("Layout.team")}
                  </SidebarMenuButton>
                </Link>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarMenu>
              <Tooltip>
                <SidebarMenuItem>
                  <Link
                    href={agentScopedPath(agentScope, "/connectors")}
                    data-testid="sidebar-connectors-link"
                    onClick={() => setOpenMobile(false)}
                  >
                    <SidebarMenuButton
                      className="font-semibold"
                      isActive={
                        matchSubPath(pathname, "/connectors") ||
                        matchSubPath(pathname, "/mcp")
                      }
                    >
                      <PlugZapIcon className="size-4" />
                      {t("Layout.connectors")}
                    </SidebarMenuButton>
                  </Link>
                </SidebarMenuItem>
              </Tooltip>
            </SidebarMenu>
            <SidebarMenu>
              <SidebarMenuItem>
                <Link
                  href={agentScopedPath(agentScope, "/schedules")}
                  data-testid="sidebar-schedules-link"
                  onClick={() => setOpenMobile(false)}
                >
                  <SidebarMenuButton
                    className="font-semibold"
                    isActive={matchSubPath(pathname, "/schedules")}
                  >
                    <CalendarClockIcon className="size-4" />
                    Schedules
                  </SidebarMenuButton>
                </Link>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="font-semibold"
                  data-testid="sidebar-artifacts-link"
                  aria-label={t("Layout.artifacts")}
                  onClick={openArtifacts}
                >
                  <FilesIcon className="size-4" />
                  {t("Layout.artifacts")}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            {user && <AppSidebarAdmin />}

            {/* Dedicated Admin Activity Links */}
            <div className="mt-2 border-t border-sidebar-border/50 pt-2 group-data-[collapsible=icon]:hidden">
              <p className="mb-1 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Admin Controls
              </p>
              <SidebarMenu>
                {ADMIN_NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const active =
                    matchSubPath(pathname, item.href) ||
                    (item.id === "usage" && matchSubPath(pathname, "/admin/users"));
                  return (
                    <SidebarMenuItem key={item.id}>
                      <Link
                        href={agentScopedPath(agentScope, item.href)}
                        data-testid={item.testId}
                        onClick={() => setOpenMobile(false)}
                      >
                        <SidebarMenuButton
                          className="font-medium text-xs"
                          isActive={active}
                        >
                          <Icon className="size-3.5" />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                      </Link>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </div>
          </>
        ) : (
          <SidebarMenu className="group/archive">
            <Tooltip>
              <SidebarMenuItem>
                <SidebarMenuButton
                  data-testid="sidebar-archive-link"
                  onClick={toggleArchive}
                  className="font-semibold cursor-pointer pr-14"
                  isActive={matchSubPath(pathname, "/archive")}
                >
                  {expandedArchive ? (
                    <FolderOpenIcon className="size-4" />
                  ) : (
                    <FolderSearchIcon className="size-4" />
                  )}
                  <span>{t("Archive.title")}</span>
                </SidebarMenuButton>
                <button
                  type="button"
                  aria-label={t("Archive.addArchive")}
                  className="text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground absolute top-1.5 right-7 flex aspect-square w-5 cursor-pointer items-center justify-center rounded-md p-0 outline-hidden transition-all duration-150 focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0 group-hover/archive:opacity-100 opacity-0"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setAddArchiveDialogOpen(true);
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PlusIcon className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent side="right" align="center">
                      {t("Archive.addArchive")}
                    </TooltipContent>
                  </Tooltip>
                </button>
                <SidebarMenuAction
                  aria-label="Toggle Archive Submenu"
                  data-testid="archive-sidebar-dropdown-button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleArchive();
                  }}
                >
                  <ChevronRight
                    className={cn(
                      "size-4 transition-transform duration-200 text-muted-foreground",
                      expandedArchive && "rotate-90",
                    )}
                  />
                </SidebarMenuAction>
              </SidebarMenuItem>
            </Tooltip>
            {expandedArchive && (
              <div className="animate-in fade-in-0 slide-in-from-top-1 duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]">
                <SidebarMenuSub>
                  {isLoadingArchives ? (
                    <div className="gap-2 flex flex-col">
                      {Array.from({ length: 2 }).map((_, index) => (
                        <Skeleton key={index} className="h-6 w-full" />
                      ))}
                    </div>
                  ) : archives!.length === 0 ? (
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton className="text-muted-foreground">
                        {t("Archive.noArchives")}
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ) : (
                    archives!.map((archive) => (
                      <SidebarMenuSubItem
                        onClick={() => {
                          router.push(
                            agentScopedPath(
                              agentScope,
                              `/archive?id=${archive.id}`,
                            ),
                          );
                        }}
                        key={archive.id}
                        className="cursor-pointer"
                      >
                        <SidebarMenuSubButton
                          isActive={
                            matchSubPath(pathname, "/archive") &&
                            currentArchiveId === archive.id
                          }
                        >
                          {archive.name}
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))
                  )}
                </SidebarMenuSub>
              </div>
            )}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
      <ArchiveDialog
        open={addArchiveDialogOpen}
        onOpenChange={setAddArchiveDialogOpen}
      />
    </SidebarGroup>
  );
}
