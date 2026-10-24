"use client";

import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { ThreadStatus } from "@/lib/notifications/thread-activity";

/**
 * The small mark at the end of a chat row (Vellum's thread status
 * indicator): a pulsing dot while the chat is working, a green dot for a
 * reply you have not seen, a red alert for a turn that failed while you were
 * away. Named for screen readers; the colour is never the only signal.
 */
export function ThreadStatusMark({
  status,
  className,
}: {
  status: ThreadStatus;
  className?: string;
}) {
  const t = useTranslations("Layout");
  if (!status) return null;
  const label =
    status === "running"
      ? t("threadWorking")
      : status === "failed"
        ? t("threadFailed")
        : t("threadUnseen");
  return (
    <span
      data-testid="sidebar-thread-status"
      data-status={status}
      role="img"
      aria-label={label}
      title={label}
      className={cn("flex size-4 shrink-0 items-center justify-center", className)}
    >
      {status === "failed" ? (
        <CircleAlert className="size-3.5 text-destructive" aria-hidden />
      ) : status === "running" ? (
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
      ) : (
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
      )}
    </span>
  );
}
