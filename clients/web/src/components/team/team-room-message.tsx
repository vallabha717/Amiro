"use client";

import { Markdown } from "@/components/markdown";
import type { TeamAgent } from "@/lib/backend/agents-api";
import type { TeamRoomMessage } from "@/lib/backend/team-room-api";
import { cn } from "@/lib/utils";
import { AlertTriangleIcon, ArrowRightIcon, UserRoundIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { AgentAvatar } from "./agent-avatar";

function time(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** One room message: who wrote it, who it went to, and what it says. */
export function TeamRoomMessageRow({
  message,
  agents,
}: {
  message: TeamRoomMessage;
  agents: Map<string, TeamAgent>;
}) {
  const t = useTranslations("TeamRoom");
  const nameOf = (id: string) => agents.get(id)?.name ?? t("formerAgent");

  if (message.from.type === "system") {
    const name = message.agentId ? nameOf(message.agentId) : t("formerAgent");
    if (message.kind === "empty") {
      return (
        <p
          role="note"
          data-testid="team-room-notice"
          data-kind="empty"
          data-agent={message.agentId}
          className="mx-auto text-center text-xs text-muted-foreground"
        >
          {t("noReply", { name })}
        </p>
      );
    }
    return (
      <div
        role="note"
        data-testid="team-room-notice"
        data-kind="error"
        data-agent={message.agentId}
        className="mx-auto flex max-w-xl items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
      >
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {t("couldNotReply", { name })}
          {message.detail && (
            <span className="text-muted-foreground"> · {message.detail}</span>
          )}
        </span>
      </div>
    );
  }

  const fromAgent =
    message.from.type === "agent" ? agents.get(message.from.id) : undefined;
  const isHandoff = message.from.type === "agent" && message.to.length > 0;
  const recipients = message.to.map(nameOf);

  return (
    <article
      data-testid="team-room-message"
      data-from={message.from.type}
      data-sender={message.from.id}
      data-handoff={isHandoff ? "true" : undefined}
      className="flex gap-3"
    >
      <div className="shrink-0 pt-0.5">
        {fromAgent ? (
          <AgentAvatar agent={fromAgent} size={32} />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserRoundIcon className="size-4" aria-hidden />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span className="font-semibold text-foreground text-sm">
            {message.from.name}
          </span>
          {recipients.length > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <ArrowRightIcon className="size-3" aria-label={t("to")} />
              {recipients.join(", ")}
            </span>
          )}
          {isHandoff && (
            <span className="rounded-full border border-primary/30 bg-primary/5 px-1.5 text-[10px] text-primary">
              {t("handoff")}
            </span>
          )}
          <time className="text-muted-foreground" dateTime={message.createdAt}>
            {time(message.createdAt)}
          </time>
        </div>
        <div
          className={cn(
            "mt-1 text-sm break-words",
            isHandoff &&
              "rounded-xl border-l-2 border-primary/40 bg-muted/40 px-3 py-2",
          )}
        >
          <Markdown>{message.text}</Markdown>
        </div>
        {message.limitReached && (
          <p
            className="mt-1 text-xs text-muted-foreground"
            data-testid="team-room-limit"
          >
            {t("limitReached")}
          </p>
        )}
      </div>
    </article>
  );
}
