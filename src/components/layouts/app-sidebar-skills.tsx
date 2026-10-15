"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Brain,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  PlusIcon,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { useMounted } from "@/hooks/use-mounted";
import { useSkills } from "@/hooks/queries/use-skills";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import { DEFAULT_CHARACTER_TRAITS } from "@/lib/agent/character-catalog";
import { AgentSidebarHabitat } from "@/components/agent/agent-sidebar-habitat";
import { AgentCharacterAvatar } from "@/components/agent/avatar-primitives";
import { appStore } from "@/app/store";
import { ChatMention } from "app-types/chat";
import { cn } from "lib/utils";

const DISPLAY_LIMIT = 4;

export function AppSidebarSkills() {
  const mounted = useMounted();
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);

  const projectDirectory = appStore((state) => state.projectDirectory);
  const { data, isLoading } = useSkills({ projectDirectory });
  const { data: identity } = useAgentIdentity();

  const allSkills = useMemo(() => data?.items ?? [], [data]);
  const accentHex = identity?.accentHex || "#E9642F";
  const agentName = identity?.name || "Amiro";
  const traits = identity?.traits ?? DEFAULT_CHARACTER_TRAITS;
  const memoryTotal = identity?.memoryStats?.total ?? 0;

  const handleSkillClick = useCallback(
    (name: string) => {
      const currentThreadId = appStore.getState().currentThreadId;
      const skill = allSkills.find((s) => s.name === name);
      if (!skill || skill.deliverable === false || skill.disableModelInvocation)
        return;

      const newMention: ChatMention = {
        type: "skill",
        name: skill.name,
        description: skill.description,
      };

      if (currentThreadId) {
        appStore.setState((prev) => {
          const currentMentions = prev.threadMentions[currentThreadId] || [];
          const target = currentMentions.find(
            (mention) =>
              mention.type === "skill" && mention.name === skill.name,
          );
          if (target) return prev;
          return {
            threadMentions: {
              ...prev.threadMentions,
              [currentThreadId]: [
                ...currentMentions.filter(
                  (v) => !(v.type === "skill" && v.name === skill.name),
                ),
                newMention,
              ],
            },
          };
        });
        router.push(`/?thread=${encodeURIComponent(currentThreadId)}`);
      } else {
        router.push("/");
        appStore.setState(() => ({
          pendingThreadMention: newMention,
        }));
      }
    },
    [allSkills, router],
  );

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
            <SidebarMenuAction
              aria-label={t("Skill.newSkill")}
              className="opacity-0 transition-opacity group-hover/skills:opacity-100"
              onClick={() => router.push("/skill?name=new")}
              data-testid="sidebar-create-skill-button"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PlusIcon className="size-4" />
                </TooltipTrigger>
                <TooltipContent side="right" align="center">
                  {t("Skill.newSkill")}
                </TooltipContent>
              </Tooltip>
            </SidebarMenuAction>
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

          {/* Quick-attach Superpowers list */}
          {isLoading ? (
            <SidebarMenuItem>
              {Array.from({ length: 2 }).map(
                (_, index) => mounted && <SidebarMenuSkeleton key={index} />,
              )}
            </SidebarMenuItem>
          ) : (
            allSkills.length > 0 && (
              <div className="mt-1.5 flex flex-col">
                <div className="relative">
                  {expanded && (
                    <div className="pointer-events-none absolute right-0 bottom-0 left-0 z-10 h-4 bg-gradient-to-t from-background to-transparent" />
                  )}
                  <div
                    className={cn(
                      "w-full",
                      expanded && "max-h-[260px] overflow-y-auto",
                    )}
                  >
                    {(expanded
                      ? allSkills
                      : allSkills.slice(0, DISPLAY_LIMIT)
                    ).map((skill) => (
                      <SidebarMenu
                        key={skill.name}
                        className="group/skill mr-0 w-full"
                      >
                        <SidebarMenuItem className="w-full px-2">
                          <SidebarMenuButton
                            onClick={() => handleSkillClick(skill.name)}
                            disabled={
                              skill.deliverable === false ||
                              skill.disableModelInvocation
                            }
                            title={
                              skill.deliverable === false
                                ? skill.invokableReason
                                : `Add /${skill.name} instructions to your next message`
                            }
                            className="w-full data-[state=open]:bg-input!"
                          >
                            <div className="flex w-full min-w-0 items-center gap-1.5">
                              <div className="flex items-center justify-center rounded-full bg-background p-1 ring-1 ring-border">
                                <Sparkles
                                  className="size-3"
                                  style={{ color: accentHex }}
                                />
                              </div>
                              <p
                                className="truncate text-xs"
                                data-testid="sidebar-skill-name"
                              >
                                /{skill.name}
                              </p>
                              <span className="ml-auto font-mono text-[9px] text-muted-foreground uppercase">
                                {skill.source.replace(/^\./, "")}
                              </span>
                            </div>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    ))}
                  </div>
                </div>

                {allSkills.length > DISPLAY_LIMIT && (
                  <SidebarMenu className="group/showmore">
                    <SidebarMenuItem className="cursor-pointer px-2">
                      <SidebarMenuButton
                        onClick={() => setExpanded(!expanded)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <div className="flex items-center gap-1">
                          <p className="text-xs">
                            {expanded
                              ? t("Common.showLess")
                              : t("Common.showMore")}
                          </p>
                          {expanded ? (
                            <ChevronUp className="size-3.5" />
                          ) : (
                            <ChevronDown className="size-3.5" />
                          )}
                        </div>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                )}
              </div>
            )
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
