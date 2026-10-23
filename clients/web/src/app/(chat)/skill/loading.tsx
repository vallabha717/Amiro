"use client";

import { useTranslations } from "next-intl";
import { EditShareableLoading } from "@/components/edit-shareable-loading";

export default function SkillLoading() {
  const t = useTranslations();

  return (
    <EditShareableLoading title={t("Skill.title")} showGenerateButton={true} />
  );
}
