"use client";

import { Clock, Loader2, MessageSquarePlus, XIcon, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";

import {
  type Interjection,
  type PendingFollowUp,
  previewQueuedText,
} from "@/lib/chat/followup-queue";

interface FollowUpChipsProps {
  /** Handed to the running turn; read at its next gap. */
  interjections: Interjection[];
  /** Parked to send as the next turn (it has files, or the turn was ending). */
  pendingFollowUp?: PendingFollowUp | null;
  /** How many of the parked follow-up's files are still attached. */
  queuedFileCount: number;
  /** Stop the turn and send everything waiting at once. */
  onSendNow?: () => void;
  onCancelInterjection?: (id: string) => void;
  onCancelFollowUp?: () => void;
}

/**
 * The follow-ups typed while the agent works, above the composer. Each one
 * says when it will be read, and offers Send now (stop and send at once) and
 * Cancel (hand the text back).
 */
export function FollowUpChips({
  interjections,
  pendingFollowUp,
  queuedFileCount,
  onSendNow,
  onCancelInterjection,
  onCancelFollowUp,
}: FollowUpChipsProps) {
  const t = useTranslations("Chat");
  if (interjections.length === 0 && !pendingFollowUp) return null;

  const sendNow = onSendNow ? (
    <Button
      variant="ghost"
      size="sm"
      data-testid="followup-send-now"
      className="h-6 shrink-0 gap-1 rounded-full px-2 text-xs text-primary"
      aria-label={t("followUpSendNowHint")}
      title={t("followUpSendNowHint")}
      onClick={() => onSendNow()}
    >
      <Zap className="size-3" />
      {t("followUpSendNow")}
    </Button>
  ) : null;

  return (
    <div className="mx-2 mt-2 flex flex-col gap-1.5">
      {interjections.map((item) => (
        <div
          key={item.id}
          data-testid="interjection-chip"
          data-status={item.status}
          className="flex items-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2 text-left"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            {item.status === "sending" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <MessageSquarePlus className="size-3.5" />
            )}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs font-semibold text-primary">
              {item.status === "sending"
                ? t("followUpSending")
                : t("followUpNextStep")}
            </span>
            <span className="truncate text-sm text-foreground">
              {previewQueuedText(item.text)}
            </span>
          </div>
          {item.status === "waiting" ? sendNow : null}
          <Button
            variant="ghost"
            size="icon"
            data-testid="interjection-cancel"
            className="size-6 shrink-0 rounded-full"
            aria-label={t("followUpCancel")}
            title={t("followUpCancel")}
            disabled={item.status === "sending"}
            onClick={() => onCancelInterjection?.(item.id)}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ))}
      {pendingFollowUp ? (
        <div
          data-testid="queued-followup-chip"
          className="flex items-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2 text-left"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Clock className="size-3.5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs font-semibold text-primary">
              {pendingFollowUp.kind === "interrupt"
                ? t("followUpInterrupting")
                : t("followUpQueuedLabel")}
            </span>
            <span className="truncate text-sm text-foreground">
              {previewQueuedText(pendingFollowUp.text)}
              {queuedFileCount > 0
                ? t("followUpQueuedFiles", { count: queuedFileCount })
                : null}
            </span>
          </div>
          {pendingFollowUp.kind === "queued" ? sendNow : null}
          <Button
            variant="ghost"
            size="icon"
            data-testid="queued-followup-cancel"
            className="size-6 shrink-0 rounded-full"
            aria-label={t("followUpCancel")}
            title={t("followUpCancel")}
            onClick={() => onCancelFollowUp?.()}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
