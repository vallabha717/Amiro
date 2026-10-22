"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  Bell,
  BellRing,
  CheckCircle2,
  Loader2,
  Monitor,
  Send,
  Volume2,
  Wifi,
  XCircle,
} from "lucide-react";

import { Button } from "ui/button";
import { Badge } from "ui/badge";
import { Switch } from "ui/switch";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { ScrollArea } from "ui/scroll-area";
import { cn } from "lib/utils";
import { toast } from "sonner";
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
import { ChannelDeliveryStatus } from "@/components/notifications/channel-delivery-status";

function StatusBadge({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  return (
    <Badge
      variant={active ? "outline" : "secondary"}
      className={cn(
        "text-[10px] px-1.5 gap-1",
        active && "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
      )}
    >
      {active ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
      {label}
    </Badge>
  );
}

interface ToggleRowProps {
  id: string;
  testId?: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  loading?: boolean;
}

function ToggleRow({
  id,
  testId,
  label,
  description,
  checked,
  onCheckedChange,
  loading = false,
}: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5 max-w-xl">
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <Switch
          id={id}
          data-testid={testId ?? id}
          aria-label={label}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={loading}
        />
      </div>
    </div>
  );
}

export default function AdminNotificationsPage() {
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<NotificationSettings>(
    DEFAULT_NOTIFICATION_SETTINGS,
  );
  const [browserPermission, setBrowserPermission] = useState<string>("default");
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

  const handleToggle = async (
    key: keyof NotificationSettings,
    value: boolean,
  ) => {
    const next = { ...settings, [key]: value };
    // Synchronize aliases
    if (key === "enabled") next.notificationsEnabled = value;
    if (key === "allAlertsEnabled") next.allAlertsBannerMode = value;
    if (key === "scheduleAlerts") next.scheduleRunAndReminderAlerts = value;
    if (key === "soundEnabled") next.notificationSoundChime = value;
    if (key === "desktopBannerEnabled") next.desktopNativeOsBanners = value;

    setSettings(next);
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      const updated = await updateNotificationSettings({ [key]: value });
      setSettings(updated);
      await mutate(updated, { revalidate: false });
      toast.success(`${key} updated`);
    } catch {
      toast.error(`Failed to update ${key}`);
      setSettings(settings);
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const handleQuietTimeChange = async (
    key: "quietStart" | "quietEnd",
    value: string,
  ) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    try {
      const updated = await updateNotificationSettings({ [key]: value });
      setSettings(updated);
      await mutate(updated, { revalidate: false });
    } catch {
      setSettings(settings);
    }
  };

  const handleEnableBrowser = async () => {
    const result = await requestBrowserNotificationPermission();
    setBrowserPermission(result);
    if (result === "granted") {
      toast.success("Browser notifications enabled");
    } else if (result === "denied") {
      toast.error("Browser notifications were blocked");
    }
  };

  const handleSendTest = async () => {
    setSendingTest(true);
    try {
      const { item } = await sendTestNotification();
      const payload = notificationToDeliveryPayload(item);
      showInAppToast(payload);
      toast.success("Test notification fired successfully!");
    } catch {
      toast.error("Failed to send test notification");
    } finally {
      setSendingTest(false);
    }
  };

  const permissionLabel = useMemo(() => {
    switch (browserPermission) {
      case "granted":
        return "Granted";
      case "denied":
        return "Denied";
      case "prompt":
      case "default":
        return "Prompt";
      default:
        return "Unsupported";
    }
  }, [browserPermission]);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-8">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="max-w-3xl mx-auto px-8 py-8 flex flex-col gap-8">
        {/* Page header */}
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            Configure how and where Amiro alerts you across Web and Desktop.
          </p>
        </div>

        {/* Active summary banner */}
        <Card
          data-testid="notifications-active-summary"
          className="border border-border/80 bg-card/60 shadow-xs"
        >
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <BellRing className="size-4 text-primary" />
                  Active Notification Delivery Summary
                </CardTitle>
                <CardDescription className="text-xs">
                  Current Web, Desktop, Sound, and SSE stream status.
                </CardDescription>
              </div>
              <Button
                size="sm"
                onClick={handleSendTest}
                disabled={sendingTest}
                data-testid="admin-send-test-notification"
              >
                {sendingTest ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Send className="size-3.5 mr-1.5" />
                )}
                Send Test Notification
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <Bell className="size-3.5 text-primary" />
                    Browser Web Notification
                  </span>
                  <StatusBadge
                    active={browserPermission === "granted"}
                    label={permissionLabel}
                  />
                </div>
                <p className="text-muted-foreground">
                  {browserPermission === "granted"
                    ? "OS banners are enabled for this browser."
                    : browserPermission === "denied"
                      ? "Notifications are blocked in this browser."
                      : "Browser permission has not been granted yet."}
                </p>
                {browserPermission !== "granted" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs w-full"
                    onClick={handleEnableBrowser}
                    disabled={browserPermission === "unsupported"}
                    data-testid="admin-enable-browser-notifications"
                  >
                    Enable Browser Notifications
                  </Button>
                )}
              </div>

              <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <Monitor className="size-3.5 text-primary" />
                    Desktop Native Bridge
                  </span>
                  <StatusBadge active={desktop} label={desktop ? "Active" : "Inactive"} />
                </div>
                <p className="text-muted-foreground">
                  {desktop
                    ? "Running inside Amiro Desktop; native OS bridge active."
                    : "Desktop native bridge ready when opened inside Tauri app."}
                </p>
              </div>

              <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <Volume2 className="size-3.5 text-primary" />
                    Sound Chime
                  </span>
                  <StatusBadge
                    active={settings.soundEnabled}
                    label={settings.soundEnabled ? "On" : "Off"}
                  />
                </div>
                <p className="text-muted-foreground">
                  {settings.soundEnabled
                    ? "A subtle harmonic chime plays with alerts."
                    : "Sound alerts are muted."}
                </p>
              </div>

              <div className="flex flex-col justify-between rounded-lg border bg-muted/30 p-3.5 text-xs gap-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-foreground flex items-center gap-1.5">
                    <Wifi className="size-3.5 text-primary" />
                    Live SSE Stream
                  </span>
                  <StatusBadge active={settings.enabled} label={settings.enabled ? "Live" : "Paused"} />
                </div>
                <p className="text-muted-foreground">
                  {settings.enabled
                    ? "Connected to real-time notification stream."
                    : "Notifications master switch is off."}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Settings toggles */}
        <Card data-testid="notifications-settings-card" className="border shadow-xs">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">Notification Preferences</CardTitle>
            <CardDescription>
              Choose which events notify you and how they are delivered.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <ToggleRow
              id="notifications-enabled"
              testId="toggle-enabled"
              label="Master Notifications Enabled"
              description="Turn all Amiro notifications on or off across feed and delivery."
              checked={settings.enabled}
              onCheckedChange={(v) => handleToggle("enabled", v)}
              loading={saving.enabled}
            />

            <ToggleRow
              id="all-alerts-banner"
              testId="toggle-allAlertsEnabled"
              label="All Alerts Banner Mode"
              description="Show browser OS banners for every notification, not just chat replies."
              checked={settings.allAlertsEnabled}
              onCheckedChange={(v) => handleToggle("allAlertsEnabled", v)}
              loading={saving.allAlertsEnabled}
            />

            <ToggleRow
              id="chat-reply-alerts"
              testId="toggle-chatReplyAlerts"
              label="Chat Reply Completion Alerts"
              description="Notify when a background chat turn completes while the window is unfocused."
              checked={settings.chatReplyAlerts}
              onCheckedChange={(v) => handleToggle("chatReplyAlerts", v)}
              loading={saving.chatReplyAlerts}
            />

            <ToggleRow
              id="schedule-alerts"
              testId="toggle-scheduleAlerts"
              label="Scheduled Run & Reminder Alerts"
              description="Notify when scheduled automations finish or cron reminders fire."
              checked={settings.scheduleAlerts}
              onCheckedChange={(v) => handleToggle("scheduleAlerts", v)}
              loading={saving.scheduleAlerts}
            />

            <ToggleRow
              id="heartbeat-alerts"
              testId="toggle-heartbeatAlerts"
              label="Heartbeat Alerts"
              description="Notify on background agent heartbeat and system pulse events."
              checked={settings.heartbeatAlerts}
              onCheckedChange={(v) => handleToggle("heartbeatAlerts", v)}
              loading={saving.heartbeatAlerts}
            />

            <ToggleRow
              id="sound-chime"
              testId="toggle-soundEnabled"
              label="Notification Sound Chime"
              description="Play a pleasant Web Audio API chime with delivered notifications."
              checked={settings.soundEnabled}
              onCheckedChange={(v) => handleToggle("soundEnabled", v)}
              loading={saving.soundEnabled}
            />

            <ToggleRow
              id="desktop-banner"
              testId="toggle-desktopBannerEnabled"
              label="Desktop Native OS Banners"
              description="Deliver notifications via native desktop bridge when running in Amiro Desktop."
              checked={settings.desktopBannerEnabled}
              onCheckedChange={(v) => handleToggle("desktopBannerEnabled", v)}
              loading={saving.desktopBannerEnabled}
            />

            <ToggleRow
              id="web-push"
              testId="toggle-webPushEnabled"
              label="Web Browser Notifications"
              description="Deliver system notifications via the Web Notification API in supported browsers."
              checked={settings.webPushEnabled}
              onCheckedChange={(v) => handleToggle("webPushEnabled", v)}
              loading={saving.webPushEnabled}
            />

            <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
              <ToggleRow
                id="quiet-hours"
                testId="toggle-quietHoursEnabled"
                label="Quiet Hours"
                description="Suppress sounds and OS banners during the configured quiet time window."
                checked={settings.quietHoursEnabled}
                onCheckedChange={(v) => handleToggle("quietHoursEnabled", v)}
                loading={saving.quietHoursEnabled}
              />
              {settings.quietHoursEnabled && (
                <div className="grid grid-cols-2 gap-4 pl-1">
                  <div className="space-y-1.5">
                    <Label htmlFor="quiet-start" className="text-xs">
                      Start
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
                      End
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
              )}
            </div>
          </CardContent>
        </Card>

        {/* Where notifications go outside Amiro: bots from Channels, the
            owner's verified accounts from Contacts. */}
        <ChannelDeliveryStatus />
      </div>
    </ScrollArea>
  );
}
