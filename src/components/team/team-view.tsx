"use client";

import {
  MAIN_AGENT_ID,
  type TeamAgent,
  agentPagePath,
  teamPath,
  useAgents,
} from "@/lib/backend/agents-api";
import { useSession } from "@/lib/backend/session-context";
import { cn } from "@/lib/utils";
import { PlusIcon, UserRoundCogIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "ui/button";
import { Skeleton } from "ui/skeleton";
import { AgentAvatar } from "./agent-avatar";
import { AgentChat } from "./agent-chat";

function AgentRow({ agent, active }: { agent: TeamAgent; active: boolean }) {
  const t = useTranslations("Team");
  return (
    <Link
      href={teamPath(agent.id)}
      aria-current={active ? "page" : undefined}
      data-testid={`team-agent-${agent.id}`}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-3 rounded-xl px-2.5 py-2 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent" : "hover:bg-accent/60",
        "md:shrink",
      )}
    >
      <AgentAvatar agent={agent} size={40} />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">{agent.name}</span>
          {agent.isMain && (
            <span className="rounded-full border px-1.5 text-[10px] font-normal text-muted-foreground">
              {t("mainBadge")}
            </span>
          )}
        </span>
        <span className="hidden truncate text-xs text-muted-foreground md:block">
          {agent.role || t("noRole")}
        </span>
      </span>
    </Link>
  );
}

function ChannelHeader({ agent }: { agent: TeamAgent }) {
  const t = useTranslations("Team");
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3">
      <AgentAvatar agent={agent} size={36} />
      <div className="min-w-0 flex-1">
        <h2
          className="truncate text-sm font-semibold"
          data-testid="team-channel-title"
        >
          {agent.name}
        </h2>
        <p className="truncate text-xs text-muted-foreground">
          {t("channelSubtitle")}
        </p>
      </div>
      <Button
        asChild
        variant="outline"
        size="sm"
        data-testid="team-open-agent"
      >
        <Link href={agentPagePath(agent.id)}>
          <UserRoundCogIcon className="size-4" />
          <span className="hidden sm:inline">{t("openAgent")}</span>
          <span className="sr-only sm:hidden">{t("openAgent")}</span>
        </Link>
      </Button>
    </div>
  );
}

/**
 * The Team view: every agent on the left, the selected agent's channel on
 * the right. Like a direct message, the channel is always there and keeps
 * its history; other chats with the agent live on its page.
 */
export function TeamView() {
  const t = useTranslations("Team");
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("agent") || MAIN_AGENT_ID;
  const { data: session } = useSession();
  const isOwner = session?.user.role === "admin";
  const { data, error, isLoading } = useAgents();
  const agents = data?.agents ?? [];
  const selected =
    agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside
        className="flex shrink-0 flex-col border-b md:w-72 md:border-b-0 md:border-r"
        aria-label={t("listLabel")}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold" data-testid="team-heading">
              {t("title")}
            </h1>
            <p className="hidden text-xs text-muted-foreground md:block">
              {t("subtitle")}
            </p>
          </div>
          {isOwner && (
            <Button asChild size="sm" data-testid="team-new-agent">
              <Link href="/team/new">
                <PlusIcon className="size-4" />
                {t("newAgent")}
              </Link>
            </Button>
          )}
        </div>
        <nav className="custom-scrollbar flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-y-auto md:overflow-x-hidden">
          {isLoading &&
            [0, 1].map((i) => (
              <Skeleton key={i} className="h-12 w-40 rounded-xl md:w-full" />
            ))}
          {error && (
            <p role="alert" className="px-2 text-sm text-destructive">
              {error.message || t("loadError")}
            </p>
          )}
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              active={agent.id === selected?.id}
            />
          ))}
        </nav>
      </aside>

      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        aria-label={selected ? t("channelLabel", { name: selected.name }) : undefined}
      >
        {selected && (
          <>
            <ChannelHeader agent={selected} />
            <div className="relative min-h-0 flex-1" data-testid="team-channel">
              <AgentChat
                key={selected.channelThreadId}
                agent={selected}
                threadId={selected.channelThreadId}
                threadPath={teamPath(selected.id)}
              />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
