"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Bell, Eye, EyeOff, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { AmiroNotification } from "@/lib/notifications/notification-types";
import {
  FEED_FILTERS,
  describeRelativeTime,
  filterNotifications,
  isFeedCategory,
  type FeedFilter,
} from "./feed-helpers";
import {
  CategoryIcon,
  UrgencyMarker,
  categoryBadgeClass,
} from "./notification-presenters";

export type { FeedFilter };

export interface NotificationsFeedProps {
  notifications: AmiroNotification[];
  isLoading: boolean;
  error?: Error;
  filter: FeedFilter;
  onFilterChange: (filter: FeedFilter) => void;
  onSelect: (id: string) => void;
  onToggleRead: (notification: AmiroNotification) => void;
  onDismiss: (id: string) => void;
  onSendTest: () => void;
  isPending?: boolean;
}

export function NotificationsFeed({
  notifications,
  isLoading,
  error,
  filter,
  onFilterChange,
  onSelect,
  onToggleRead,
  onDismiss,
  onSendTest,
  isPending = false,
}: NotificationsFeedProps) {
  const t = useTranslations("Notifications.Feed");
  const tCategories = useTranslations("Notifications.Categories");
  const items = useMemo(
    () => filterNotifications(notifications, filter),
    [notifications, filter],
  );

  const relativeLabel = (iso: string) => {
    const rel = describeRelativeTime(iso);
    if (!rel) return "";
    if (rel.unit === "now") return t("justNow");
    if (rel.unit === "minute") return t("minutesAgo", { n: rel.value });
    if (rel.unit === "hour") return t("hoursAgo", { n: rel.value });
    return t("daysAgo", { n: rel.value });
  };

  const emptyTitle =
    filter === "unread"
      ? t("emptyUnread")
      : filter === "all"
        ? t("emptyAll")
        : t("emptyCategory", {
            category: isFeedCategory(filter) ? tCategories(filter) : filter,
          });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="group" aria-label={t("filterLabel")}
        className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        {FEED_FILTERS.map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "secondary" : "ghost"}
            data-testid={`notifications-filter-${f}`} aria-pressed={filter === f}
            onClick={() => onFilterChange(f)} className="h-7 rounded-full px-2.5 text-[11px]">
            {f === "all" ? t("filterAll") : f === "unread" ? t("filterUnread") : tCategories(f)}
          </Button>
        ))}
      </div>
      {isLoading ? (
        <div data-testid="notifications-feed-loading" role="status"
          className="flex flex-1 items-center justify-center p-8 text-xs text-muted-foreground">
          {t("loading")}
        </div>
      ) : error ? (
        <div data-testid="notifications-feed-error" role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <p className="text-sm font-medium text-destructive">{t("loadFailed")}</p>
          <p className="max-w-[240px] text-xs text-muted-foreground">{error.message}</p>
        </div>
      ) : items.length === 0 ? (
        <div data-testid="notifications-empty-state"
          className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
            <Bell className="size-6 opacity-60" aria-hidden />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
            <p className="max-w-[220px] text-xs text-muted-foreground">{t("emptyHint")}</p>
          </div>
          {filter !== "all" && (
            <Button size="sm" variant="ghost" data-testid="notifications-clear-filter"
              onClick={() => onFilterChange("all")} className="h-7 text-xs">
              {t("clearFilter")}
            </Button>
          )}
          <Button size="sm" variant="outline" data-testid="notifications-send-test"
            onClick={onSendTest} disabled={isPending} className="mt-1 text-xs">
            <Sparkles className="size-3 text-primary" aria-hidden />
            {t("sendTest")}
          </Button>
        </div>
      ) : (
        <ScrollArea className="h-[360px]">
          <ul data-testid="notifications-feed" className="divide-y divide-border/60">
            {items.map((n) => (
              <li key={n.id} data-testid={`notification-row-${n.id}`}
                className={cn("group flex items-start gap-2 p-3 transition-colors hover:bg-muted/40",
                  !n.read && "bg-primary/[0.03]")}>
                <span aria-hidden className={cn("mt-2 size-2 shrink-0 rounded-full transition-all",
                  !n.read ? "bg-primary ring-2 ring-primary/20" : "bg-transparent")} />
                {!n.read && <span className="sr-only">{t("filterUnread")}</span>}
                <button type="button" onClick={() => onSelect(n.id)} aria-label={n.title}
                  className="min-w-0 flex-1 space-y-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-primary">
                  <span className="flex items-center justify-between gap-1.5">
                    <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-medium",
                      categoryBadgeClass(n.category))}>
                      <CategoryIcon category={n.category} />
                      <span className="ml-1">{tCategories(n.category)}</span>
                    </Badge>
                    <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                      {relativeLabel(n.createdAt)}
                    </span>
                  </span>
                  <span className={cn("block truncate text-xs leading-snug",
                    !n.read ? "font-semibold text-foreground" : "font-medium text-foreground/80")}>
                    {n.title}
                  </span>
                  <span className="block text-[11px] leading-relaxed text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                    {n.preview || n.body}
                  </span>
                  <UrgencyMarker urgency={n.urgency} />
                </button>
                <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <Button size="icon" variant="ghost" disabled={isPending}
                    aria-label={n.read ? t("markUnread") : t("markRead")}
                    data-testid={`notification-quick-read-${n.id}`}
                    onClick={() => onToggleRead(n)}
                    className="size-6 text-muted-foreground hover:text-foreground">
                    {n.read ? <EyeOff className="size-3" aria-hidden />
                      : <Eye className="size-3" aria-hidden />}
                  </Button>
                  <Button size="icon" variant="ghost" disabled={isPending}
                    aria-label={t("dismiss")} data-testid={`notification-quick-dismiss-${n.id}`}
                    onClick={() => onDismiss(n.id)}
                    className="size-6 text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-3" aria-hidden />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
