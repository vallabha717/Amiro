"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  Bell,
  BellRing,
  CalendarClock,
  HeartPulse,
  Loader2,
  MessageSquare,
  Moon,
  Monitor,
  Send,
  Volume2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "ui/button";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { ScrollArea } from "ui/scroll-area";
import { Switch } from "ui/switch";
import { cn } from "lib/utils";
import {
  type NotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
  fetchNotificationSettings,
  updateNotificationSettings,
  sendTestNotification,
  NOTIFICATION_SETTINGS_KEY,
} from "@/lib/notifications/notification-types";
import {
  checkBrowserPermission,
  requestBrowserNotificationPermission,
  isTauriDesktop,
  showInAppToast,
  notificationToDeliveryPayload,
  useNotificationStream,
} from "@/lib/notifications/notification-runtime";
import { ChannelDeliveryStatus } from "./channel-delivery-status";

type ToggleKey = keyof NotificationSettings;

interface TileProps {
  id: string;
  testId: string;
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  saving?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  footer?: ReactNode;
}

/** A card that is the switch: the whole tile reads as on/off at a glance. */
function SettingTile({
  id,
  testId,
  icon,
  title,
  description,
  checked,
  saving,
  disabled,
  onChange,
  footer,
}: TileProps) {
  return (
    <div
      data-checked={checked}
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4 transition-colors",
        checked && !disabled
          ? "border-primary/40 bg-primary/5"
          : "border-border/70 bg-card/40",
        disabled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            checked && !disabled
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground",
          )}
          aria-hidden
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <Label htmlFor={id} className="cursor-pointer text-sm font-semibold">
            {title}
          </Label>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : null}
          <Switch
            id={id}
            data-testid={testId}
            aria-label={title}
            checked={checked}
            onCheckedChange={onChange}
            disabled={disabled || saving}
          />
        </div>
      </div>
      {footer}
    </div>
  );
}

const toMinutes = (value: string) => {
  const [h = "0", m = "0"] = value.split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
};

