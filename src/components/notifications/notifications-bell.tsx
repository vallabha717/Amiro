"use client";

import { useMemo, useState, useTransition } from "react";
import { Bell, CheckCheck, ChevronLeft, Laptop, Settings, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NotificationsFeed, type FeedFilter } from "./notifications-feed";
import { NotificationDetail } from "./notification-detail";
import { NotificationsSettings } from "./notifications-settings";
import {
  useNotifications, useNotificationStream, isTauriDesktop,
  checkBrowserPermission, requestBrowserNotificationPermission,
} from "@/lib/notifications/notification-runtime";
import {
  clearAllNotifications, dismissNotification, markAllNotificationsRead,
  markNotificationRead, sendTestNotification, type AmiroNotification,
} from "@/lib/notifications/notification-types";

export function NotificationsBell() {
  const t = useTranslations("Notifications.Bell");
  useNotificationStream();
  const { notifications, unreadCount, isLoading, error, mutate } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"feed" | "settings">("feed");
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [permission, setPermission] = useState<string>(() => checkBrowserPermission());
  const [isPending, startTransition] = useTransition();
  const isDesktop = useMemo(() => isTauriDesktop(), []);
  const visible = useMemo(() => notifications.filter((n) => !n.dismissed), [notifications]);
  const selected = useMemo(
    () => visible.find((n) => n.id === selectedId) ?? null, [visible, selectedId]);
  const showingDetail = selected !== null;
  const showingSettings = !showingDetail && view === "settings";
  const back = () => { setSelectedId(null); setView("feed"); };
  const write = (fn: () => Promise<void>, ok: string) =>
    startTransition(async () => {
      try { await fn(); toast.success(ok); } catch { toast.error(t("actionFailed")); }
      void mutate();
    });
  const markAll = () => write(() => markAllNotificationsRead().then(() => {}), t("markedAllRead"));
  const clearAll = () => write(async () => {
    setSelectedId(null); await clearAllNotifications();
  }, t("clearedAll"));
  const toggleRead = (n: AmiroNotification) =>
    write(() => markNotificationRead(n.id, !n.read), t("updated"));
  const dismiss = (id: string) => write(async () => {
    if (selectedId === id) setSelectedId(null);
    await dismissNotification(id);
  }, t("updated"));
  const sendTest = () => write(() => sendTestNotification().then(() => {}), t("testSent"));
  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" data-testid="notifications-bell"
          aria-label={t("label")} className="relative bg-secondary/40 hover:bg-secondary/70">
          <Bell className="size-4" aria-hidden />
          {unreadCount > 0 && (
            <span data-testid="notifications-unread-badge"
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} data-testid="notifications-bell-popover"
        className="flex max-h-[560px] w-[380px] flex-col overflow-hidden rounded-xl border bg-popover/95 p-0 shadow-xl backdrop-blur-md sm:w-[420px]">
        <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-3">
          <div className="flex items-center gap-2">
            {showingDetail || showingSettings ? (
              <Button variant="ghost" size="sm" onClick={back} data-testid="notifications-back"
                className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground">
                <ChevronLeft className="mr-0.5 size-4" aria-hidden />{t("back")}
              </Button>
            ) : (
              <><h3 className="text-sm font-semibold">{t("label")}</h3>
                <Badge variant="secondary" data-testid="notifications-bell-count"
                  className="px-1.5 py-0 font-mono text-[11px]">{unreadCount}</Badge></>)}
          </div>
          {!showingDetail && !showingSettings && visible.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="icon" disabled={isPending || unreadCount === 0}
                onClick={markAll} aria-label={t("markAllRead")} data-testid="notifications-mark-all-read"
                className="size-7 text-muted-foreground hover:text-foreground">
                <CheckCheck className="size-3.5" aria-hidden /></Button>
              <Button variant="ghost" size="icon" disabled={isPending} onClick={clearAll}
                aria-label={t("clearAll")} data-testid="notifications-clear-all"
                className="size-7 text-muted-foreground hover:text-destructive">
                <Trash2 className="size-3.5" aria-hidden /></Button>
              <Button variant="ghost" size="icon" onClick={() => setView("settings")}
                aria-label={t("settings")} data-testid="notifications-settings-button"
                className="size-7 text-muted-foreground hover:text-foreground">
                <Settings className="size-3.5" aria-hidden /></Button>
            </div>)}
        </div>
        {!showingDetail && !showingSettings && (isDesktop ? (
          <div className="flex items-center justify-between border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
            <span className="flex items-center gap-1.5 font-medium">
              <Laptop className="size-3.5 text-emerald-500" aria-hidden />{t("desktopTitle")}</span>
            <Badge variant="outline" className="border-emerald-500/30 px-1.5 py-0 text-[10px] text-emerald-600 dark:text-emerald-400">
              {t("desktopActive")}</Badge>
          </div>
        ) : (permission === "prompt" || permission === "default") && (
          <div className="flex items-center justify-between border-b bg-primary/10 px-4 py-2 text-xs">
            <span className="text-[11px] text-muted-foreground">{t("permissionTitle")}</span>
            <Button size="sm" variant="outline" data-testid="notifications-enable-browser"
              onClick={() => requestBrowserNotificationPermission().then(setPermission)}
              className="h-6 px-2 text-[11px]">{t("enableBrowser")}</Button>
          </div>))}
        <div className="flex min-h-[280px] flex-1 flex-col overflow-hidden">
          {showingDetail && selected ? (
            <NotificationDetail notification={selected} onMutate={() => void mutate()}
              onDismissed={() => { setSelectedId(null); void mutate(); }}
              onNavigate={() => setIsOpen(false)} />
          ) : showingSettings ? (
            <NotificationsSettings />
          ) : (
            <NotificationsFeed notifications={visible} isLoading={isLoading} error={error}
              filter={filter} onFilterChange={setFilter} onSelect={setSelectedId}
              onToggleRead={toggleRead} onDismiss={dismiss} onSendTest={sendTest} isPending={isPending} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
