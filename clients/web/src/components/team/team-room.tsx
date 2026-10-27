"use client";

import { type TeamAgent, useAgents } from "@/lib/backend/agents-api";
import {
  TEAM_ROOM_KEY,
  type TeamRoom as TeamRoomData,
  postTeamRoomMessage,
  useTeamRoom,
} from "@/lib/backend/team-room-api";
import { cn } from "@/lib/utils";
import { MessagesSquareIcon, Settings2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import { Button } from "ui/button";
import { Skeleton } from "ui/skeleton";
import { AgentAvatar } from "./agent-avatar";
import {
  TeamRoomComposer,
  type TeamRoomComposerHandle,
} from "./team-room-composer";
import { TeamRoomMessageRow } from "./team-room-message";

function AgentChip({
  agent,
  working,
  onMention,
}: {
  agent: TeamAgent;
  working: boolean;
  onMention: () => void;
}) {
  const t = useTranslations("TeamRoom");
  return (
    <button
      type="button"
      onClick={onMention}
      data-testid={`team-room-agent-${agent.id}`}
      data-working={working ? "true" : "false"}
      aria-label={t("mentionAgent", { name: agent.name })}
      className="flex shrink-0 items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="relative">
        <AgentAvatar agent={agent} size={32} animated={working} />
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background",
            working ? "animate-pulse bg-primary" : "bg-muted-foreground/40",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{agent.name}</span>
        <span className="text-[11px] text-muted-foreground">
          {working ? t("working") : t("idle")}
        </span>
      </span>
    </button>
  );
}

/**
 * The Team room: you and every agent in one conversation. A message goes to
 * whoever it @mentions (the main agent when it mentions no one), and agents
 * @mention each other to hand off work — every hand-off shows up here.
 */
export function TeamRoom({
  showMembers = true,
  showManage = true,
}: {
  showMembers?: boolean;
  /** "Manage team" link to the Team app; off when already inside it. */
  showManage?: boolean;
}) {
  const t = useTranslations("TeamRoom");
  const { data: agentData, isLoading: agentsLoading } = useAgents();
  const { data: room, error, isLoading } = useTeamRoom();
  const composer = useRef<TeamRoomComposerHandle>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const agents = agentData?.agents ?? [];
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const working = new Set(room?.working ?? []);
  const messages = room?.messages ?? [];
  const lastId = messages[messages.length - 1]?.id;

  useEffect(() => {
    if (lastId || working.size)
      bottom.current?.scrollIntoView({ block: "end" });
  }, [lastId, working.size]);

  const send = async (text: string) => {
    try {
      const { message } = await postTeamRoomMessage(text);
      await mutate(
        TEAM_ROOM_KEY,
        (current: TeamRoomData | undefined) =>
          current
            ? {
                ...current,
                messages: [...current.messages, message],
                working: [...new Set([...current.working, ...message.to])],
              }
            : current,
        { revalidate: true },
      );
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("sendError"));
      return false;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="team-room">
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold" data-testid="team-room-heading">
            {t("title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
        </div>
        {showManage && (
          <Button
            asChild
            variant="outline"
            size="sm"
            data-testid="team-room-manage"
          >
            <Link href="/team">
              <Settings2Icon className="size-4" />
              <span className="hidden sm:inline">{t("manage")}</span>
              <span className="sr-only sm:hidden">{t("manage")}</span>
            </Link>
          </Button>
        )}
      </header>

      {showMembers && (
        <nav
          aria-label={t("membersLabel")}
          data-testid="team-room-members"
          className="custom-scrollbar flex gap-1 overflow-x-auto border-b px-2 py-2"
        >
          {agentsLoading &&
            [0, 1].map((i) => (
              <Skeleton key={i} className="h-11 w-32 shrink-0 rounded-xl" />
            ))}
          {agents.map((agent) => (
            <AgentChip
              key={agent.id}
              agent={agent}
              working={working.has(agent.id)}
              onMention={() => composer.current?.mention(agent.name)}
            />
          ))}
        </nav>
      )}

      <div
        role="log"
        aria-live="polite"
        aria-label={t("logLabel")}
        data-testid="team-room-log"
        className="custom-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
          {isLoading && <Skeleton className="h-16 w-full rounded-xl" />}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error.message || t("loadError")}
            </p>
          )}
          {!isLoading && !error && messages.length === 0 && (
            <div
              className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground"
              data-testid="team-room-empty"
            >
              <MessagesSquareIcon className="size-8" aria-hidden />
              <p className="max-w-sm text-sm">{t("empty")}</p>
            </div>
          )}
          {messages.map((message) => (
            <TeamRoomMessageRow
              key={message.id}
              message={message}
              agents={byId}
            />
          ))}
          {[...working].map((id) => (
            <p
              key={id}
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid={`team-room-typing-${id}`}
            >
              <span
                className="size-1.5 animate-pulse rounded-full bg-primary"
                aria-hidden
              />
              {t("isWorking", { name: byId.get(id)?.name ?? t("formerAgent") })}
            </p>
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <TeamRoomComposer ref={composer} agents={agents} onSend={send} />
    </div>
  );
}
