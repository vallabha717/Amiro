"use client";

import { useTranslations } from "next-intl";
import {
  Activity,
  Calendar,
  CheckCircle2,
  Info,
  MessageSquare,
  ShieldAlert,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { NotificationCategory } from "@/lib/notifications/notification-types";

export function CategoryIcon({ category }: { category: NotificationCategory }) {
  switch (category) {
    case "chat_reply":
      return <MessageSquare className="size-3.5 text-blue-500" aria-hidden />;
    case "schedule_result":
      return <Calendar className="size-3.5 text-emerald-500" aria-hidden />;
    case "heartbeat":
      return <Activity className="size-3.5 text-amber-500" aria-hidden />;
    case "approval":
      return <ShieldAlert className="size-3.5 text-purple-500" aria-hidden />;
    case "system":
    default:
      return <Info className="size-3.5 text-muted-foreground" aria-hidden />;
  }
}

export function categoryBadgeClass(category: NotificationCategory): string {
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

/** High/critical urgency gets an icon + text marker, never color alone. */
export function UrgencyMarker({ urgency }: { urgency?: string }) {
  const t = useTranslations("Notifications.Feed");
  if (urgency !== "high" && urgency !== "critical") return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"
      role="img"
      aria-label={t("urgent")}
    >
      <TriangleAlert className="size-3" aria-hidden />
      {t("urgent")}
    </span>
  );
}

const CHANNEL_LABEL: Record<string, string> = {
  local: "App inbox",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel;
}

export function DeliveryStatusBadge({ status }: { status: string }) {
  const t = useTranslations("Notifications.Detail");
  if (status === "sent") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/30 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
      >
        <CheckCircle2 className="size-3" aria-hidden />
        {t("sent")}
      </Badge>
    );
  }
  if (status === "skipped") {
    return (
      <Badge variant="secondary" className="gap-1 px-1.5 text-[10px]">
        {t("skipped")}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 border-destructive/40 px-1.5 text-[10px] text-destructive"
    >
      <XCircle className="size-3" aria-hidden />
      {t("failed")}
    </Badge>
  );
}
