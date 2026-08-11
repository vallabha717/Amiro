"use client";

import { useTranslations } from "next-intl";
import { EditShareableLoading } from "@/components/edit-shareable-loading";

export default function AgentLoading() {
  const t = useTranslations();

  return (
    <EditShareableLoading
      title={t("Common.editAgent")}
      showGenerateButton={true}
    />
  );
}
