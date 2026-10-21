"use client";

import { agentPagePath, useAgent } from "@/lib/backend/agents-api";
import { generateUUID } from "lib/utils";
import { ArrowLeftIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { AgentAvatar } from "./agent-avatar";
import { AgentChat } from "./agent-chat";

/**
 * A chat with a team agent other than its channel. A missing `thread` starts a
 * new one; once its first message is sent the URL names it, and this instance
 * keeps rendering instead of reloading mid-stream (same rule as the home page).
 */
export function AgentChatPage() {
  const t = useTranslations("Team");
  const searchParams = useSearchParams();
  const agentId = searchParams.get("agent");
  const threadParam = searchParams.get("thread");
  const newId = useMemo(() => generateUUID(), []);
  const { data: agent, error } = useAgent(agentId);

  if (error || !agentId) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">{t("notFound")}</h1>
        <Link href="/team" className="mt-3 inline-block text-sm underline">
          {t("backToTeam")}
        </Link>
      </div>
    );
  }
  if (!agent) return null;

  const isNew = !threadParam || threadParam === newId;
  const threadId = isNew ? newId : threadParam;
  const threadPath = `/team/chat?agent=${encodeURIComponent(agent.id)}&thread=${encodeURIComponent(threadId)}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Link
          href={agentPagePath(agent.id)}
          aria-label={t("backToAgent", { name: agent.name })}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
        </Link>
        <AgentAvatar agent={agent} size={32} />
        <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
      </div>
      <div className="relative min-h-0 flex-1">
        <AgentChat
          key={threadId}
          agent={agent}
          threadId={threadId}
          threadPath={threadPath}
          isNew={isNew}
        />
      </div>
    </div>
  );
}
