"use client";

import { useState } from "react";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import {
  Check,
  Clock,
  EyeOff,
  Loader2,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import {
  navigateToThreadOrSchedule,
} from "@/lib/notifications/notification-runtime";
import {
  CategoryIcon,
  DeliveryStatusBadge,
  UrgencyMarker,
  categoryBadgeClass,
  channelLabel,
} from "./notification-presenters";

export interface NotificationDetailProps {
  notification: AmiroNotification;
  onMutate: () => void;
  onDismissed: () => void;
  onNavigate: () => void;
}

export function NotificationDetail({
  notification,
  onMutate,
  onDismissed,
  onNavigate,
}: NotificationDetailProps) {
  const t = useTranslations("Notifications.Detail");
  const tCategories = useTranslations("Notifications.Categories");
  const [busy, setBusy] = useState<string | null>(null);

  const deliveriesKey = `/api/notifications/${notification.id}/deliveries`;
  const {
    data: deliveries,
    error: deliveriesError,
    isLoading: deliveriesLoading,
    mutate: mutateDeliveries,
  } = useSWR(deliveriesKey, () =>
    fetchNotificationDeliveries(notification.id),
  );

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
        await resendNotificationDelivery({
          deliveryId: notification.deliveryId,
          channel,
        });
        toast.success(t("resent", { channel: channelLabel(channel) }));
        void mutateDeliveries();
        onMutate();
      } catch {
        toast.error(t("resendFailed"));
      }
    });

  const handleView = () => {
    onNavigate();
    navigateToThreadOrSchedule(
      notification.threadId,
      notification.scheduleId,
    );
  };

  const canView = Boolean(notification.threadId || notification.scheduleId);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div
        data-testid="notification-detail"
        className="flex flex-col gap-4 p-4"
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 text-[10px]",
                categoryBadgeClass(notification.category),
              )}
            >
              <CategoryIcon category={notification.category} />
              {tCategories(notification.category)}
            </Badge>
            <UrgencyMarker urgency={notification.urgency} />
          </div>
          <h2 className="text-base font-semibold leading-snug text-foreground">
            {notification.title}
          </h2>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Clock className="size-3" aria-hidden />
            <span>
              {new Date(notification.createdAt).toLocaleString()}
            </span>
            {notification.deliveryReceipt ? (
              <Badge variant="outline" className="px-1 py-0 font-mono text-[10px]">
                {notification.deliveryReceipt}
              </Badge>
            ) : null}
          </div>
        </div>

        <p className="whitespace-pre-wrap border-t pt-3 text-xs leading-relaxed text-foreground">
          {notification.body}
        </p>

        <div className="space-y-2 border-t pt-3">
          <h3 className="text-xs font-semibold text-foreground">
            {t("deliveryState")}
          </h3>
          {deliveriesLoading ? (
            <p
              data-testid="notification-deliveries-loading"
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("deliveriesLoading")}
            </p>
          ) : deliveriesError ? (
            <p
              data-testid="notification-deliveries-error"
              className="text-xs text-destructive"
              role="alert"
            >
              {t("deliveriesError")}
            </p>
          ) : !deliveries || deliveries.length === 0 ? (
            <p
              data-testid="notification-deliveries-empty"
              className="text-xs text-muted-foreground"
            >
              {t("noDeliveries")}
            </p>
          ) : (
            <ul
              data-testid="notification-deliveries"
              className="space-y-1.5"
            >
              {deliveries.map((d, i) => (
                <li
                  key={`${d.channel}-${d.deliveryId}-${i}`}
                  data-testid={`notification-delivery-${d.channel}`}
                  className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {channelLabel(d.channel)}
                    </span>
                    {d.error ? (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {d.error}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <DeliveryStatusBadge status={d.status} />
                    {d.channel !== "local" &&
                    (d.status === "failed" || d.status === "skipped") ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 gap-1 px-2 text-[11px]"
                        disabled={busy !== null}
                        aria-label={t("resendChannel", {
                          channel: channelLabel(d.channel),
                        })}
                        data-testid={`notification-resend-${d.channel}`}
                        onClick={() =>
                          handleResend(d.channel as NotifyChannelId)
                        }
                      >
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
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
          {canView && (
            <Button
              size="sm"
              variant="default"
              className="h-8 text-xs"
              data-testid="notification-view-source"
              onClick={handleView}
            >
              {t("viewSource")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            data-testid="notification-toggle-read"
            disabled={busy !== null}
            onClick={handleToggleRead}
          >
            {notification.read ? (
              <EyeOff className="size-3.5" aria-hidden />
            ) : (
              <Check className="size-3.5" aria-hidden />
            )}
            <span className="ml-1">
              {notification.read ? t("markUnread") : t("markRead")}
            </span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs text-muted-foreground hover:text-destructive"
            data-testid="notification-dismiss"
            disabled={busy !== null}
            onClick={handleDismiss}
          >
            <Trash2 className="size-3.5" aria-hidden />
            <span className="ml-1">{t("dismiss")}</span>
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}
