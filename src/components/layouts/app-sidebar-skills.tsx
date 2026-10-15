// Renders the Agent sidebar section: the Agent hub link, habitat, and quick-jump pills.
"use client";

import { appStore } from "@/app/store";
import { AgentSidebarHabitat } from "@/components/agent/agent-sidebar-habitat";
import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import { useSkills } from "@/hooks/queries/use-skills";
import { DEFAULT_CHARACTER_TRAITS } from "@/lib/agent/character-catalog";
import { cn } from "lib/utils";
import { Brain, FolderOpen, Sparkles, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "ui/sidebar";

export function AppSidebarSkills() {
  const pathname = usePathname();

  const projectDirectory = appStore((state) => state.projectDirectory);
  const { data } = useSkills({ projectDirectory });
  const { data: identity } = useAgentIdentity();

  const allSkills = useMemo(() => data?.items ?? [], [data]);
  const accentHex = identity?.accentHex || "#E9642F";
  const agentName = identity?.name || "Amiro";
  const traits = identity?.traits ?? DEFAULT_CHARACTER_TRAITS;
  const memoryTotal = identity?.memoryStats?.total ?? 0;

  return (
    <SidebarGroup
      style={{
        fontFamily:
          "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <SidebarGroupContent className="group-data-[collapsible=icon]:hidden group/skills">
        <SidebarMenu className="group/skills" data-testid="skills-sidebar-menu">
          {/* Main Agent Hub Link (replaces Skills header) */}
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === "/agent"}
              className="h-auto py-2 font-semibold"
            >
              <Link
                href="/agent"
                data-testid="sidebar-agent-link"
                className="flex items-center gap-2.5"
              >
                <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full">
                  <AgentCharacterAvatar
                    traits={traits}
                    customImageUrl={identity?.customImageUrl}
                    size={22}
                  />
                </span>
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span
                    data-testid="sidebar-agent-name"
                    className="truncate text-sm font-semibold"
                  >
                    {agentName}
                  </span>
                  <span className="truncate text-[10px] font-normal text-muted-foreground">
                    Personality, Memory & Superpowers
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <AgentSidebarHabitat
            name={agentName}
            traits={traits}
            customImageUrl={identity?.customImageUrl}
            accent={accentHex}
          />

          {/* Compact Quick-Jump Pills: Personality · Superpowers · Memory · Workspace */}
          <div className="mt-1 grid grid-cols-2 gap-1 px-2">
            <Link
              href="/agent/personality"
              data-testid="sidebar-agent-personality-link"
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors",
                pathname.startsWith("/agent/personality")
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border/50 bg-input/25 text-muted-foreground hover:bg-input/60 hover:text-foreground",
              )}
            >
              <Sparkles
                className="size-3 shrink-0"
                style={{ color: accentHex }}
                aria-hidden="true"
              />
              <span className="truncate">Personality</span>
            </Link>

            <Link
              href="/agent/superpowers"
              data-testid="skills-link"
              className={cn(
                "flex items-center justify-between gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors",
                pathname.startsWith("/agent/superpowers") ||
                  pathname.startsWith("/skills")
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border/50 bg-input/25 text-muted-foreground hover:bg-input/60 hover:text-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Zap
                  className="size-3 shrink-0"
                  style={{ color: accentHex }}
                  aria-hidden="true"
                />
                <span className="truncate">Superpowers</span>
              </span>
              <span className="font-mono text-[10px] opacity-75 tabular-nums">
                {allSkills.length}
              </span>
            </Link>

            <Link
              href="/agent/memory"
              data-testid="sidebar-agent-memory-link"
              className={cn(
                "flex items-center justify-between gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors",
                pathname.startsWith("/agent/memory")
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border/50 bg-input/25 text-muted-foreground hover:bg-input/60 hover:text-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Brain
                  className="size-3 shrink-0"
                  style={{ color: accentHex }}
                  aria-hidden="true"
                />
                <span className="truncate">Memory</span>
              </span>
              <span className="font-mono text-[10px] opacity-75 tabular-nums">
                {memoryTotal}
              </span>
            </Link>

            <Link
              href="/agent/workspace"
              data-testid="sidebar-agent-workspace-link"
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors",
                pathname.startsWith("/agent/workspace")
                  ? "border-foreground/30 bg-accent text-foreground"
                  : "border-border/50 bg-input/25 text-muted-foreground hover:bg-input/60 hover:text-foreground",
              )}
            >
              <FolderOpen
                className="size-3 shrink-0"
                style={{ color: accentHex }}
                aria-hidden="true"
              />
              <span className="truncate">Workspace</span>
            </Link>
          </div>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
