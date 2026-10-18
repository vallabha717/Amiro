"use client";

import { useState, useMemo, useTransition } from "react";
import Link from "next/link";
import {
  Bell,
  CheckCheck,
  ChevronLeft,
  Clock,
  ExternalLink,
  MessageSquare,
  Calendar,
  Activity,
  ShieldAlert,
  Info,
  Settings,
  Trash2,
  Sparkles,
  Check,
  Eye,
  EyeOff,
  Laptop,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useNotifications,
  useNotificationStream,
  isTauriDesktop,
  checkBrowserPermission,
  requestBrowserNotificationPermission,
  navigateToThreadOrSchedule,
} from "@/lib/notifications/notification-runtime";
import {
  categoryLabel,
  markNotificationRead,
  markAllNotificationsRead,
  clearAllNotifications,
  dismissNotification,
  sendTestNotification,
  type AmiroNotification,
  type NotificationCategory,
} from "@/lib/notifications/notification-types";

export function formatRelativeTime(isoString?: string): string {
  if (!isoString) return "";
  const now = Date.now();
  const date = new Date(isoString).getTime();
  if (Number.isNaN(date)) return "";
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function CategoryIcon({ category }: { category: NotificationCategory }) {
  switch (category) {
    case "chat_reply":
      return <MessageSquare className="size-3.5 text-blue-500" />;
    case "schedule_result":
      return <Calendar className="size-3.5 text-emerald-500" />;
    case "heartbeat":
      return <Activity className="size-3.5 text-amber-500" />;
    case "approval":
      return <ShieldAlert className="size-3.5 text-purple-500" />;
    case "system":
    default:
      return <Info className="size-3.5 text-muted-foreground" />;
  }
}

function categoryBadgeVariant(category: NotificationCategory): string {
  switch (category) {
    case "chat_reply":
      return "border-blue-500/30 text-blue-600 dark:text-blue-400 bg-blue-500/10";
    case "schedule_result":
      return "border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10";
    case "heartbeat":
      return "border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10";
    case "approval":
      return "border-purple-500/30 text-purple-600 dark:text-purple-400 bg-purple-500/10";
    case "system":
    default:
      return "border-zinc-500/30 text-zinc-600 dark:text-zinc-400 bg-zinc-500/10";
  }
}

export function NotificationsBell() {
  useNotificationStream();
  const { notifications, unreadCount, mutate } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<string>(() =>
    checkBrowserPermission(),
  );
  const [isPending, startTransition] = useTransition();

  const isDesktop = isTauriDesktop();

  const visibleNotifications = useMemo(() => {
    return notifications.filter((n) => !n.dismissed);
  }, [notifications]);

  const displayedNotifications = useMemo(() => {
    if (unreadOnly) {
      return visibleNotifications.filter((n) => !n.read);
    }
    return visibleNotifications;
  }, [visibleNotifications, unreadOnly]);

  const selectedNotification = useMemo(() => {
    return visibleNotifications.find((n) => n.id === selectedId) ?? null;
  }, [visibleNotifications, selectedId]);

  const handleRequestPermission = async () => {
    const res = await requestBrowserNotificationPermission();
    setPermissionState(res);
  };

  const handleMarkAllRead = async () => {
    startTransition(async () => {
      await markAllNotificationsRead();
      void mutate();
    });
  };

  const handleClearAll = async () => {
    startTransition(async () => {
      await clearAllNotifications();
      setSelectedId(null);
      void mutate();
    });
  };

  const handleToggleRead = async (e: React.MouseEvent, n: AmiroNotification) => {
    e.stopPropagation();
    startTransition(async () => {
      await markNotificationRead(n.id, !n.read);
      void mutate();
    });
  };

  const handleDismiss = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (selectedId === id) setSelectedId(null);
    startTransition(async () => {
      await dismissNotification(id);
      void mutate();
    });
  };

  const handleSendTest = async () => {
    startTransition(async () => {
      await sendTestNotification();
      void mutate();
    });
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          data-testid="notifications-bell-button"
          aria-label="Notifications"
          className="relative bg-secondary/40 hover:bg-secondary/70 transition-colors"
        >
          <Bell className="size-4" />
          {unreadCount > 0 && (
            <span
              data-testid="notifications-unread-badge"
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground shadow-sm animate-in zoom-in-50 duration-200"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        data-testid="notifications-bell-popover"
        className="w-[380px] sm:w-[420px] p-0 shadow-xl border bg-popover/95 backdrop-blur-md rounded-xl overflow-hidden flex flex-col max-h-[560px]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3 bg-muted/20">
          <div className="flex items-center gap-2">
            {selectedNotification ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedId(null)}
                className="h-7 px-2 -ml-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="size-4 mr-0.5" />
                Back
              </Button>
            ) : (
              <>
                <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
                <Badge
                  variant="secondary"
                  data-testid="notifications-bell-count"
                  className="px-1.5 py-0 text-[11px] font-mono font-medium"
                >
                  {unreadCount}
                </Badge>
              </>
            )}
          </div>

          {!selectedNotification && (
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-1.5 mr-1 text-xs text-muted-foreground">
                <span className="text-[11px]">Unread</span>
                <Switch
                  data-testid="notifications-unread-toggle"
                  checked={unreadOnly}
                  onCheckedChange={setUnreadOnly}
                  aria-label="Filter unread"
                  className="scale-75 origin-center"
                />
              </div>

              {visibleNotifications.length > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={isPending || unreadCount === 0}
                    onClick={handleMarkAllRead}
                    title="Mark all read"
                    data-testid="notifications-mark-all-read"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  >
                    <CheckCheck className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={isPending}
                    onClick={handleClearAll}
                    title="Clear all"
                    data-testid="notifications-clear-all"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              )}

              <Link
                href="/admin/notifications"
                data-testid="notifications-settings-link"
                onClick={() => setIsOpen(false)}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title="Notification Settings"
              >
                <Settings className="size-3.5" />
              </Link>
            </div>
          )}
        </div>

        {/* Permission Banner / Desktop Status */}
        {!selectedNotification && (
          <div>
            {isDesktop ? (
              <div className="flex items-center justify-between px-4 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-[11px] text-emerald-700 dark:text-emerald-400">
                <span className="flex items-center gap-1.5 font-medium">
                  <Laptop className="size-3.5 text-emerald-500" />
                  Amiro Desktop
                </span>
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-[10px] px-1.5 py-0"
                >
                  Desktop Native Active
                </Badge>
              </div>
            ) : permissionState === "prompt" || permissionState === "default" ? (
              <div className="flex items-center justify-between px-4 py-2 bg-primary/10 border-b text-xs">
                <span className="text-muted-foreground text-[11px]">
                  Enable OS push notifications
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRequestPermission}
                  data-testid="notifications-enable-browser"
                  className="h-6 text-[11px] px-2"
                >
                  Enable browser notifications
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {/* Body Content: Detail or List or Empty State */}
        <div className="flex-1 overflow-hidden min-h-[280px]">
          {selectedNotification ? (
            <div
              data-testid="notifications-bell-detail"
              className="p-4 flex flex-col h-full overflow-y-auto space-y-4"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] px-2 py-0.5 flex items-center gap-1",
                      categoryBadgeVariant(selectedNotification.category),
                    )}
                  >
                    <CategoryIcon category={selectedNotification.category} />
                    {categoryLabel(selectedNotification.category)}
                  </Badge>

                  {selectedNotification.urgency && (
                    <Badge variant="secondary" className="text-[10px] uppercase font-mono">
                      {selectedNotification.urgency}
                    </Badge>
                  )}
                </div>

                <h4 className="text-base font-semibold leading-snug text-foreground">
                  {selectedNotification.title}
                </h4>

                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Clock className="size-3" />
                  <span>{new Date(selectedNotification.createdAt).toLocaleString()}</span>
                  {selectedNotification.deliveryReceipt && (
                    <Badge variant="outline" className="text-[10px] font-mono px-1 py-0">
                      {selectedNotification.deliveryReceipt}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="border-t pt-3 text-xs leading-relaxed text-foreground whitespace-pre-wrap flex-1">
                {selectedNotification.body}
              </div>

              <div className="border-t pt-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={async () => {
                      await markNotificationRead(
                        selectedNotification.id,
                        !selectedNotification.read,
                      );
                      void mutate();
                    }}
                  >
                    {selectedNotification.read ? (
                      <>
                        <EyeOff className="size-3.5 mr-1" />
                        Mark unread
                      </>
                    ) : (
                      <>
                        <Check className="size-3.5 mr-1" />
                        Mark read
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs text-muted-foreground hover:text-destructive"
                    onClick={async () => {
                      await dismissNotification(selectedNotification.id);
                      setSelectedId(null);
                      void mutate();
                    }}
                  >
                    <Trash2 className="size-3.5 mr-1" />
                    Dismiss
                  </Button>
                </div>

                {selectedNotification.threadId && (
                  <Button
                    size="sm"
                    variant="default"
                    className="h-8 text-xs font-medium"
                    onClick={() => {
                      setIsOpen(false);
                      navigateToThreadOrSchedule(
                        selectedNotification.threadId,
                        selectedNotification.scheduleId,
                      );
                    }}
                  >
                    Go to Conversation
                    <ExternalLink className="size-3 ml-1.5" />
                  </Button>
                )}
              </div>
            </div>
          ) : displayedNotifications.length === 0 ? (
            <div
              data-testid="notifications-empty-state"
              className="p-8 flex flex-col items-center justify-center text-center space-y-3 h-full"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                <Bell className="size-6 opacity-60" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {unreadOnly ? "No unread notifications" : "No notifications yet"}
                </p>
                <p className="text-xs text-muted-foreground max-w-[220px]">
                  Turn completions, schedules, approvals, and system alerts appear here.
                </p>
              </div>

              <Button
                size="sm"
                variant="outline"
                data-testid="notifications-send-test"
                onClick={handleSendTest}
                className="mt-2 text-xs gap-1.5"
              >
                <Sparkles className="size-3 text-primary" />
                Send test notification
              </Button>
            </div>
          ) : (
            <ScrollArea className="h-[360px]" data-testid="notifications-bell-list">
              <div className="divide-y divide-border/60">
                {displayedNotifications.map((n) => (
                  <div
                    key={n.id}
                    data-testid="notification-row"
                    data-notification-id={n.id}
                    onClick={() => setSelectedId(n.id)}
                    className={cn(
                      "p-3.5 hover:bg-muted/40 transition-colors cursor-pointer group flex items-start gap-3",
                      !n.read && "bg-primary/[0.03]",
                    )}
                  >
                    {/* Unread dot */}
                    <div className="pt-1.5">
                      <div
                        className={cn(
                          "size-2 rounded-full transition-all",
                          !n.read
                            ? "bg-primary ring-2 ring-primary/20 scale-100"
                            : "bg-transparent scale-0",
                        )}
                      />
                    </div>

                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between gap-1.5">
                        <Badge
                          variant="outline"
                          data-testid={`notification-category-${n.category}`}
                          className={cn(
                            "text-[10px] px-1.5 py-0 font-medium",
                            categoryBadgeVariant(n.category),
                          )}
                        >
                          {categoryLabel(n.category)}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                          {formatRelativeTime(n.createdAt)}
                        </span>
                      </div>

                      <p
                        className={cn(
                          "text-xs leading-snug line-clamp-1",
                          !n.read ? "font-semibold text-foreground" : "font-medium text-foreground/80",
                        )}
                      >
                        {n.title}
                      </p>

                      <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                        {n.preview || n.body}
                      </p>
                    </div>

                    {/* Quick actions hover strip */}
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 -mr-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        title={n.read ? "Mark unread" : "Mark read"}
                        onClick={(e) => handleToggleRead(e, n)}
                      >
                        {n.read ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        title="Dismiss"
                        onClick={(e) => handleDismiss(e, n.id)}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
