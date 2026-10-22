"use client";

import { useState } from "react";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { ChevronLeft, Loader2, Mail, MailOpen, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import {
  dismissNotification,
  markNotificationRead,
  type AmiroNotification,
} from "@/lib/notifications/notification-types";
import {
  fetchNotificationDeliveries,
  resendNotificationDelivery,
  type NotifyChannelId,
} from "@/lib/backend/notifications-api";
import { navigateToThreadOrSchedule } from "@/lib/notifications/notification-runtime";
import { DeliveryStatusBadge, channelLabel } from "./notification-presenters";
import { needsAttention } from "./feed-helpers";

export interface NotificationDetailProps {
  notification: AmiroNotification;
  onBack: () => void;
  onMutate: () => void;
  onDismissed: () => void;
  onNavigate: () => void;
  /** Fixed body height, so every notification opens in the same frame. */
  contentClassName?: string;
}

/** Vellum's panel header: one row, a rule under it. */
export const PANEL_HEADER_CLASS =
  "flex min-h-8 items-center gap-1 border-b border-border/60 px-4 py-3";

/**
 * One notification, after Vellum's bell detail: back, the title, and its
 * read and delete controls in the header; the full message as markdown in a
 * fixed frame that scrolls; and a footer with when it arrived and the way to
 * the chat or schedule it is about. External delivery attempts sit quietly
 * under the message, with resend for any that failed.
 */
export function NotificationDetail({
  notification,
  onBack,
  onMutate,
  onDismissed,
  onNavigate,
  contentClassName,
}: NotificationDetailProps) {
  const t = useTranslations("Notifications.Detail");
  const [busy, setBusy] = useState<string | null>(null);

  const { data: deliveries, error: deliveriesError, isLoading: deliveriesLoading, mutate: mutateDeliveries } =
    useSWR(`/api/notifications/${notification.id}/deliveries`, () =>
      fetchNotificationDeliveries(notification.id));

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const handleToggleRead = () =>
    run("read", async () => {
      try {
        await markNotificationRead(notification.id, !notification.read);
        onMutate();
      } catch {
        toast.error(t("actionFailed"));
      }
    });

  const handleDismiss = () =>
    run("dismiss", async () => {
      try {
        await dismissNotification(notification.id);
        toast.success(t("dismissed"));
        onDismissed();
      } catch {
        toast.error(t("actionFailed"));
      }
    });

  const handleResend = (channel: NotifyChannelId) =>
    run(`resend-${channel}`, async () => {
      try {
        await resendNotificationDelivery({ deliveryId: notification.deliveryId, channel });
        toast.success(t("resent", { channel: channelLabel(channel) }));
        void mutateDeliveries();
        onMutate();
      } catch {
        toast.error(t("resendFailed"));
      }
    });

  const handleView = () => {
    onNavigate();
    navigateToThreadOrSchedule(notification.threadId, notification.scheduleId);
  };

  const ReadIcon = notification.read ? MailOpen : Mail;
  const readLabel = notification.read ? t("markUnread") : t("markRead");
  const external = (deliveries ?? []).filter((d) => d.channel !== "local");
  const created = new Date(notification.createdAt);

  return (
    <div data-testid="notification-detail" className="flex min-h-0 flex-col">
      <div className={PANEL_HEADER_CLASS}>
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="notifications-back"
          aria-label={t("back")} className="size-8 shrink-0 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        {needsAttention(notification) ? (
          <h2 className="flex min-w-0 flex-1 items-center overflow-hidden">
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse" aria-hidden />
              <span className="truncate">{notification.title}</span>
            </span>
          </h2>
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {notification.title}
          </h2>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" data-testid="notification-toggle-read"
            aria-label={readLabel} title={readLabel} disabled={busy !== null} onClick={handleToggleRead}
            className="size-8 text-muted-foreground hover:text-foreground">
            <ReadIcon className="size-4" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" data-testid="notification-dismiss"
            aria-label={t("dismiss")} title={t("dismiss")} disabled={busy !== null} onClick={handleDismiss}
            className="size-8 text-muted-foreground hover:text-destructive">
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <div data-testid="notification-detail-content"
        className={cn("h-[400px] max-h-[calc(100dvh-192px)] overflow-y-auto overscroll-contain px-4 pt-4 pb-4", contentClassName)}>
        <div className="text-sm text-foreground [&_article]:max-w-none [&_li]:leading-normal [&_p]:my-1.5 [&_p]:leading-normal">
          <Markdown>{notification.body}</Markdown>
        </div>

        <section className="mt-5" aria-label={t("deliveryState")}>
          {deliveriesLoading ? (
            <p data-testid="notification-deliveries-loading" role="status"
              className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("deliveriesLoading")}
            </p>
          ) : deliveriesError ? (
            <p data-testid="notification-deliveries-error" role="alert" className="text-xs text-destructive">
              {t("deliveriesError")}
            </p>
          ) : !deliveries || deliveries.length === 0 ? (
            <p data-testid="notification-deliveries-empty" className="text-xs text-muted-foreground">
              {t("noDeliveries")}
            </p>
          ) : (
            <ul data-testid="notification-deliveries" className="flex flex-col gap-1.5">
              {deliveries.map((d, i) => (
                <li key={`${d.channel}-${d.deliveryId}-${i}`} data-testid={`notification-delivery-${d.channel}`}
                  className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {d.channel === "local" && external.length === 0 ? t("deliveredHere") : channelLabel(d.channel)}
                    {d.error ? <span className="ml-1.5 text-muted-foreground/70">· {d.error}</span> : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <DeliveryStatusBadge status={d.status} />
                    {d.channel !== "local" && (d.status === "failed" || d.status === "skipped") ? (
                      <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]"
                        disabled={busy !== null}
                        aria-label={t("resendChannel", { channel: channelLabel(d.channel) })}
                        data-testid={`notification-resend-${d.channel}`}
                        onClick={() => handleResend(d.channel as NotifyChannelId)}>
                        {busy === `resend-${d.channel}` ? (
                          <Loader2 className="size-3 animate-spin" aria-hidden />
                        ) : (
                          <Send className="size-3" aria-hidden />
                        )}
                        {t("resend")}
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div data-testid="notification-detail-footer"
        className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 p-4">
        <time dateTime={notification.createdAt} title={created.toLocaleString()}
          className="min-w-0 truncate text-xs text-muted-foreground">
          {created.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </time>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {notification.scheduleId && (
            <Button size="sm" variant="outline" data-testid={notification.threadId ? undefined : "notification-view-source"}
              onClick={() => { onNavigate(); navigateToThreadOrSchedule(null, notification.scheduleId); }}>
              {t("openSchedule")}
            </Button>
          )}
          {notification.threadId && (
            <Button size="sm" data-testid="notification-view-source" onClick={handleView}>
              {t("goToConversation")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
