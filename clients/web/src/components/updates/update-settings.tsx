"use client";

import { Label } from "ui/label";
import { Switch } from "ui/switch";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import {
  saveUpdateSettings,
  type UpdateMethod,
  type UpdateSettings as Settings,
} from "@/lib/backend/update-api";

/** The owner's automatic-update switches. */
export function UpdateSettings({
  settings,
  method,
  onSaved,
}: {
  settings: Settings;
  method: UpdateMethod;
  onSaved: (settings: Settings) => void;
}) {
  const t = useTranslations("Updates");
  const [saving, setSaving] = useState<keyof Settings | null>(null);
  const canAutoInstall = method === "installer";

  const save = async (key: keyof Settings, value: boolean) => {
    setSaving(key);
    try {
      const saved = await saveUpdateSettings({ [key]: value });
      onSaved(saved);
      toast.success(t("settings.saved"));
    } catch (error) {
      toast.error(
        t("settings.saveFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="space-y-3" data-testid="update-settings">
      <h3 className="text-sm font-semibold">{t("settings.title")}</h3>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="update-auto-check">{t("settings.autoCheck")}</Label>
          <p className="text-xs text-muted-foreground">{t("settings.autoCheckHint")}</p>
        </div>
        <Switch
          id="update-auto-check"
          checked={settings.autoCheck}
          disabled={saving !== null}
          onCheckedChange={(value) => void save("autoCheck", value)}
          data-testid="update-auto-check"
        />
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="update-auto-install">{t("settings.autoInstall")}</Label>
          <p className="text-xs text-muted-foreground">
            {canAutoInstall ? t("settings.autoInstallHint") : t("settings.autoInstallUnavailable")}
          </p>
        </div>
        <Switch
          id="update-auto-install"
          checked={canAutoInstall && settings.autoInstall}
          disabled={!canAutoInstall || saving !== null}
          onCheckedChange={(value) => void save("autoInstall", value)}
          data-testid="update-auto-install"
        />
      </div>
    </section>
  );
}
