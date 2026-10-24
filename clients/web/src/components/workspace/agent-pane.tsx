"use client";

import { appStore } from "@/app/store";
import { closeAgentPane } from "@/app/store/chat-ux-store";
import { backendFetch } from "@/lib/backend/client";
import { backendUrl } from "@/lib/backend/config";
import {
  type SwarmMember,
  memberName,
  openSwarmMember,
  resolveSessionIdentity,
  swarmActivity,
  useAgentTranscript,
} from "@/lib/backend/swarm-api";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { ChatApiSchemaRequestBody } from "app-types/chat";
import { summarizeSession } from "lib/chat-ux/session-summary";
import { cn, generateUUID } from "lib/utils";
import {
  ArrowUpIcon,
  BotIcon,
  CrownIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { PreviewMessage } from "../message";
import { ActivityDot } from "./session-panel";
import { TodoList } from "./todo-views";

const ACTIVITY_LABEL = {
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
} as const;

/**
 * One swarm agent, open beside the main chat -- the web version of the TUI
 * popping an agent out of the swarm strip. The main chat never leaves the
 * screen: watching an agent, or talking to it, happens here.
 *
 * Reading is free: the transcript comes from /api/swarm/transcript and needs
 * no thread. Talking binds a thread to the agent's session (once, on the
 * first send), and from then on the pane streams like any chat.
 */
export function AgentPane({
  threadId,
  member,
  coordinator,
}: {
  /** The thread the panes are open beside. */
  threadId: string;
  member: SwarmMember;
  coordinator?: boolean;
}) {
  const router = useRouter();
  const activity = swarmActivity(member);
  const { data, mutate: refresh } = useAgentTranscript(
    threadId,
    member.sessionId,
    activity === "working",
  );

  // The agent's own thread, created lazily on the first message.
  const memberThreadRef = useRef<string | null>(member.threadId ?? null);
  useEffect(() => {
    if (member.threadId) memberThreadRef.current = member.threadId;
  }, [member.threadId]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: backendUrl("/api/chat"),
        fetch: backendFetch,
        prepareSendMessagesRequest: ({ messages, body }) => {
          const state = appStore.getState();
          const body_: ChatApiSchemaRequestBody = {
            ...body,
            id: memberThreadRef.current!,
            chatModel: state.chatModel,
            toolChoice: state.toolChoice,
            permissionMode: state.permissionMode,
            // No project directory on purpose: the backend starts a fresh
            // session when the folder changes, which would detach this pane
            // from the agent it is showing.
            allowedAppDefaultToolkit: state.allowedAppDefaultToolkit,
            allowedMcpServers: state.allowedMcpServers,
            mentions: [],
            message: messages.at(-1)!,
            imageTool: {},
            attachments: [],
          } as ChatApiSchemaRequestBody;
          return { body: body_ };
        },
      }),
    [],
  );

  const { messages, setMessages, sendMessage, status, stop } = useChat({
    id: `agent-pane-${member.sessionId}`,
    transport,
    generateId: generateUUID,
    experimental_throttle: 100,
    onFinish: () => void refresh(),
  });
  const busy = status === "submitted" || status === "streaming";

  // Between our own sends, the agent works on its own (the coordinator gave
  // it a task), so the polled transcript is the truth. Never overwrite a
  // stream in flight with an older snapshot.
  useEffect(() => {
    if (!data?.messages || busy) return;
    setMessages(data.messages as UIMessage[]);
  }, [data, busy, setMessages]);

  const live = busy || activity === "working";
  const summary = useMemo(() => summarizeSession(messages, live), [messages, live]);

  // Stick to the bottom while the agent writes, unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const [input, setInput] = useState("");
  const [binding, setBinding] = useState(false);
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || binding) return;
    try {
      if (!memberThreadRef.current) {
        setBinding(true);
        memberThreadRef.current = await openSwarmMember(member.sessionId, threadId);
      }
      setInput("");
      pinned.current = true;
      await sendMessage({ role: "user", parts: [{ type: "text", text }] });
    } catch (e: any) {
      toast.error(e?.message || `Could not reach ${memberName(member)}`);
    } finally {
      setBinding(false);
    }
  }, [input, busy, binding, member, threadId, sendMessage]);

  const openFull = useCallback(async () => {
    try {
      const id = memberThreadRef.current ?? (await openSwarmMember(member.sessionId, threadId));
      router.push(`/?thread=${id}`);
    } catch (e: any) {
      toast.error(e?.message || "Could not open that agent");
    }
  }, [member.sessionId, threadId, router]);

  const name = memberName(member, coordinator);
  const { icon } = resolveSessionIdentity(member);
  const todos = summary.todos ?? [];
  const done = todos.filter((t) => t.status === "completed").length;

  return (
    <section
      data-testid="agent-pane"
      data-session-id={member.sessionId}
      className="flex h-full min-w-0 flex-col bg-background"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground text-xs">
          {icon ? (
            <span aria-hidden>{icon}</span>
          ) : coordinator ? (
            <CrownIcon className="size-3.5" />
          ) : (
            <BotIcon className="size-3.5" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{name}</span>
            <ActivityDot activity={busy ? "working" : activity} />
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {ACTIVITY_LABEL[busy ? "working" : activity]}
            {todos.length ? ` · ${done}/${todos.length} tasks` : ""}
            {member.title && member.title !== member.label ? ` · ${member.title}` : ""}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" onClick={openFull} aria-label="Open as full chat">
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open as full chat</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => closeAgentPane(threadId, member.sessionId)}
              aria-label={`Close ${name}`}
              data-testid="agent-pane-close"
            >
              <XIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close pane</TooltipContent>
        </Tooltip>
      </header>

      {todos.length > 0 && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-b border-border bg-muted/20 px-3 py-2">
          <TodoList todos={todos} live={summary.todosLive} limit={8} />
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto py-3 [&_[data-message-id]]:px-3"
      >
        {!data && !messages.length ? (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            <Loader2Icon className="mr-2 size-3.5 animate-spin" /> Loading {name}…
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
            {name} hasn't written anything yet.
          </div>
        ) : (
          messages.map((m, i) => (
            <PreviewMessage
              key={m.id}
              threadId={memberThreadRef.current ?? undefined}
              message={m}
              prevMessage={messages[i - 1]}
              isLastMessage={i === messages.length - 1}
              isLoading={live && i === messages.length - 1}
              status={status}
              readonly
            />
          ))
        )}
      </div>

      <form
        className="shrink-0 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-1.5 rounded-xl border border-border bg-muted/30 px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={`Message ${name}…`}
            className="max-h-32 min-h-[1.75rem] flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
            data-testid="agent-pane-input"
          />
          {busy ? (
            <Button type="button" size="icon" variant="ghost" className="size-7" onClick={() => stop()} aria-label="Stop">
              <SquareIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              className={cn("size-7 rounded-lg", !input.trim() && "opacity-50")}
              disabled={!input.trim() || binding}
              aria-label={`Send to ${name}`}
            >
              {binding ? <Loader2Icon className="size-3.5 animate-spin" /> : <ArrowUpIcon className="size-3.5" />}
            </Button>
          )}
        </div>
        <p className="px-1 pt-1 text-[10px] text-muted-foreground">
          Goes straight to {name}; your main chat is unaffected.
        </p>
      </form>
    </section>
  );
}
