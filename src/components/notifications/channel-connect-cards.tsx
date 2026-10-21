"use client";

import { useState } from "react";
import useSWR from "swr";
import { CheckCircle2, Loader2, Send, Unplug, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "ui/button";
import { Badge } from "ui/badge";
import { Input } from "ui/input";
import { Label } from "ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "ui/card";
import { cn } from "lib/utils";
import { SecretPromptCard } from "@/components/credentials/secret-prompt-card";
import {
  bindNotifyChannel,
  channelVaultSlot,
  fetchNotifyChannels,
  unbindNotifyChannel,
  NOTIFICATION_CHANNELS_KEY,
  NOTIFY_CHANNELS,
  type NotifyChannelBinding,
  type NotifyChannelId,
} from "@/lib/notifications/notification-channels-api";

const CHANNEL_LABEL: Record<NotifyChannelId, string> = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
};

const CHANNEL_HINT: Record<NotifyChannelId, string> = {
  telegram: "Telegram chat id",
  slack: "Slack channel or user id",
  discord: "Discord recipient user id",
};

/** One channel's connect card: token via the secure secret card, chat id via a normal input. */
export function ChannelCard({
  binding,
  onChanged,
}: {
  binding: NotifyChannelBinding;
  onChanged: () => void;
}) {
  const t = useTranslations("Notifications.Channels");
  const channel = binding.channel;
  const slot = channelVaultSlot(channel);
  const [chatId, setChatId] = useState(binding.chatId ?? "");
  const [busy, setBusy] = useState(false);

  const handleBind = async () => {
    const destination = chatId.trim();
    if (!destination || busy) return;
    setBusy(true);
    try {
      await bindNotifyChannel({ channel, chatId: destination });
      toast.success(t("bindSuccess", { channel: CHANNEL_LABEL[channel] }));
      onChanged();
    } catch (error: any) {
      toast.error(error?.message || t("bindFailed"));
    } finally {
      setBusy(false);
    }
  };

  const handleUnbind = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await unbindNotifyChannel(channel);
      toast.success(t("unbindSuccess", { channel: CHANNEL_LABEL[channel] }));
      onChanged();
    } catch (error: any) {
      toast.error(error?.message || t("unbindFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-lg border bg-muted/30 p-3.5"
      data-testid={`channel-connect-${channel}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">
          {CHANNEL_LABEL[channel]}
        </span>
        <Badge
          variant={binding.bound ? "outline" : "secondary"}
          className={cn(
            "text-[10px] px-1.5 gap-1",
            binding.bound &&
              "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
          )}
          data-testid={`channel-status-${channel}`}
        >
          {binding.bound ? (
            <CheckCircle2 className="size-3" />
          ) : (
            <XCircle className="size-3" />
          )}
          {binding.bound ? t("bound") : t("unbound")}
        </Badge>
      </div>
      {binding.bound && binding.chatName && (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid={`channel-name-${channel}`}
        >
          {binding.chatName}
        </p>
      )}

      <div className="mt-3">
        <SecretPromptCard
          prompt={{
            id: `${slot.service}/${slot.field}`,
            service: slot.service,
            field: slot.field,
            label: t("tokenLabel", { channel: CHANNEL_LABEL[channel] }),
            description: t("tokenDescription", {
              channel: CHANNEL_LABEL[channel],
            }),
            purpose: t("tokenPurpose"),
            placeholder: t("tokenPlaceholder"),
          }}
        />
      </div>

      <div className="mt-3 space-y-1.5">
        <Label htmlFor={`channel-chat-${channel}`} className="text-xs">
          {CHANNEL_HINT[channel]}
        </Label>
        <Input
          id={`channel-chat-${channel}`}
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder={CHANNEL_HINT[channel]}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          data-testid={`channel-chat-id-${channel}`}
          className="h-8 font-mono text-xs"
        />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={handleBind}
          disabled={busy || chatId.trim().length === 0}
          data-testid={`channel-bind-${channel}`}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          {binding.bound ? t("updateBinding") : t("bindChannel")}
        </Button>
        {binding.bound && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={handleUnbind}
            disabled={busy}
            data-testid={`channel-unbind-${channel}`}
          >
            <Unplug className="size-3.5" />
            {t("unbind")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** External messaging channels section for the notifications settings page. */
export function ChannelConnectCards() {
  const t = useTranslations("Notifications.Channels");
  const { data: channels, mutate } = useSWR<NotifyChannelBinding[]>(
    NOTIFICATION_CHANNELS_KEY,
    fetchNotifyChannels,
    { revalidateOnFocus: false },
  );

  const bindings = NOTIFY_CHANNELS.map(
    (channel): NotifyChannelBinding =>
      channels?.find((c) => c.channel === channel) ?? {
        channel,
        bound: false,
        chatId: null,
        chatName: null,
        updatedAt: null,
        hasToken: false,
      },
  );

  return (
    <Card data-testid="channel-connect-section" className="border shadow-xs">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {bindings.map((binding) => (
          <ChannelCard
            key={binding.channel}
            binding={binding}
            onChanged={() => mutate()}
          />
        ))}
      </CardContent>
    </Card>
  );
}
