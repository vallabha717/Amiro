"use client";

import { useTranslations } from "next-intl";
import { Bell, Mail, MailOpen, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { AmiroNotification } from "@/lib/notifications/notification-types";
import { describeRelativeTime, needsAttention, plainPreview } from "./feed-helpers";

export interface NotificationsFeedProps {
  /** What to list, already filtered and sorted (see `visibleFeed`). */
  items: AmiroNotification[];
  /** How many notifications exist before the unread filter. */
  totalCount: number;
  isLoading: boolean;
  error?: Error;
  /** Chat titles by thread id, so a row can name the chat it came from. */
  threadTitles?: ReadonlyMap<string, string>;
  onSelect: (notification: AmiroNotification) => void;
  onToggleRead: (notification: AmiroNotification) => void;
  onDismiss: (id: string) => void;
  isPending?: boolean;
}

const NO_TITLES: ReadonlyMap<string, string> = new Map();

/** Square ghost control for a row action, Vellum's 24px recap button. */
const ROW_ACTION_CLASS =
  "pointer-events-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50";

/**
 * The line under a row's title. A chat reply names the chat it answered and
 * quotes the reply's first line; anything else names where it came from. An
 * approval still waiting on the user quotes what it asks instead.
 */
function secondLine(
  n: AmiroNotification,
  threadTitles: ReadonlyMap<string, string>,
  sourceLabel: string,
): { text: string; tone: "ask" | "meta" } {
  if (needsAttention(n)) {
    return { text: plainPreview(n.preview || n.body, 200), tone: "ask" };
  }
  if (n.category === "chat_reply") {
    const preview = plainPreview(n.preview || n.body);
    const chat = n.threadId ? threadTitles.get(n.threadId) : undefined;
    const parts = [chat && chat !== n.title ? chat : null, preview].filter(Boolean);
    return { text: parts.join(" · "), tone: "meta" };
  }
  return { text: sourceLabel, tone: "meta" };
}

/**
 * The inbox list, after Vellum's bell list: a stack of rows divided by thin
 * rules, each one an unread dot, the title, and when it arrived, with one
 * quiet line underneath. A pointer swaps the time for the row's read and
 * dismiss buttons; on touch those live in the detail.
 */
export function NotificationsFeed({
  items,
  totalCount,
  isLoading,
  error,
  threadTitles = NO_TITLES,
  onSelect,
  onToggleRead,
  onDismiss,
  isPending = false,
}: NotificationsFeedProps) {
  const t = useTranslations("Notifications.Feed");
  const tCategories = useTranslations("Notifications.Categories");

  const relativeLabel = (iso: string) => {
    const rel = describeRelativeTime(iso);
    if (!rel) return "";
    if (rel.unit === "now") return t("justNow");
    if (rel.unit === "minute") return t("minutesAgo", { n: rel.value });
    if (rel.unit === "hour") return t("hoursAgo", { n: rel.value });
    return t("daysAgo", { n: rel.value });
  };

  if (isLoading) {
    return (
      <div data-testid="notifications-feed-loading" role="status" aria-label={t("loading")}
        className="flex flex-col gap-3 px-4 py-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5 border-b border-border/60 pb-3 last:border-b-0">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="ml-4 h-3 w-1/3" />
          </div>
        ))}
      </div>
    );
  }

  if (error && totalCount === 0) {
    return (
      <p data-testid="notifications-feed-error" role="alert"
        className="px-4 py-6 text-center text-sm text-muted-foreground">
        {t("loadFailed")}
      </p>
    );
  }

  if (items.length === 0) {
    if (totalCount > 0) {
      return (
        <p data-testid="notifications-empty-state"
          className="px-4 py-6 text-center text-sm text-muted-foreground">
          {t("noUnread")}
        </p>
      );
    }
    return (
      <div data-testid="notifications-empty-state"
        className="flex flex-col items-center gap-3 px-4 pt-6 pb-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
          <Bell className="size-7 text-muted-foreground" aria-hidden />
        </div>
        <p className="text-sm font-medium text-foreground">{t("emptyAll")}</p>
        <p className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">{t("emptyHint")}</p>
      </div>
    );
  }

  return (
    <ul data-testid="notifications-feed"
      className="flex max-h-[min(465px,calc(100dvh-128px))] flex-col gap-3 overflow-y-auto overscroll-contain px-4 pt-4 pb-1">
      {items.map((n) => {
        const line = secondLine(n, threadTitles, tCategories(n.category));
        const ReadIcon = n.read ? MailOpen : Mail;
        return (
          <li key={n.id} data-testid={`notification-row-${n.id}`}
            data-read={n.read ? "true" : "false"}
            className="border-b border-border/60 pb-3 last:border-b-0">
            <div className="group relative flex w-full flex-col gap-1">
              {/* Stretched link: the row's single click target. Everything else
                  stacks above it and stays pointer-events-none unless it is a
                  control itself. */}
              <button type="button" onClick={() => onSelect(n)} aria-label={n.title}
                className="absolute -inset-x-2 -inset-y-1 cursor-pointer rounded-md transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none" />
              <div className="pointer-events-none relative flex items-center gap-2">
                <span className="flex w-2 shrink-0 items-center justify-center">
                  <span aria-hidden className={cn("size-2 rounded-full",
                    n.read ? "bg-border" : "bg-emerald-500")} />
                </span>
                {!n.read && <span className="sr-only">{t("unread")}</span>}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {n.title}
                </span>
                <span className="ml-auto grid shrink-0 justify-items-end">
                  <span className="col-start-1 row-start-1 self-center text-xs whitespace-nowrap text-muted-foreground/70 transition-opacity [@media(hover:hover)]:group-hover:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-0">
                    {relativeLabel(n.createdAt)}
                  </span>
                  <span className="col-start-1 row-start-1 hidden items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:flex">
                    <button type="button" disabled={isPending}
                      aria-label={n.read ? t("markUnread") : t("markRead")}
                      title={n.read ? t("markUnread") : t("markRead")}
                      data-testid={`notification-quick-read-${n.id}`}
                      onClick={(e) => { e.stopPropagation(); onToggleRead(n); }}
                      className={ROW_ACTION_CLASS}>
                      <ReadIcon className="size-4" aria-hidden />
                    </button>
                    <button type="button" disabled={isPending}
                      aria-label={t("dismiss")} title={t("dismiss")}
                      data-testid={`notification-quick-dismiss-${n.id}`}
                      onClick={(e) => { e.stopPropagation(); onDismiss(n.id); }}
                      className={cn(ROW_ACTION_CLASS, "hover:text-destructive")}>
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </span>
                </span>
              </div>
              {line.text && (
                <div className="pointer-events-none relative flex min-w-0 flex-col pl-4">
                  <span className={cn("text-xs leading-normal",
                    line.tone === "ask"
                      ? "line-clamp-2 text-foreground/75"
                      : "truncate text-muted-foreground")}>
                    {line.text}
                  </span>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
