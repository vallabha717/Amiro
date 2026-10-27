"use client";

import { setAgentScope } from "@/lib/backend/agent-scope";
import {
  MAIN_AGENT_ID,
  type TeamAgent,
  useAgents,
} from "@/lib/backend/agents-api";
import { type TeamRoomMessage, useTeamRoom } from "@/lib/backend/team-room-api";
import { cn } from "@/lib/utils";
import { MessagesSquareIcon, UserRoundIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { Button } from "ui/button";
import { Skeleton } from "ui/skeleton";
import { AgentAvatar } from "./agent-avatar";
import { AgentChat } from "./agent-chat";
import {
  resolveAgentFromPathname,
  TEAM_WITH_YOU,
  teamRoomPath,
} from "./team-paths";
import { TeamRoom } from "./team-room";
import { TeamRoomMessageRow } from "./team-room-message";
import { pairMessages } from "./team-room-pairs";

const rowClass = (active: boolean) =>
  cn(
    "flex min-w-0 shrink-0 items-center gap-3 rounded-xl px-2.5 py-2 transition-colors md:shrink",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-accent" : "hover:bg-accent/60",
  );

function Row({
  href,
  active,
  icon,
  title,
  subtitle,
  testId,
  working,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  testId: string;
  working?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      data-testid={testId}
      data-working={
        working === undefined ? undefined : working ? "true" : "false"
      }
      className={rowClass(active)}
    >
      <span className="relative shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="hidden truncate text-xs text-muted-foreground md:block">
          {subtitle}
        </span>
      </span>
    </Link>
  );
}

function StatusDot({ working }: { working: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-background",
        working ? "animate-pulse bg-primary" : "bg-muted-foreground/40",
      )}
    />
  );
}

function PaneHeader({
  title,
  subtitle,
  children,
}: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3">
      {children}
      <div className="min-w-0 flex-1">
        <h2
          className="truncate text-sm font-semibold"
          data-testid="team-channel-title"
        >
          {title}
        </h2>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

/** Your own chat with the agent whose space this is. */
function YouPane({ me }: { me: TeamAgent }) {
  const t = useTranslations("TeamRoom");
  return (
    <>
      <PaneHeader
        title={t("youAnd", { name: me.name })}
        subtitle={t("ownChat")}
      >
        <AgentAvatar agent={me} size={36} />
      </PaneHeader>
      <div className="relative min-h-0 flex-1" data-testid="team-channel">
        <AgentChat
          key={me.channelThreadId}
          agent={me}
          threadId={me.channelThreadId}
          threadPath={teamRoomPath(me.id, TEAM_WITH_YOU)}
        />
      </div>
    </>
  );
}

/** What the space's agent and one teammate said to each other in the room. */
function PairPane({
  me,
  other,
  messages,
  agents,
}: {
  me: TeamAgent;
  other: TeamAgent;
  messages: TeamRoomMessage[];
  agents: Map<string, TeamAgent>;
}) {
  const t = useTranslations("TeamRoom");
  const pair = useMemo(
    () => pairMessages(messages, me.id, other.id),
    [messages, me.id, other.id],
  );
  return (
    <>
      <PaneHeader
        title={t("pairTitle", { a: me.name, b: other.name })}
        subtitle={t("pairSubtitle")}
      >
        <span className="flex -space-x-2">
          <AgentAvatar agent={me} size={32} />
          <AgentAvatar agent={other} size={32} />
        </span>
      </PaneHeader>
      <div
        role="log"
        aria-label={t("pairTitle", { a: me.name, b: other.name })}
        data-testid="team-pair-log"
        className="custom-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4">
          {pair.length === 0 ? (
            <div
              className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground"
              data-testid="team-pair-empty"
            >
              <MessagesSquareIcon className="size-8" aria-hidden />
              <p className="max-w-sm text-sm">
                {t("pairEmpty", { a: me.name, b: other.name })}
              </p>
              <Button asChild size="sm" variant="outline">
                <Link href={teamRoomPath(me.id)}>{t("openRoom")}</Link>
              </Button>
            </div>
          ) : (
            pair.map((message) => (
              <TeamRoomMessageRow
                key={message.id}
                message={message}
                agents={agents}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Team inside an agent's space, in the main window beside the Amiro sidebar,
 * seen from that agent: the Team room, your own chat with it, and each
 * teammate — opening what this agent and that teammate said to each other.
 */
export function TeamSpaceView() {
  const t = useTranslations("TeamRoom");
  const pathname = usePathname();
  const withId = useSearchParams().get("with");
  const spaceAgentId = resolveAgentFromPathname(pathname) ?? MAIN_AGENT_ID;
  const { data, error, isLoading } = useAgents();
  const { data: room } = useTeamRoom();
  const agents = data?.agents ?? [];
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const working = new Set(room?.working ?? []);
  const me = byId.get(spaceAgentId);
  const teammates = agents.filter((a) => a.id !== spaceAgentId);
  const other =
    withId && withId !== TEAM_WITH_YOU ? byId.get(withId) : undefined;
  const showYou = withId === TEAM_WITH_YOU && me;

  useEffect(() => {
    setAgentScope(spaceAgentId === MAIN_AGENT_ID ? null : spaceAgentId);
  }, [spaceAgentId]);

  return (
    <div
      className="flex h-full min-h-0 flex-col md:flex-row"
      data-testid="team-space"
    >
      <aside
        className="flex shrink-0 flex-col border-b md:w-64 md:border-b-0 md:border-r"
        aria-label={t("listLabel")}
      >
        <div className="px-4 pt-4 pb-2">
          <h1
            className="text-lg font-semibold"
            data-testid="team-space-heading"
          >
            {t("listTitle")}
          </h1>
        </div>
        <nav className="custom-scrollbar flex flex-1 gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-y-auto md:overflow-x-hidden">
          <Row
            href={teamRoomPath(spaceAgentId)}
            active={!withId}
            testId="team-room-entry"
            title={t("title")}
            subtitle={t("roomEntrySubtitle")}
            icon={
              <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <MessagesSquareIcon className="size-5" aria-hidden />
              </span>
            }
          />
          {me && (
            <Row
              href={teamRoomPath(spaceAgentId, TEAM_WITH_YOU)}
              active={withId === TEAM_WITH_YOU}
              testId="team-with-you"
              title={t("you")}
              subtitle={t("youWith", { name: me.name })}
              icon={
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <UserRoundIcon className="size-5" aria-hidden />
                </span>
              }
            />
          )}
          {isLoading &&
            [0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-40 rounded-xl md:w-full" />
            ))}
          {error && (
            <p role="alert" className="px-2 text-sm text-destructive">
              {error.message || t("loadError")}
            </p>
          )}
          {teammates.map((agent) => (
            <Row
              key={agent.id}
              href={teamRoomPath(spaceAgentId, agent.id)}
              active={agent.id === other?.id}
              testId={`team-room-agent-${agent.id}`}
              working={working.has(agent.id)}
              title={agent.name}
              subtitle={
                working.has(agent.id) ? t("working") : agent.role || t("idle")
              }
              icon={
                <>
                  <AgentAvatar
                    agent={agent}
                    size={40}
                    animated={working.has(agent.id)}
                  />
                  <StatusDot working={working.has(agent.id)} />
                </>
              }
            />
          ))}
        </nav>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {showYou ? (
          <YouPane me={me} />
        ) : me && other ? (
          <PairPane
            me={me}
            other={other}
            messages={room?.messages ?? []}
            agents={byId}
          />
        ) : (
          <TeamRoom showMembers={false} />
        )}
      </section>
    </div>
  );
}
