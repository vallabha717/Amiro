"use client";

import { PreviewMessage } from "@/components/message";
import { chatUxStore, openAgentPane } from "@/app/store/chat-ux-store";
import {
  type SwarmActivity,
  type SwarmMember,
  memberName,
  swarmActivity,
  useAgentTranscript,
  useSwarm,
} from "@/lib/backend/swarm-api";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { summarizeSession, type SpawnedAgent } from "lib/chat-ux/session-summary";
import { cn } from "lib/utils";
import { AnimatePresence, motion } from "framer-motion";
import { BotIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { ActivityDot } from "./session-panel";
import { TodoList } from "./todo-views";

const ACTIVITY_LABEL: Record<SwarmActivity, string> = {
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
};

const TAIL_MESSAGES = 2;

/** Same merge as agent-switcher: backend list first, transcript spawns fill the gap. */
function useStripMembers(threadId: string, isRunning: boolean, spawned?: SpawnedAgent[]) {
  const { data } = useSwarm(threadId, isRunning);
  return useMemo<SwarmMember[]>(() => {
    const live = data?.members ?? [];
    const known = new Set(live.map((m) => m.sessionId));
    const fromTranscript: SwarmMember[] = (spawned ?? [])
      .filter((s) => !s.sessionId || !known.has(s.sessionId))
      .map((s) => ({
        sessionId: s.sessionId ?? s.toolCallId,
        label: s.label,
        swarmStatus: s.state === "failed" ? "failed" : s.state === "spawning" ? "spawned" : "running",
        userConnected: false,
      }));
    return [...live, ...fromTranscript];
  }, [data, spawned]);
}

/** Wrap-around step through the member list; -1 when there is nothing to pick. */
function cycle(index: number, delta: number, len: number) {
  if (len === 0) return -1;
  if (index < 0) return delta > 0 ? 0 : len - 1;
  return (index + delta + len) % len;
}

// Linux/Windows layouts turn Alt+letter into dead or special chars, so match
// the physical key (e.code) rather than e.key.
function isAlt(e: KeyboardEvent, code: string) {
  return e.altKey && !e.ctrlKey && !e.metaKey && e.code === code;
}

/** Per-member transcript (polled) and the todos derived from it. */
function useMemberView(threadId: string, m: SwarmMember, enabled: boolean) {
  const activity = swarmActivity(m);
  // SWR dedupes by key, so a chip and its open peek share one poll.
  const { data } = useAgentTranscript(
    enabled ? threadId : undefined,
    m.sessionId,
    activity === "working",
  );
  const messages = data?.messages;
  const todos = useMemo(
    () => (messages ? summarizeSession(messages, activity === "working").todos : undefined),
    [messages, activity],
  );
  const done = todos?.filter((t) => t.status === "completed").length ?? 0;
  return { activity, messages, todos, done };
}

function Chip({
  threadId,
  member,
  selected,
  open,
  onSelect,
}: {
  threadId: string;
  member: SwarmMember;
  selected: boolean;
  open: boolean;
  onSelect: () => void;
}) {
  const { activity, todos, done } = useMemberView(threadId, member, true);
  const name = memberName(member);
  // title doubles as the name fallback; only show it as a task when distinct.
  const task = member.title && member.title !== name ? member.title : undefined;
  return (
    <div
      className={cn(
        "group relative flex shrink-0 items-center rounded-full border text-xs transition-colors",
        selected
          ? "border-ring/60 bg-accent text-foreground"
          : open
            ? "border-border bg-muted/60 text-foreground"
            : "border-border bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      <button
        type="button"
        role="option"
        aria-selected={selected}
        aria-pressed={selected}
        aria-label={`${name}, ${ACTIVITY_LABEL[activity]}${todos ? `, ${done} of ${todos.length} todos done` : ""}`}
        onClick={onSelect}
        className="flex items-center gap-1.5 rounded-full py-1 pl-2.5 pr-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:pr-7 group-focus-within:pr-7"
      >
        <ActivityDot activity={activity} />
        <span className="max-w-32 truncate font-medium text-foreground">{name}</span>
        {task && <span className="max-w-40 truncate text-muted-foreground/70">{task}</span>}
        {todos && todos.length > 0 && (
          <span className="tabular-nums text-muted-foreground">
            {done}/{todos.length}
          </span>
        )}
        {open && !selected && <span className="size-1 rounded-full bg-muted-foreground/60" title="Open in a pane" />}
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Pop out ${name}`}
            onClick={() => openAgentPane(threadId, member.sessionId)}
            className="absolute right-1 hidden size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:flex group-focus-within:flex"
          >
            <ExternalLinkIcon className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Pop out (Alt+O)</TooltipContent>
      </Tooltip>
    </div>
  );
}

function Peek({
  threadId,
  member,
  onPopOut,
  onClose,
}: {
  threadId: string;
  member: SwarmMember;
  onPopOut: () => void;
  onClose: () => void;
}) {
  const { activity, messages, todos } = useMemberView(threadId, member, true);
  const tail = useMemo(() => (messages ?? []).slice(-TAIL_MESSAGES), [messages]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Stick to the bottom so the newest output stays visible while it streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="rounded-2xl border border-border bg-background/95 shadow-xs backdrop-blur">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <BotIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">{memberName(member)}</span>
        <ActivityDot activity={activity} />
        <span className="text-muted-foreground">{ACTIVITY_LABEL[activity]}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onPopOut}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Pop out <ExternalLinkIcon className="size-3" />
          <kbd className="ml-0.5 text-[10px] opacity-60">Alt+O</kbd>
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close agent peek"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <XIcon className="size-3" />
          <kbd className="text-[10px] opacity-60">Esc</kbd>
        </button>
      </div>
      <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_14rem]">
        <div ref={scrollRef} className="max-h-72 min-w-0 overflow-y-auto" aria-live="off">
          {tail.length === 0 ? (
            <p className="text-xs text-muted-foreground">No output yet.</p>
          ) : (
            tail.map((message, i) => (
              <PreviewMessage
                key={message.id}
                message={message}
                prevMessage={tail[i - 1]}
                threadId={threadId}
                readonly
                isLastMessage={i === tail.length - 1}
                isLoading={activity === "working" && i === tail.length - 1}
              />
            ))
          )}
        </div>
        <div className="min-w-0 max-h-72 overflow-y-auto md:border-l md:border-border md:pl-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">Todos</div>
          {todos && todos.length > 0 ? (
            <TodoList todos={todos} live={activity === "working"} limit={8} />
          ) : (
            <p className="text-xs text-muted-foreground">No todos.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function SwarmStrip({
  threadId,
  isRunning,
  spawned,
}: {
  threadId: string;
  isRunning: boolean;
  spawned?: SpawnedAgent[];
}) {
  const members = useStripMembers(threadId, isRunning, spawned);
  const reduced = usePrefersReducedMotion();
  const openPanes = chatUxStore((s) => s.agentPanesByThread[threadId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  const hasMembers = members.length > 0;
  const selectedIndex = members.findIndex((m) => m.sessionId === selectedId);
  const selected = selectedIndex >= 0 ? members[selectedIndex] : null;
  const working = members.filter((m) => swarmActivity(m) === "working").length;

  // Refs so the window listener is bound once per hasMembers flip, not per poll.
  const stateRef = useRef({ members, selectedIndex, focused });
  stateRef.current = { members, selectedIndex, focused };

  const popOut = useCallback(
    (m: SwarmMember) => openAgentPane(threadId, m.sessionId),
    [threadId],
  );

  useEffect(() => {
    if (!hasMembers) return;
    const onKey = (e: KeyboardEvent) => {
      const { members, selectedIndex, focused } = stateRef.current;
      if (isAlt(e, "KeyN")) {
        e.preventDefault();
        if (focused) return setFocused(false);
        const i = selectedIndex >= 0 ? selectedIndex : 0;
        setSelectedId(members[i]?.sessionId ?? null);
        return setFocused(true);
      }
      // Everything below is only claimed while focused; plain typing and
      // Esc in the composer must pass through untouched otherwise.
      if (!focused) return;
      if (e.key === "Escape") {
        e.preventDefault();
        return setFocused(false);
      }
      if (isAlt(e, "KeyO")) {
        e.preventDefault();
        const m = members[selectedIndex];
        if (m) popOut(m);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const delta =
          e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1
          : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1
          : 0;
        if (!delta) return;
        e.preventDefault();
        setSelectedId(members[cycle(selectedIndex, delta, members.length)]?.sessionId ?? null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasMembers, popOut]);

  // A member that vanished from the list must not leave an empty peek open.
  useEffect(() => {
    if (focused && !selected) setFocused(false);
  }, [focused, selected]);

  // A normal chat has no swarm; leave it looking exactly as before.
  if (!hasMembers) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
      <AnimatePresence initial={false}>
        {focused && selected && (
          <motion.div
            key="peek"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <Peek
              threadId={threadId}
              member={selected}
              onPopOut={() => popOut(selected)}
              onClose={() => setFocused(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <div
        role="listbox"
        aria-label="Swarm agents"
        aria-orientation="horizontal"
        className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]"
      >
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          Swarm · {working} working
        </span>
        {members.map((m) => (
          <Chip
            key={m.sessionId}
            threadId={threadId}
            member={m}
            selected={focused && m.sessionId === selectedId}
            open={openPanes?.includes(m.sessionId) ?? false}
            onSelect={() => {
              if (focused && m.sessionId === selectedId) return setFocused(false);
              setSelectedId(m.sessionId);
              setFocused(true);
            }}
          />
        ))}
        <kbd className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground/60">Alt+N</kbd>
      </div>
    </div>
  );
}
