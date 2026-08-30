"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowUpRight, Lock, Plus, Sparkles } from "lucide-react";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "ui/card";
import { BackgroundPaths } from "ui/background-paths";
import { cn } from "lib/utils";
import { appStore } from "@/app/store";
import { useSkills } from "@/hooks/queries/use-skills";
import type { SkillSummary } from "@/types/skill";

export function SkillsList() {
  const t = useTranslations();
  const projectDirectory = appStore((state) => state.projectDirectory);
  const { data, isLoading } = useSkills({ projectDirectory });

  const items = data?.items ?? [];
  const mySkills = items.filter((s) => s.writable);
  const discovered = items.filter((s) => !s.writable);

  return (
    <div className="w-full flex flex-col gap-4 p-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold" data-testid="skills-title">
          {t("Layout.skills")}
        </h1>
        <Link href="/skill?name=new">
          <Button variant="ghost" data-testid="create-skill-button">
            <Plus />
            {t("Skill.newSkill")}
          </Button>
        </Link>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t("Skill.mySkills")}</h2>
          <div className="flex-1 h-px bg-border" />
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Link href="/skill?name=new">
            <Card
              className="relative bg-secondary overflow-hidden cursor-pointer hover:bg-input transition-colors h-[196px]"
              data-testid="create-skill-card"
            >
              <div className="absolute inset-0 w-full h-full opacity-50">
                <BackgroundPaths />
              </div>
              <CardHeader>
                <CardTitle>
                  <h1 className="text-lg font-bold">{t("Skill.newSkill")}</h1>
                </CardTitle>
                <CardDescription className="mt-2">
                  <p>{t("Layout.createYourOwnSkill")}</p>
                </CardDescription>
                <div className="mt-auto ml-auto flex-1">
                  <Button variant="ghost" size="lg">
                    {t("Common.create")}
                    <ArrowUpRight className="size-3.5" />
                  </Button>
                </div>
              </CardHeader>
            </Card>
          </Link>

          {!isLoading &&
            mySkills.map((skill) => <SkillCard key={skill.name} skill={skill} />)}

          {!isLoading && mySkills.length === 0 && (
            <Card className="col-span-full bg-transparent border-none">
              <CardHeader className="text-center py-8">
                <CardTitle>{t("Skill.noSkills")}</CardTitle>
                <CardDescription>{t("Skill.createFirst")}</CardDescription>
              </CardHeader>
            </Card>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 mt-8">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t("Skill.discovered")}</h2>
          <div className="flex-1 h-px bg-border" />
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {!isLoading &&
            discovered.map((skill) => <SkillCard key={skill.name} skill={skill} />)}

          {!isLoading && discovered.length === 0 && (
            <Card className="col-span-full bg-transparent border-none">
              <CardHeader className="text-center py-12">
                <CardTitle>{t("Skill.noDiscoveredSkills")}</CardTitle>
                <CardDescription>
                  {t("Skill.noDiscoveredSkillsDescription")}
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillCard({ skill }: { skill: SkillSummary }) {
  const t = useTranslations();
  return (
    <Link href={`/skill?name=${encodeURIComponent(skill.name)}`} title={skill.name}>
      <Card
        className={cn(
          "w-full min-h-[196px] @container transition-colors group flex flex-col gap-3 cursor-pointer hover:bg-input",
        )}
        data-testid="skill-card"
        data-item-name={skill.name}
      >
        <CardHeader className="shrink gap-y-0">
          <CardTitle className="flex gap-3 items-stretch min-w-0">
            <div className="p-2 rounded-lg flex items-center justify-center ring ring-background border shrink-0 bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate font-semibold">{skill.name}</span>
            </div>
            {!skill.writable && (
              <Lock
                className="size-3.5 text-muted-foreground shrink-0 mt-1"
                data-testid="skill-card-lock"
              />
            )}
          </CardTitle>
          <CardDescription className="mt-2 line-clamp-2">
            {skill.description || t("Skill.noDescription")}
          </CardDescription>
          <div className="mt-auto pt-4 flex items-center gap-2">
            <Badge
              variant="outline"
              data-testid={`skill-card-source-${skill.source}`}
              className="text-[10px] uppercase font-mono px-1.5 py-0 h-4 border-muted-foreground/30 text-muted-foreground"
            >
              {skill.source}
            </Badge>
            <Badge
              variant="outline"
              className="text-[10px] uppercase font-mono px-1.5 py-0 h-4 border-muted-foreground/30 text-muted-foreground"
            >
              {skill.scope}
            </Badge>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}
