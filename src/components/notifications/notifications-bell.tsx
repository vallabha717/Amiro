"use client";

import { useMemo, useState, useTransition } from "react";
import { Bell, BellRing, ChevronLeft, Ellipsis, MailCheck, Send, Settings, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { appStore } from "@/app/store";
import { NotificationsFeed } from "./notifications-feed";
import { NotificationDetail, PANEL_HEADER_CLASS } from "./notification-detail";
import { NotificationsSettings } from "./notifications-settings";
import { visibleFeed } from "./feed-helpers";
import {
  useNotifications, useNotificationStream, isTauriDesktop,
  checkBrowserPermission, requestBrowserNotificationPermission,
} from "@/lib/notifications/notification-runtime";
import { usePresenceReport } from "@/lib/notifications/presence";
import {
  clearAllNotifications, dismissNotification, markAllNotificationsRead,
  markNotificationRead, sendTestNotification, type AmiroNotification,
} from "@/lib/notifications/notification-types";

/**
 * The notification bell in the top bar, after Vellum's: a ghost icon with a
 * red dot that opens the latest notifications in a popover (a bottom sheet on
 * phones). The panel names itself and counts what it shows, offers an Unread
 * toggle and one overflow menu, and swaps a row for its detail in place.
 * Opening it always starts on unread, so it answers "what's new?" first.
 */
export function NotificationsBell() {
  const t = useTranslations("Notifications.Bell");
  useNotificationStream();
  usePresenceReport();
  const isMobile = useIsMobile();
  const { notifications, unreadCount, isLoading, error, mutate } = useNotifications();
  const threadList = appStore((state) => state.threadList);
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"feed" | "settings">("feed");
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [permission, setPermission] = useState<string>(() => checkBrowserPermission());
  const [isPending, startTransition] = useTransition();
  const isDesktop = useMemo(() => isTauriDesktop(), []);
  const all = useMemo(() => visibleFeed(notifications, false), [notifications]);
  const items = useMemo(() => visibleFeed(notifications, unreadOnly), [notifications, unreadOnly]);
  const threadTitles = useMemo(
    () => new Map(threadList.filter((th) => th.title).map((th) => [th.id, th.title])),
    [threadList]);
  const selected = useMemo(
    () => notifications.find((n) => n.id === selectedId && !n.dismissed) ?? null,
    [notifications, selectedId]);
  const showingSettings = !selected && view === "settings";
  const askForPermission = !isDesktop && (permission === "prompt" || permission === "default");

  const onOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      setUnreadOnly(true);
    } else {
      setSelectedId(null);
      setView("feed");
    }
  };
  const back = () => { setSelectedId(null); setView("feed"); };
  const write = (fn: () => Promise<void>, ok?: string) =>
    startTransition(async () => {
      try { await fn(); if (ok) toast.success(ok); } catch { toast.error(t("actionFailed")); }
      void mutate();
    });
  const open = (n: AmiroNotification) => {
    setSelectedId(n.id);
    if (!n.read) write(() => markNotificationRead(n.id, true));
  };
  const markAll = () => write(() => markAllNotificationsRead().then(() => {}), t("markedAllRead"));
  const clearAll = () => write(async () => {
    setSelectedId(null); await clearAllNotifications();
  }, t("clearedAll"));
  const toggleRead = (n: AmiroNotification) => write(() => markNotificationRead(n.id, !n.read));
  const dismiss = (id: string) => write(async () => {
    if (selectedId === id) setSelectedId(null);
    await dismissNotification(id);
  });
  const sendTest = () => write(() => sendTestNotification().then(() => {}), t("testSent"));

  const trigger = (
    <Button size="icon" variant="ghost" data-testid="notifications-bell"
      aria-label={unreadCount > 0 ? t("labelUnread", { count: unreadCount }) : t("label")}
      className="relative bg-secondary/40 hover:bg-secondary/70">
      <span className="relative flex" aria-hidden>
        <Bell className="size-4" />
        {unreadCount > 0 && (
          <span data-testid="notifications-unread-badge"
            className="absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-background bg-red-500" />
        )}
      </span>
    </Button>
  );

  const listHeader = (
    <div className={`${PANEL_HEADER_CLASS} justify-between gap-3`}>
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-[15px] font-semibold text-foreground">{t("label")}</h2>
        <span data-testid="notifications-bell-count"
          className="inline-flex min-w-6 shrink-0 items-center justify-center rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <label htmlFor="notifications-unread-only" className="text-sm text-muted-foreground">
          {t("unreadOnly")}
        </label>
        <Switch id="notifications-unread-only" data-testid="notifications-filter-unread"
          checked={unreadOnly} onCheckedChange={setUnreadOnly} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("actions")} title={t("actions")}
              data-testid="notifications-actions" className="size-8 text-muted-foreground hover:text-foreground">
              <Ellipsis className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem data-testid="notifications-mark-all-read"
              disabled={isPending || unreadCount === 0} onSelect={markAll}>
              <MailCheck aria-hidden />{t("markAllRead")}
            </DropdownMenuItem>
            {askForPermission && (
              <DropdownMenuItem data-testid="notifications-enable-browser"
                onSelect={() => void requestBrowserNotificationPermission().then(setPermission)}>
                <BellRing aria-hidden />{t("enableBrowser")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem data-testid="notifications-send-test" disabled={isPending} onSelect={sendTest}>
              <Send aria-hidden />{t("sendTest")}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="notifications-settings-button" onSelect={() => setView("settings")}>
              <Settings aria-hidden />{t("settings")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="notifications-clear-all" variant="destructive"
              disabled={isPending || all.length === 0} onSelect={clearAll}>
              <Trash2 aria-hidden />{t("clearAll")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  // Keyed so swapping list ↔ detail remounts the incoming view and replays
  // its entrance, as Vellum's panel does.
  const panel = (
    <div key={selected ? "detail" : showingSettings ? "settings" : "list"}
      className="flex min-w-0 flex-col animate-in fade-in-0 duration-150">
      {selected ? (
        <NotificationDetail notification={selected} onBack={back} onMutate={() => void mutate()}
          onDismissed={() => { setSelectedId(null); void mutate(); }}
          onNavigate={() => onOpenChange(false)}
          contentClassName={isMobile ? "h-[60dvh] max-h-none" : undefined} />
      ) : showingSettings ? (
        <>
          <div className={PANEL_HEADER_CLASS}>
            <Button variant="ghost" size="icon" onClick={back} data-testid="notifications-back"
              aria-label={t("back")} className="size-8 shrink-0 text-muted-foreground hover:text-foreground">
              <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t("settings")}</h2>
          </div>
          <div className="max-h-[min(520px,calc(100dvh-160px))] overflow-y-auto">
            <NotificationsSettings />
          </div>
        </>
      ) : (
        <>
          {listHeader}
          <NotificationsFeed items={items} totalCount={all.length} isLoading={isLoading} error={error}
            threadTitles={threadTitles} onSelect={open} onToggleRead={toggleRead} onDismiss={dismiss}
            isPending={isPending} />
        </>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={isOpen} onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent data-testid="notifications-bell-popover" className="max-h-[85dvh]">
          <DrawerTitle className="sr-only">{t("label")}</DrawerTitle>
          <div className="min-h-0 overflow-y-auto">{panel}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} data-testid="notifications-bell-popover"
        onOpenAutoFocus={(event) => {
          // Focus the panel, not the first row, so nothing lights up before
          // the user does anything.
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        tabIndex={-1}
        className="w-[435px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0 shadow-lg outline-none">
        {panel}
      </PopoverContent>
    </Popover>
  );
}
