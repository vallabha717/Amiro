"use client";

import { setAgentScope } from "@/lib/backend/agent-scope";
import { MAIN_AGENT_ID, type TeamAgent, useAgents } from "@/lib/backend/agents-api";
import { useTeamRoom } from "@/lib/backend/team-room-api";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, ArrowUpRightIcon, MessagesSquareIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Button } from "ui/button";
import { Skeleton } from "ui/skeleton";
import { AgentAvatar } from "./agent-avatar";
import { AgentChat } from "./agent-chat";
import { agentSpacePath, resolveAgentFromPathname, teamRoomPath } from "./team-paths";
import { TeamRoom } from "./team-room";

const rowClass = (active: boolean) =>
  cn(
    "flex min-w-0 shrink-0 items-center gap-3 rounded-xl px-2.5 py-2 transition-colors md:shrink",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-accent" : "hover:bg-accent/60",
  );

function AgentRow({
  agent,
  href,
  active,
  working,
}: {
  agent: TeamAgent;
  href: string;
  active: boolean;
  working: boolean;
}) {
  const t = useTranslations("TeamRoom");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      data-testid={`team-room-agent-${agent.id}`}
      data-working={working ? "true" : "false"}
      className={rowClass(active)}
    >
      <span className="relative shrink-0">
        <AgentAvatar agent={agent} size={40} animated={working} />
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-background",
            working ? "animate-pulse bg-primary" : "bg-muted-foreground/40",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{agent.name}</span>
        <span className="hidden truncate text-xs text-muted-foreground md:block">
          {working ? t("working") : agent.role || t("idle")}
        </span>
      </span>
    </Link>
  );
}

function AgentChatPane({ agent }: { agent: TeamAgent }) {
  const t = useTranslations("TeamRoom");
  const pathname = usePathname();
  const spaceAgent = resolveAgentFromPathname(pathname);
  return (
    <>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <AgentAvatar agent={agent} size={36} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold" data-testid="team-channel-title">
            {agent.name}
          </h2>
          <p className="truncate text-xs text-muted-foreground">{t("ownChat")}</p>
        </div>
        <Button asChild size="sm" variant="outline" data-testid="team-space-open-agent">
          <Link href={agentSpacePath(agent.id)}>
            <span className="hidden sm:inline">{t("openSpace", { name: agent.name })}</span>
            <span className="sr-only sm:hidden">{t("openSpace", { name: agent.name })}</span>
            <ArrowUpRightIcon className="size-4" />
          </Link>
        </Button>
      </div>
      <div className="relative min-h-0 flex-1" data-testid="team-channel">
        <AgentChat
          key={agent.channelThreadId}
          agent={agent}
          threadId={agent.channelThreadId}
          threadPath={teamRoomPath(spaceAgent, agent.id)}
        />
      </div>
    </>
  );
}

/**
 * Team inside an agent's space: every agent on the left, like the Team app.
 * "Team room" opens the shared conversation with all of them; an agent opens
 * your own chat with that agent. No Amiro sidebar — "Back to …" returns to
 * the space you came from.
 */
export function TeamSpaceView() {
  const t = useTranslations("TeamRoom");
  const pathname = usePathname();
  const selectedId = useSearchParams().get("agent");
  const spaceAgentId = resolveAgentFromPathname(pathname) ?? MAIN_AGENT_ID;
  const { data, error, isLoading } = useAgents();
  const { data: room } = useTeamRoom();
  const agents = data?.agents ?? [];
  const working = new Set(room?.working ?? []);
  const spaceAgent = agents.find((a) => a.id === spaceAgentId);
  const selected = selectedId ? agents.find((a) => a.id === selectedId) : undefined;

  useEffect(() => {
    const scope = selected?.id ?? spaceAgentId;
    setAgentScope(scope === MAIN_AGENT_ID ? null : scope);
  }, [selected, spaceAgentId]);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row" data-testid="team-space">
      <aside
        className="flex shrink-0 flex-col border-b md:w-64 md:border-b-0 md:border-r"
        aria-label={t("listLabel")}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          <Link
            href={agentSpacePath(spaceAgentId)}
            data-testid="team-space-back"
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" aria-hidden />
            {t("backTo", { name: spaceAgent?.name ?? "Amiro" })}
          </Link>
          <h1 className="text-lg font-semibold" data-testid="team-space-heading">
            {t("listTitle")}
          </h1>
        </div>
        <nav className="custom-scrollbar flex flex-1 gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-y-auto md:overflow-x-hidden">
          <Link
            href={teamRoomPath(spaceAgentId)}
            aria-current={!selected ? "page" : undefined}
            data-testid="team-room-entry"
            className={rowClass(!selected)}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <MessagesSquareIcon className="size-5" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{t("title")}</span>
              <span className="hidden truncate text-xs text-muted-foreground md:block">
                {t("roomEntrySubtitle")}
              </span>
            </span>
          </Link>
          {isLoading &&
            [0, 1].map((i) => <Skeleton key={i} className="h-12 w-40 rounded-xl md:w-full" />)}
          {error && (
            <p role="alert" className="px-2 text-sm text-destructive">
              {error.message || t("loadError")}
            </p>
          )}
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              href={teamRoomPath(spaceAgentId, agent.id)}
              active={agent.id === selected?.id}
              working={working.has(agent.id)}
            />
          ))}
        </nav>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selected ? <AgentChatPane agent={selected} /> : <TeamRoom showMembers={false} />}
      </section>
    </div>
  );
}
