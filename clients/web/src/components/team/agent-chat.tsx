"use client";

import ChatBot from "@/components/chat-bot";
import type { TeamAgent } from "@/lib/backend/agents-api";
import { MAIN_AGENT_ID } from "@/lib/backend/agents-api";
import type { UIMessage } from "ai";
import { fetcher } from "lib/utils";
import { useTranslations } from "next-intl";
import useSWR from "swr";
import { AgentAvatar } from "./agent-avatar";

/** What an empty chat with a team agent shows instead of the main greeting. */
export function AgentChatIntro({ agent }: { agent: TeamAgent }) {
  const t = useTranslations("Team");
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 text-center">
      <AgentAvatar agent={agent} size={88} animated />
      <h2 className="text-xl font-semibold">
        {t("introTitle", { name: agent.name })}
      </h2>
      <p className="text-sm text-muted-foreground">
        {agent.role || t("introFallback")}
      </p>
    </div>
  );
}

/**
 * One conversation with an agent, streamed through the shared chat pipeline.
 * `threadId` is the agent's channel or one of its other chats; the backend
 * keeps the agent's working folder from the thread entry.
 */
export function AgentChat({
  agent,
  threadId,
  threadPath,
  isNew = false,
}: {
  agent: TeamAgent;
  threadId: string;
  threadPath: string;
  /** A thread that does not exist on the server yet: nothing to load. */
  isNew?: boolean;
}) {
  const { data, isLoading } = useSWR<{ messages: UIMessage[] }>(
    isNew ? null : `/api/thread/${threadId}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const t = useTranslations("Team");
  if (!isNew && (isLoading || !data)) return null;
  const isMain = agent.id === MAIN_AGENT_ID;
  return (
    <ChatBot
      key={threadId}
      threadId={threadId}
      initialMessages={data?.messages ?? []}
      agentId={isMain ? undefined : agent.id}
      threadPath={threadPath}
      emptyState={<AgentChatIntro agent={agent} />}
      workspaceLabel={isMain ? undefined : t("ownFolder", { name: agent.name })}
    />
  );
}
