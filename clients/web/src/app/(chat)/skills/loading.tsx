"use client";

import { Skeleton } from "ui/skeleton";
import { Card, CardDescription, CardHeader, CardTitle } from "ui/card";
import { BackgroundPaths } from "ui/background-paths";
import { useTranslations } from "next-intl";

export default function SkillsLoading() {
  const t = useTranslations();

  return (
    <div className="w-full flex flex-col gap-4 p-8">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">{t("Layout.skills")}</h1>
        <Skeleton className="h-10 w-32" />
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t("Skill.mySkills")}</h2>
          <div className="flex-1 h-px bg-border" />
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card className="relative bg-secondary overflow-hidden h-[196px]">
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
                <Skeleton className="h-10 w-20" />
              </div>
            </CardHeader>
          </Card>

          {Array(5)
            .fill(null)
            .map((_, i) => (
              <Skeleton key={i} className="min-h-[196px]" />
            ))}
        </div>
      </div>

      <div className="flex flex-col gap-4 mt-8">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t("Skill.discovered")}</h2>
          <div className="flex-1 h-px bg-border" />
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array(6)
            .fill(null)
            .map((_, i) => (
              <Skeleton key={i} className="min-h-[196px]" />
            ))}
        </div>
      </div>
    </div>
  );
}