/** The quiet window drawn over a 24h bar; wraps past midnight when needed. */
function QuietTimeline({ start, end }: { start: string; end: string }) {
  const s = (toMinutes(start) / 1440) * 100;
  const e = (toMinutes(end) / 1440) * 100;
  const segments = s <= e ? [[s, e]] : [[s, 100], [0, e]];
  return (
    <div aria-hidden className="space-y-1.5">
      <div className="relative h-3 overflow-hidden rounded-full bg-muted">
        {segments.map(([from, to]) => (
          <div
            key={`${from}-${to}`}
            className="absolute inset-y-0 rounded-full bg-indigo-500/70"
            style={{ left: `${from}%`, width: `${Math.max(to - from, 1)}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        {["00", "06", "12", "18", "24"].map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * Admin → Notifications: a live hero with the master switch and test button,
 * then "what pings you", "how it reaches you" and a quiet-hours timeline.
 */
export function NotificationsAdmin() {
  const t = useTranslations("NotificationsPage");
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<NotificationSettings>(
    DEFAULT_NOTIFICATION_SETTINGS,
  );
  const [browserPermission, setBrowserPermission] = useState("default");
  const [sendingTest, setSendingTest] = useState(false);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  useNotificationStream();

  const { data: serverSettings, mutate } = useSWR<NotificationSettings>(
    NOTIFICATION_SETTINGS_KEY,
    fetchNotificationSettings,
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    setBrowserPermission(checkBrowserPermission());
  }, []);

  useEffect(() => {
    if (serverSettings) {
      setSettings(serverSettings);
      setLoading(false);
    }
  }, [serverSettings]);

  const desktop = useMemo(() => isTauriDesktop(), []);

  const handleToggle = async (key: ToggleKey, value: boolean) => {
    const next = { ...settings, [key]: value };
    // Keep the legacy alias fields in step with their primary keys.
    if (key === "enabled") next.notificationsEnabled = value;
    if (key === "allAlertsEnabled") next.allAlertsBannerMode = value;
    if (key === "scheduleAlerts") next.scheduleRunAndReminderAlerts = value;
    if (key === "soundEnabled") next.notificationSoundChime = value;
    if (key === "desktopBannerEnabled") next.desktopNativeOsBanners = value;

    const previous = settings;
    setSettings(next);
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      const updated = await updateNotificationSettings({ [key]: value });
      setSettings(updated);
      await mutate(updated, { revalidate: false });
      toast.success(t("saved"));
    } catch {
      toast.error(t("saveFailed"));
      setSettings(previous);
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const handleQuietTimeChange = async (
    key: "quietStart" | "quietEnd",
    value: string,
  ) => {
    const previous = settings;
    setSettings({ ...settings, [key]: value });
    try {
      const updated = await updateNotificationSettings({ [key]: value });
      setSettings(updated);
      await mutate(updated, { revalidate: false });
    } catch {
      setSettings(previous);
    }
  };

  const handleEnableBrowser = async () => {
    const result = await requestBrowserNotificationPermission();
    setBrowserPermission(result);
    if (result === "granted") toast.success(t("browserEnabled"));
    else if (result === "denied") toast.error(t("browserBlocked"));
  };

  const handleSendTest = async () => {
    setSendingTest(true);
    try {
      const { item } = await sendTestNotification();
      showInAppToast(notificationToDeliveryPayload(item));
      toast.success(t("testSent"));
    } catch {
      toast.error(t("testFailed"));
    } finally {
      setSendingTest(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const live = settings.enabled;
  const channels = [
    settings.webPushEnabled && browserPermission === "granted",
    settings.desktopBannerEnabled && desktop,
    settings.soundEnabled,
  ].filter(Boolean).length;

  const tile = (
    key: ToggleKey,
    testId: string,
    icon: ReactNode,
    title: string,
    description: string,
    extra: Partial<TileProps> = {},
  ) => (
    <SettingTile
      id={`notif-${key}`}
      testId={testId}
      icon={icon}
      title={title}
      description={description}
      checked={Boolean(settings[key])}
      saving={saving[key]}
      disabled={!live}
      onChange={(v) => handleToggle(key, v)}
      {...extra}
    />
  );

  return (
    <ScrollArea className="h-full w-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8">
        <header>
          <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </header>

        <section
          data-testid="notifications-active-summary"
          data-live={live}
          className={cn(
            "relative overflow-hidden rounded-2xl border p-6",
            live
              ? "border-primary/30 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent"
              : "border-border/70 bg-muted/30",
          )}
        >
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className="relative flex size-16 shrink-0 items-center justify-center">
              {live ? (
                <>
                  <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
                  <span className="absolute inset-2 rounded-full bg-primary/20" />
                </>
              ) : null}
              <div
                className={cn(
                  "relative flex size-12 items-center justify-center rounded-full",
                  live
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {live ? (
                  <BellRing className="size-6" aria-hidden />
                ) : (
                  <Bell className="size-6" aria-hidden />
                )}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">
                {live ? t("heroOn") : t("heroOff")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {live ? t("heroOnHint", { count: channels }) : t("heroOffHint")}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="notifications-enabled"
                data-testid="toggle-enabled"
                aria-label={t("master")}
                checked={settings.enabled}
                onCheckedChange={(v) => handleToggle("enabled", v)}
                disabled={saving.enabled}
              />
              <Button
                size="sm"
                onClick={handleSendTest}
                disabled={sendingTest || !live}
                data-testid="admin-send-test-notification"
              >
                {sendingTest ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Send className="mr-1.5 size-3.5" />
                )}
                {t("sendTest")}
              </Button>
            </div>
          </div>
        </section>

        <section aria-labelledby="notif-events" className="space-y-3">
          <div>
            <h2 id="notif-events" className="text-base font-semibold">
              {t("eventsTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("eventsHint")}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {tile(
              "chatReplyAlerts",
              "toggle-chatReplyAlerts",
              <MessageSquare className="size-4" />,
              t("evChat"),
              t("evChatHint"),
            )}
            {tile(
              "scheduleAlerts",
              "toggle-scheduleAlerts",
              <CalendarClock className="size-4" />,
              t("evSchedules"),
              t("evSchedulesHint"),
            )}
            {tile(
              "heartbeatAlerts",
              "toggle-heartbeatAlerts",
              <HeartPulse className="size-4" />,
              t("evHeartbeat"),
              t("evHeartbeatHint"),
            )}
            {tile(
              "allAlertsEnabled",
              "toggle-allAlertsEnabled",
              <BellRing className="size-4" />,
              t("evAll"),
              t("evAllHint"),
            )}
          </div>
        </section>

        <section aria-labelledby="notif-delivery" className="space-y-3">
          <div>
            <h2 id="notif-delivery" className="text-base font-semibold">
              {t("deliveryTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("deliveryHint")}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {tile(
              "webPushEnabled",
              "toggle-webPushEnabled",
              <Bell className="size-4" />,
              t("dlWeb"),
              browserPermission === "granted"
                ? t("dlWebGranted")
                : browserPermission === "denied"
                  ? t("dlWebDenied")
                  : t("dlWebAsk"),
              {
                footer:
                  browserPermission !== "granted" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 w-full text-xs"
                      onClick={handleEnableBrowser}
                      disabled={browserPermission === "unsupported"}
                      data-testid="admin-enable-browser-notifications"
                    >
                      {t("enableBrowser")}
                    </Button>
                  ) : undefined,
              },
            )}
            {tile(
              "desktopBannerEnabled",
              "toggle-desktopBannerEnabled",
              <Monitor className="size-4" />,
              t("dlDesktop"),
              desktop ? t("dlDesktopActive") : t("dlDesktopIdle"),
            )}
            {tile(
              "soundEnabled",
              "toggle-soundEnabled",
              <Volume2 className="size-4" />,
              t("dlSound"),
              t("dlSoundHint"),
            )}
          </div>
        </section>

        <section
          aria-labelledby="notif-quiet"
          className="space-y-4 rounded-xl border border-border/70 bg-card/40 p-4"
        >
          <div className="flex items-start gap-3">
            <div
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-500"
              aria-hidden
            >
              <Moon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <Label
                id="notif-quiet"
                htmlFor="quiet-hours"
                className="cursor-pointer text-sm font-semibold"
              >
                {t("quietTitle")}
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {settings.quietHoursEnabled
                  ? t("quietSpan", {
                      start: settings.quietStart,
                      end: settings.quietEnd,
                    })
                  : t("quietHint")}
              </p>
            </div>
            <Switch
              id="quiet-hours"
              data-testid="toggle-quietHoursEnabled"
              aria-label={t("quietTitle")}
              checked={settings.quietHoursEnabled}
              onCheckedChange={(v) => handleToggle("quietHoursEnabled", v)}
              disabled={!live || saving.quietHoursEnabled}
            />
          </div>
          {settings.quietHoursEnabled ? (
            <>
              <QuietTimeline
                start={settings.quietStart}
                end={settings.quietEnd}
              />
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="quiet-start" className="text-xs">
                    {t("quietStart")}
                  </Label>
                  <Input
                    id="quiet-start"
                    type="time"
                    value={settings.quietStart}
                    onChange={(e) =>
                      handleQuietTimeChange("quietStart", e.target.value)
                    }
                    data-testid="admin-quiet-start"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="quiet-end" className="text-xs">
                    {t("quietEnd")}
                  </Label>
                  <Input
                    id="quiet-end"
                    type="time"
                    value={settings.quietEnd}
                    onChange={(e) =>
                      handleQuietTimeChange("quietEnd", e.target.value)
                    }
                    data-testid="admin-quiet-end"
                  />
                </div>
              </div>
            </>
          ) : null}
        </section>

        {/* Where notifications go outside Amiro: bots from Channels, the
            owner's verified accounts from Contacts. */}
        <ChannelDeliveryStatus />
      </div>
    </ScrollArea>
  );
}
