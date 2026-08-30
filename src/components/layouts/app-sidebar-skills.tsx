"use client";

import { SidebarMenuAction } from "ui/sidebar";
import Link from "next/link";
import { SidebarMenuButton, SidebarMenuSkeleton } from "ui/sidebar";
import { SidebarGroupContent, SidebarMenu, SidebarMenuItem } from "ui/sidebar";
import { SidebarGroup } from "ui/sidebar";
import {
  ArrowUpRightIcon,
  ChevronDown,
  ChevronUp,
  PlusIcon,
  Sparkles,
} from "lucide-react";

import { useMounted } from "@/hooks/use-mounted";

import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";

import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { useSkills } from "@/hooks/queries/use-skills";

import { appStore } from "@/app/store";
import { useRouter } from "next/navigation";
import { ChatMention } from "app-types/chat";
import { cn } from "lib/utils";

const DISPLAY_LIMIT = 5;

export function AppSidebarSkills() {
  const mounted = useMounted();
  const t = useTranslations();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const projectDirectory = appStore((state) => state.projectDirectory);
  const { data, isLoading } = useSkills({ projectDirectory });

  const mySkills = useMemo(
    () => (data?.items ?? []).filter((s) => s.writable),
    [data],
  );

  const handleSkillClick = useCallback(
    (name: string) => {
      const currentThreadId = appStore.getState().currentThreadId;
      const skill = mySkills.find((s) => s.name === name);
      if (!skill) return;

      const newMention: ChatMention = {
        type: "skill",
        name: skill.name,
        description: skill.description,
      };

      if (currentThreadId) {
        appStore.setState((prev) => {
          const currentMentions = prev.threadMentions[currentThreadId] || [];
          const target = currentMentions.find(
            (mention) => mention.type === "skill" && mention.name === skill.name,
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
      } else {
        router.push("/");
        appStore.setState(() => ({
          pendingThreadMention: newMention,
        }));
      }
    },
    [mySkills, router],
  );

  return (
    <SidebarGroup>
      <SidebarGroupContent className="group-data-[collapsible=icon]:hidden group/skills">
        <SidebarMenu className="group/skills" data-testid="skills-sidebar-menu">
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="font-semibold">
              <Link href="/skills" data-testid="skills-link">
                {t("Layout.skills")}
              </Link>
            </SidebarMenuButton>
            <SidebarMenuAction
              className="group-hover/skills:opacity-100 opacity-0 transition-opacity"
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

          {isLoading ? (
            <SidebarMenuItem>
              {Array.from({ length: 2 }).map(
                (_, index) => mounted && <SidebarMenuSkeleton key={index} />,
              )}
            </SidebarMenuItem>
          ) : mySkills.length === 0 ? (
            <div className="px-2 mt-1">
              <Link
                href={"/skill?name=new"}
                className="bg-input/40 py-8 px-4 hover:bg-input/100 rounded-lg cursor-pointer flex justify-between items-center text-xs overflow-hidden"
                data-testid="sidebar-create-skill-link"
              >
                <div className="gap-1 z-10">
                  <div className="flex items-center mb-4 gap-1">
                    <p className="font-semibold">{t("Layout.createSkill")}</p>
                    <ArrowUpRightIcon className="size-3" />
                  </div>
                  <p className="text-muted-foreground">
                    {t("Layout.createYourOwnSkill")}
                  </p>
                </div>
              </Link>
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="relative">
                {expanded && (
                  <div className="absolute bottom-0 left-0 right-0 h-4 z-10 pointer-events-none bg-gradient-to-t from-background to-transparent" />
                )}
                <div
                  className={cn(
                    "w-full",
                    expanded && "max-h-[400px] overflow-y-auto",
                  )}
                >
                  {(expanded ? mySkills : mySkills.slice(0, DISPLAY_LIMIT)).map(
                    (skill) => (
                      <SidebarMenu key={skill.name} className="group/skill mr-0 w-full">
                        <SidebarMenuItem
                          className="px-2 cursor-pointer w-full"
                          onClick={() => handleSkillClick(skill.name)}
                        >
                          <SidebarMenuButton
                            asChild
                            className="data-[state=open]:bg-input! w-full"
                          >
                            <div className="flex gap-1 w-full min-w-0">
                              <div className="p-1 rounded-full ring-2 ring-border bg-background flex items-center justify-center">
                                <Sparkles className="size-3.5 text-primary" />
                              </div>
                              <div className="flex items-center min-w-0 w-full">
                                <p className="truncate" data-testid="sidebar-skill-name">
                                  {skill.name}
                                </p>
                              </div>
                            </div>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    ),
                  )}
                </div>
              </div>

              {mySkills.length > DISPLAY_LIMIT && (
                <SidebarMenu className="group/showmore">
                  <SidebarMenuItem className="px-2 cursor-pointer">
                    <SidebarMenuButton
                      onClick={() => setExpanded(!expanded)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <div className="flex items-center gap-1">
                        <p className="text-xs">
                          {expanded ? t("Common.showLess") : t("Common.showMore")}
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
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
