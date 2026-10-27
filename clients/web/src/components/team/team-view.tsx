"use client";

import { setAgentScope } from "@/lib/backend/agent-scope";
import {
  AGENTS_KEY,
  type TeamAgent,
  deleteAgent,
  useAgents,
} from "@/lib/backend/agents-api";
import { useSession } from "@/lib/backend/session-context";
import { cn } from "@/lib/utils";
import {
  ArrowUpRightIcon,
  MessagesSquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "ui/alert-dialog";
import { Button } from "ui/button";
import { Skeleton } from "ui/skeleton";
import { AgentAvatar } from "./agent-avatar";
import { AgentChat } from "./agent-chat";
import { AssistantDesktopAffordance } from "@/components/desktop-preview/assistant-desktop-affordance";
import { TEAM_HUDDLE_PATH, agentSpacePath, teamThreadPath } from "./team-paths";
import { TeamRoom } from "./team-room";

function AgentRow({ agent, active }: { agent: TeamAgent; active: boolean }) {
  const t = useTranslations("Team");
  return (
    <Link
      href={teamThreadPath(agent.id)}
      aria-current={active ? "page" : undefined}
      data-testid={`team-agent-${agent.id}`}
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-3 rounded-xl px-2.5 py-2 transition-colors md:shrink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <AgentAvatar agent={agent} size={40} />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5 text-sm font-medium">
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

function DeleteAgentButton({ agent }: { agent: TeamAgent }) {
  const t = useTranslations("Team");
  const router = useRouter();
  const remove = async () => {
    try {
      await deleteAgent(agent.id);
      await mutate(AGENTS_KEY);
      toast.success(t("deleted", { name: agent.name }));
      router.push("/team");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("deleteError"));
    }
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive"
          aria-label={t("deleteTitle", { name: agent.name })}
          data-testid="agent-delete"
        >
          <Trash2Icon className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteTitle", { name: agent.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={remove} data-testid="agent-delete-confirm">
            {t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ThreadHeader({ agent, isOwner }: { agent: TeamAgent; isOwner: boolean }) {
  const t = useTranslations("Team");
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3">
      <AgentAvatar agent={agent} size={36} />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold" data-testid="team-channel-title">
          {agent.name}
        </h2>
        <p className="truncate text-xs text-muted-foreground">{t("channelSubtitle")}</p>
      </div>
      {isOwner && (
        <AssistantDesktopAffordance
          agentId={agent.id}
          agentName={agent.name}
        />
      )}
      {!agent.isMain && isOwner && <DeleteAgentButton agent={agent} />}
      <Button asChild size="sm" data-testid="team-open-in-amiro">
        <Link href={agentSpacePath(agent.id)}>
          <span className="hidden sm:inline">{t("openInAmiro", { name: agent.name })}</span>
          <span className="sr-only sm:hidden">{t("openInAmiro", { name: agent.name })}</span>
          <ArrowUpRightIcon className="size-4" />
        </Link>
      </Button>
    </div>
  );
}

function PickAnAgent() {
  const t = useTranslations("Team");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
      <MessagesSquareIcon className="size-8" />
      <p className="text-sm" data-testid="team-pick-agent">
        {t("pickAgent")}
      </p>
    </div>
  );
}

/**
 * The Team app: every agent on the left; clicking one opens its fixed Team
 * thread on the right. "Open <name>" takes you to that agent's own space —
 * the full Amiro app, acting as that agent.
 */
export function TeamView() {
  const t = useTranslations("Team");
  const tRoom = useTranslations("TeamRoom");
  const searchParams = useSearchParams();
  const huddle = searchParams.get("view") === "huddle";
  const selectedId = searchParams.get("agent");
  const { data: session } = useSession();
  const isOwner = session?.user.role === "admin";
  const { data, error, isLoading } = useAgents();
  const agents = data?.agents ?? [];
  const selected = huddle
    ? null
    : (agents.find((agent) => agent.id === selectedId) ??
      (!selectedId && agents.length > 0 ? agents.find((a) => a.isMain) || agents[0] : null));

  useEffect(() => {
    if (selected) {
      setAgentScope(selected.id);
    } else {
      setAgentScope(null);
    }
  }, [selected]);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside
        className="flex shrink-0 flex-col border-b md:w-64 md:border-b-0 md:border-r"
        aria-label={t("listLabel")}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold" data-testid="team-heading">
              {t("title")}
            </h1>
            <p className="hidden text-xs text-muted-foreground md:block">{t("subtitle")}</p>
          </div>
        </div>
        <nav className="custom-scrollbar flex flex-1 gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-y-auto md:overflow-x-hidden">
          {isLoading &&
            [0, 1].map((i) => <Skeleton key={i} className="h-12 w-40 rounded-xl md:w-full" />)}
          {error && (
            <p role="alert" className="px-2 text-sm text-destructive">
              {error.message || t("loadError")}
            </p>
          )}
          <Link
            href={TEAM_HUDDLE_PATH}
            aria-current={huddle ? "page" : undefined}
            data-testid="team-huddle-entry"
            className={cn(
              "flex min-w-0 shrink-0 items-center gap-3 rounded-xl px-2.5 py-2 transition-colors md:shrink",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              huddle ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <MessagesSquareIcon className="size-5" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{tRoom("title")}</span>
              <span className="hidden truncate text-xs text-muted-foreground md:block">
                {tRoom("roomEntrySubtitle")}
              </span>
            </span>
          </Link>
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} active={agent.id === selected?.id} />
          ))}
        </nav>
      </aside>

      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        aria-label={
          huddle ? tRoom("title") : selected ? t("channelLabel", { name: selected.name }) : undefined
        }
      >
        {huddle ? (
          <TeamRoom showMembers={false} showManage={false} />
        ) : selected ? (
          <>
            <ThreadHeader agent={selected} isOwner={isOwner} />
            <div className="relative min-h-0 flex-1" data-testid="team-channel">
              <AgentChat
                key={selected.channelThreadId}
                agent={selected}
                threadId={selected.channelThreadId}
                threadPath={teamThreadPath(selected.id)}
              />
            </div>
          </>
        ) : (
          <PickAnAgent />
        )}
      </section>
    </div>
  );
}
