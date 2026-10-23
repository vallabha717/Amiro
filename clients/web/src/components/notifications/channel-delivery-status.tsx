"use client";

import Link from "next/link";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { ArrowUpRight, CheckCircle2, CircleDashed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChannelIcon, getChannelLabel } from "@/components/channels/channel-presentation";
import { cn } from "@/lib/utils";
import {
  fetchNotifyChannels,
  NOTIFICATION_CHANNELS_KEY,
  NOTIFY_CHANNELS,
  type NotifyChannelStatus,
} from "@/lib/notifications/notification-channels-api";

/** Where each missing step is fixed. */
function stepLink(status: NotifyChannelStatus): string | null {
  switch (status.nextStep) {
    case "connect_bot":
      return "/channels";
    case "add_address":
    case "verify_address":
    case "fix_address":
      return "/contacts";
    default:
      return null;
  }
}

/**
 * Where notifications go outside Amiro, the Vellum way: nothing is set up
 * here. Each channel's bot is connected on the Channels page, and the
 * owner's own account on it lives on their contact card in Contacts, verified
 * with a code. This lists each channel's state and links to the one place
 * that fixes what is missing.
 */
export function ChannelDeliveryStatus({ className }: { className?: string }) {
  const t = useTranslations("Notifications.Channels");
  const { data, error, isLoading } = useSWR<NotifyChannelStatus[]>(
    NOTIFICATION_CHANNELS_KEY,
    fetchNotifyChannels,
  );
  // Until the status arrives (or if it comes back empty) every channel shows
  // as not set up, so the section never renders blank.
  const rows: NotifyChannelStatus[] =
    data && data.length > 0
      ? data
      : NOTIFY_CHANNELS.map((channel) => ({
      channel,
      botConfigured: false,
      botName: null,
      address: null,
      contactChannelId: null,
      verified: false,
      ready: false,
        nextStep: "connect_bot",
      }));

  return (
    <section data-testid="channel-delivery-section" aria-labelledby="channel-delivery-heading"
      className={cn("rounded-xl border border-border/60 bg-card p-4", className)}>
      <h3 id="channel-delivery-heading" className="text-sm font-semibold text-foreground">
        {t("title")}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("description")}</p>
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">{t("loadFailed")}</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border/60" aria-busy={isLoading}>
          {rows.map((row) => {
            const label = getChannelLabel(row.channel);
            const href = stepLink(row);
            return (
              <li key={row.channel} data-testid={`channel-delivery-${row.channel}`}
                data-ready={row.ready ? "true" : "false"} data-step={row.nextStep}
                className="flex items-center gap-3 py-2.5">
                <ChannelIcon channelId={row.channel} className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="text-sm font-medium text-foreground">{label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {row.ready
                      ? row.botName
                        ? t("readyVia", { address: row.address ?? "", bot: row.botName })
                        : t("ready", { address: row.address ?? "" })
                      : t(`step.${row.nextStep}`, { channel: label })}
                  </span>
                </div>
                {row.ready ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5" aria-hidden />
                    {t("statusReady")}
                  </span>
                ) : href ? (
                  <Button asChild size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2.5 text-xs">
                    <Link href={href} data-testid={`channel-delivery-fix-${row.channel}`}>
                      {href === "/channels" ? t("openChannels") : t("openContacts")}
                      <ArrowUpRight className="size-3" aria-hidden />
                    </Link>
                  </Button>
                ) : (
                  <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-label={t("statusNotReady")} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t("whatGoes")}</p>
    </section>
  );
}
