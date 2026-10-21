"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  fetchNotificationSettings,
  updateNotificationSettings,
  NOTIFICATION_SETTINGS_KEY,
  type NotificationSettings,
} from "@/lib/notifications/notification-types";
import { ChannelConnectCards } from "./channel-connect-cards";

type ToggleKey =
  | "enabled"
  | "chatReplyAlerts"
  | "scheduleAlerts"
  | "heartbeatAlerts"
  | "soundEnabled"
  | "desktopBannerEnabled"
  | "webPushEnabled"
  | "quietHoursEnabled";

const TOGGLES: { key: ToggleKey; label: string; description: string }[] = [
  { key: "enabled", label: "master", description: "masterDescription" },
  { key: "chatReplyAlerts", label: "chatReplies", description: "chatRepliesDescription" },
  { key: "scheduleAlerts", label: "scheduleAlerts", description: "scheduleAlertsDescription" },
  { key: "heartbeatAlerts", label: "heartbeatAlerts", description: "heartbeatAlertsDescription" },
  { key: "soundEnabled", label: "sound", description: "soundDescription" },
  { key: "desktopBannerEnabled", label: "desktopBanners", description: "desktopBannersDescription" },
  { key: "webPushEnabled", label: "webPush", description: "webPushDescription" },
];

export function NotificationsSettings() {
  const t = useTranslations("Notifications.Settings");
  const [settings, setSettings] = useState<NotificationSettings>(
    DEFAULT_NOTIFICATION_SETTINGS,
  );
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const { data: serverSettings, mutate } = useSWR<NotificationSettings>(
    NOTIFICATION_SETTINGS_KEY,
    fetchNotificationSettings,
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    if (serverSettings) setSettings(serverSettings);
  }, [serverSettings]);

  const handleToggle = async (key: ToggleKey, value: boolean) => {
    const prev = settings;
    setSettings({ ...prev, [key]: value });
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      const updated = await updateNotificationSettings({ [key]: value });
      setSettings(updated);
      await mutate(updated, { revalidate: false });
      toast.success(t("saved"));
    } catch {
      setSettings(prev);
      toast.error(t("saveFailed"));
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const handleQuietTime = async (key: "quietStart" | "quietEnd", value: string) => {
    if (!value) return;
    const prev = settings;
    setSettings({ ...prev, [key]: value });
    try {
      const updated = await updateNotificationSettings({ [key]: value });
      setSettings(updated);
      await mutate(updated, { revalidate: false });
    } catch {
      setSettings(prev);
      toast.error(t("saveFailed"));
    }
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div
        data-testid="notifications-settings"
        className="flex flex-col gap-4 p-4"
      >
        <div className="space-y-0.5">
          <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>

        <div className="flex flex-col gap-4">
          {TOGGLES.map(({ key, label, description }) => (
            <div
              key={key}
              className="flex items-center justify-between gap-4"
            >
              <div className="space-y-0.5">
                <Label
                  htmlFor={`bell-settings-${key}`}
                  className="cursor-pointer text-xs font-medium"
                >
                  {t(label)}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {t(description)}
                </p>
              </div>
              <span className="flex items-center gap-2">
                {saving[key] && (
                  <Loader2
                    className="size-3.5 animate-spin text-muted-foreground"
                    aria-hidden
                  />
                )}
                <Switch
                  id={`bell-settings-${key}`}
                  data-testid={`notifications-settings-${key}`}
                  aria-label={t(label)}
                  checked={Boolean(settings[key])}
                  onCheckedChange={(v) => handleToggle(key, v)}
                  disabled={Boolean(saving[key])}
                />
              </span>
            </div>
          ))}

          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label
                  htmlFor="bell-settings-quietHoursEnabled"
                  className="cursor-pointer text-xs font-medium"
                >
                  {t("quietHours")}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {t("quietHoursDescription")}
                </p>
              </div>
              <Switch
                id="bell-settings-quietHoursEnabled"
                data-testid="notifications-settings-quietHoursEnabled"
                aria-label={t("quietHours")}
                checked={settings.quietHoursEnabled}
                onCheckedChange={(v) => handleToggle("quietHoursEnabled", v)}
                disabled={Boolean(saving.quietHoursEnabled)}
              />
            </div>
            {settings.quietHoursEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="bell-quiet-start"
                    className="text-[11px]"
                  >
                    {t("quietStart")}
                  </Label>
                  <Input
                    id="bell-quiet-start"
                    type="time"
                    value={settings.quietStart}
                    onChange={(e) =>
                      handleQuietTime("quietStart", e.target.value)
                    }
                    data-testid="notifications-quiet-start"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bell-quiet-end" className="text-[11px]">
                    {t("quietEnd")}
                  </Label>
                  <Input
                    id="bell-quiet-end"
                    type="time"
                    value={settings.quietEnd}
                    onChange={(e) =>
                      handleQuietTime("quietEnd", e.target.value)
                    }
                    data-testid="notifications-quiet-end"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <ChannelConnectCards />
      </div>
    </ScrollArea>
  );
}
