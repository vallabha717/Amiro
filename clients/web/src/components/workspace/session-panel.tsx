"use client";

import {
  type SessionPanelSection,
  chatUxStore,
  toggleAgentPane,
  toggleIn,
} from "@/app/store/chat-ux-store";
import { useComposioConfig } from "@/hooks/queries/use-composio";
import type { ComposioConnection } from "@/lib/backend/composio-api";
import { fetcher } from "@/lib/backend/client";
import useSWR from "swr";
import { useMcpList } from "@/hooks/queries/use-mcp-list";
import {
  type SwarmActivity,
  type SwarmMember,
  memberName,
  resolveSessionIdentity,
  swarmActivity,
  useSwarm,
} from "@/lib/backend/swarm-api";
import type { InlineImage } from "lib/chat-ux/inline-images";
import type {
  SessionContext,
  SessionSummary,
} from "lib/chat-ux/session-summary";
import { TOOL_CATEGORIES } from "lib/chat-ux/tool-categories";
import { cn } from "lib/utils";
import {
  BotIcon,
  ChevronDownIcon,
  CrownIcon,
  FileCode2Icon,
  ImageIcon,
  Columns2Icon,
  PanelRightCloseIcon,
  PlugIcon,
} from "lucide-react";
import {
  type ReactNode,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/shallow";
import { Button } from "ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { ImageLightbox } from "./inline-images";
import { CATEGORY_ICON } from "./tool-filter-menu";
import { TodoList } from "./todo-views";

/**
 * The right-hand panel, modeled on Claude Code desktop's: stacked cards for
 * who is working, what is left, how full the context is, which connectors
 * are wired up, and what the session produced. Every card collapses, and
 * the collapsed set persists, so a user who never looks at Context does not
 * have to close it on every thread.
 */
export const SessionPanel = memo(function SessionPanel({
  threadId,
  summary,
  isRunning,
}: {
  threadId: string;
  summary: SessionSummary;
  isRunning: boolean;
}) {
  const mutate = chatUxStore((s) => s.mutate);
  return (
    <aside
      data-testid="session-panel"
      className="relative z-40 flex h-full w-[300px] shrink-0 flex-col gap-2 overflow-y-auto border-l border-border/60 bg-background p-2.5 [scrollbar-width:thin]"
    >
      <div className="flex items-center justify-between px-1 pb-0.5">
        <span className="text-xs font-medium text-muted-foreground">
          Session
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => mutate({ panelOpen: false })}
          aria-label="Hide session panel"
        >
          <PanelRightCloseIcon className="size-3.5" />
        </Button>
      </div>
      <AgentsCard threadId={threadId} summary={summary} isRunning={isRunning} />
      {summary.todos && summary.todos.length > 0 && (
        <Card id="tasks" title="Tasks" meta={todoMeta(summary)}>
          <TodoList todos={summary.todos} live={summary.todosLive} limit={12} />
        </Card>
      )}
      <ContextCard
        threadId={threadId}
        summary={summary}
        isRunning={isRunning}
      />
      <ConnectorsCard summary={summary} />
      <OutputsCard summary={summary} />
    </aside>
  );
});

function todoMeta(s: SessionSummary) {
  const t = s.todos ?? [];
  const done = t.filter((x) => x.status === "completed").length;
  return `${done}/${t.length}`;
}

function Card({
  id,
  title,
  meta,
  children,
  action,
}: {
  id: SessionPanelSection;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  const [collapsed, mutate] = chatUxStore(
    useShallow((s) => [s.collapsedSections.includes(id), s.mutate]),
  );
  return (
    <section
      data-testid={`session-card-${id}`}
      className="rounded-xl border border-border bg-background shadow-xs"
    >
      <div className="flex items-center gap-1 px-3 py-2">
        <button
          type="button"
          onClick={() =>
            mutate((s) => ({
              collapsedSections: toggleIn(s.collapsedSections, id),
            }))
          }
          className="flex flex-1 items-center gap-1.5 text-left text-sm font-medium"
          aria-expanded={!collapsed}
        >
          {title}
          <ChevronDownIcon
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-200",
              collapsed && "-rotate-90",
            )}
          />
        </button>
        {meta != null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {meta}
          </span>
        )}
        {action}
      </div>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-[var(--ease-out)]",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

const ACTIVITY_STYLE: Record<SwarmActivity, { dot: string; label: string }> = {
  working: { dot: "bg-emerald-500", label: "Working" },
  waiting: { dot: "bg-amber-500", label: "Waiting" },
  done: { dot: "bg-sky-500", label: "Done" },
  failed: { dot: "bg-destructive", label: "Failed" },
  idle: { dot: "bg-muted-foreground/40", label: "Idle" },
};

export function ActivityDot({
  activity,
  className,
}: { activity: SwarmActivity; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {activity === "working" && (
        <span className="absolute inset-0 rounded-full bg-emerald-500/60 animate-ping" />
      )}
      <span
        className={cn(
          "relative size-2 rounded-full",
          ACTIVITY_STYLE[activity].dot,
        )}
      />
    </span>
  );
}

function AgentsCard({
  threadId,
  summary,
  isRunning,
}: {
  threadId: string;
  summary: SessionSummary;
  isRunning: boolean;
}) {
  const { data } = useSwarm(threadId, isRunning);
  // Subscribed before any early return: hooks must run the same number of
  // times on every render, and this card returns null until a swarm exists.
  const openPanes = chatUxStore((s) => s.agentPanesByThread[threadId]);

  // The backend list is the truth when it has one; spawn calls in the
  // transcript fill in for agents it has not reported yet (and for a
  // backend without the swarm route), so a just-spawned agent shows up the
  // moment its call lands rather than on the next poll.
  const members = useMemo<SwarmMember[]>(() => {
    const live = data?.members ?? [];
    const known = new Set(live.map((m) => m.sessionId));
    const fromTranscript: SwarmMember[] = summary.spawned
      .filter((s) => !s.sessionId || !known.has(s.sessionId))
      .map((s) => ({
        sessionId: s.sessionId ?? s.toolCallId,
        label: s.label,
        swarmStatus:
          s.state === "failed"
            ? "failed"
            : s.state === "spawning"
              ? "spawned"
              : "running",
        userConnected: false,
      }));
    return [...live, ...fromTranscript];
  }, [data, summary.spawned]);

  const working = members.filter((m) => swarmActivity(m) === "working").length;
  if (!data?.coordinator && members.length === 0) return null;

  // Opening an agent adds a pane beside this chat rather than navigating
  // away: leaving the coordinator mid-turn dropped its live stream, and the
  // way back was a reload of a half-written thread.
  const open = (m: SwarmMember) => toggleAgentPane(threadId, m.sessionId);

  return (
    <Card
      id="agents"
      title="Agents"
      meta={
        working > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <ActivityDot activity="working" /> {working} working
          </span>
        ) : (
          `${members.length}`
        )
      }
    >
      <div className="flex flex-col gap-0.5 -mx-1.5">
        {data?.coordinator && (
          <AgentRow
            member={data.coordinator}
            coordinator
            current={data.coordinator.threadId === threadId}
            busy={isRunning}
            paneOpen={openPanes?.includes(data.coordinator.sessionId) ?? false}
            onOpen={() => open(data.coordinator!)}
          />
        )}
        {members.map((m) => (
          <AgentRow
            key={m.sessionId}
            member={m}
            current={m.threadId === threadId}
            busy={isRunning}
            paneOpen={openPanes?.includes(m.sessionId) ?? false}
            onOpen={() => open(m)}
            depth={
              m.parentSessionId &&
              m.parentSessionId !== data?.coordinator?.sessionId
                ? 1
                : 0
            }
          />
        ))}
      </div>
    </Card>
  );
}

function AgentRow({
  member,
  coordinator,
  current,
  busy,
  paneOpen,
  onOpen,
  depth = 0,
}: {
  member: SwarmMember;
  coordinator?: boolean;
  current?: boolean;
  busy?: boolean;
  /** Already open in a pane beside the chat. */
  paneOpen?: boolean;
  onOpen: () => void;
  depth?: number;
}) {
  // The thread on screen knows its own state better than the runtime's
  // persisted swarm snapshot, which can still say "running" for a
  // coordinator whose turn ended a moment ago.
  const activity = current
    ? busy
      ? "working"
      : "idle"
    : swarmActivity(member);
  const name = memberName(member, coordinator);
  const { icon } = resolveSessionIdentity(member);
  const sub = coordinator
    ? member.title
    : member.title && member.title !== member.label
      ? member.title
      : undefined;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={current}
      data-testid={coordinator ? "session-agent-coordinator" : "session-agent-member"}
      className={cn(
        "group/agent flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors",
        current
          ? "bg-accent"
          : paneOpen
            ? "bg-accent/50 hover:bg-accent/70"
            : "hover:bg-accent/60",
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
      aria-pressed={paneOpen}
      title={
        current
          ? "You are chatting with this agent"
          : paneOpen
            ? `Close ${name}'s pane`
            : `Open ${name} beside this chat`
      }
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground text-xs">
        {icon ? (
          <span aria-hidden>{icon}</span>
        ) : coordinator ? (
          <CrownIcon className="size-3.5" />
        ) : (
          <BotIcon className="size-3.5" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 text-[13px] leading-5">
          <span className="truncate font-medium">{name}</span>
          {coordinator && (
            <span className="shrink-0 rounded bg-muted px-1 py-0.2 text-[10px] font-normal text-muted-foreground">
              Coordinator
            </span>
          )}
          <ActivityDot activity={activity} />
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {ACTIVITY_STYLE[activity].label}
          {sub ? ` · ${sub}` : ""}
        </span>
      </span>
      {current ? (
        <span className="text-[10px] text-muted-foreground">here</span>
      ) : paneOpen ? (
        <span className="text-[10px] text-muted-foreground">open</span>
      ) : (
        <Columns2Icon className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/agent:opacity-100" />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ContextCard({
  threadId,
  summary,
  isRunning,
}: {
  threadId: string;
  summary: SessionSummary;
  isRunning: boolean;
}) {
  // Asked of the runtime directly, so a reopened thread (whose messages
  // carry no metadata) shows the same numbers as a live one. Refreshed the
  // moment a turn ends; a turn in flight would only report the previous
  // call's figures anyway.
  const { data: live, mutate: refresh } = useSWR<SessionContext>(
    `/api/session/context?thread=${encodeURIComponent(threadId)}`,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (wasRunning.current && !isRunning) void refresh();
    wasRunning.current = isRunning;
  }, [isRunning, refresh]);

  const window = live?.contextWindow ?? summary.context?.contextWindow ?? null;
  const used =
    live?.contextTokens ??
    summary.context?.contextTokens ??
    summary.usage?.inputTokens ??
    0;
  const modelName = live?.model ?? summary.context?.model ?? summary.model;
  const pct = window ? Math.min(100, (used / window) * 100) : null;
  const totalTools = Object.values(summary.toolCounts).reduce(
    (a, b) => a + b,
    0,
  );

  return (
    <Card
      id="context"
      title="Context"
      meta={
        used
          ? window
            ? `${formatTokens(used)} / ${formatTokens(window)}`
            : `${formatTokens(used)} tokens`
          : undefined
      }
    >
      {used ? (
        <>
          <div className="flex items-baseline justify-between text-sm">
            <span>
              {pct == null
                ? `${formatTokens(used)} in context`
                : `${pct < 1 ? "<1" : Math.round(pct)}% used`}
            </span>
            {modelName && (
              <span className="truncate pl-2 text-[11px] text-muted-foreground">
                {modelName}
              </span>
            )}
          </div>
          {/* No bar without a real window: a percentage of a guessed limit
              is worse than none. */}
          {pct != null && (
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500",
                  pct > 80
                    ? "bg-destructive"
                    : pct > 60
                      ? "bg-amber-500"
                      : "bg-primary",
                )}
                style={{ width: `${Math.max(pct, 1)}%` }}
              />
            </div>
          )}
          {summary.usage && (
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>Last turn in</span>
              <span className="text-right tabular-nums">
                {formatTokens(summary.usage.inputTokens)}
              </span>
              <span>Last turn out</span>
              <span className="text-right tabular-nums">
                {formatTokens(summary.usage.outputTokens)}
              </span>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No usage reported yet.</p>
      )}
      {totalTools > 0 && (
        <div className="mt-3 flex flex-col gap-0.5 border-t pt-2">
          {TOOL_CATEGORIES.filter((c) => summary.toolCounts[c.id] > 0).map(
            (c) => {
              const Icon = CATEGORY_ICON[c.id];
              return (
                <div
                  key={c.id}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Icon className="size-3" />
                  <span className="flex-1">{c.label}</span>
                  <span className="tabular-nums">
                    {summary.toolCounts[c.id]}
                  </span>
                </div>
              );
            },
          )}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Connectors                                                          */
/* ------------------------------------------------------------------ */

function listOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const items = (value as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

function ConnectorsCard({ summary }: { summary: SessionSummary }) {
  const { data: mcp } = useMcpList();
  // Connections are only asked for once Composio has a key: without one the
  // backend answers 400, and the shared hook would toast that error on
  // every thread for a user who never set Composio up. Same SWR key as the
  // connectors page, so the two share one cache entry.
  const { data: composioConfig } = useComposioConfig({ onError: () => {} });
  const { data: composioData } = useSWR<
    ComposioConnection[] | { items?: ComposioConnection[] }
  >(composioConfig?.configured ? "/api/composio/connections" : null, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  // The backend wraps this list as `{ items }` even though the shared type
  // says array. Accept both, so a shape change can never take the page down.
  const composio = listOf<ComposioConnection>(composioData);
  const used = new Map(
    summary.connectorsUsed.map((c) => [c.name.toLowerCase(), c]),
  );

  const rows: {
    key: string;
    name: string;
    status: "on" | "off" | "pending" | "error";
    used?: number;
  }[] = [
    ...listOf<NonNullable<typeof mcp>[number]>(mcp).map((s) => ({
      key: `mcp-${s.id}`,
      name: s.name,
      status: (!s.enabled
        ? "off"
        : s.status === "connected"
          ? "on"
          : s.status === "disconnected"
            ? "error"
            : "pending") as "on" | "off" | "pending" | "error",
      used: used.get(s.name.toLowerCase())?.calls,
    })),
    ...composio.map((c) => ({
      key: `composio-${c.id}`,
      name: c.toolkit,
      status: (c.status === "ACTIVE"
        ? "on"
        : c.status === "INITIATED"
          ? "pending"
          : "error") as "on" | "pending" | "error",
      used: used.get(c.toolkit.toLowerCase())?.calls,
    })),
  ];
  // Connectors the transcript used but neither list knows (runtime-native
  // gmail/calendar), so the card never under-reports what touched the world.
  for (const c of summary.connectorsUsed) {
    if (!rows.some((r) => r.name.toLowerCase() === c.name.toLowerCase())) {
      rows.push({
        key: `used-${c.name}`,
        name: c.name,
        status: c.failed ? "error" : "on",
        used: c.calls,
      });
    }
  }

  return (
    <Card id="connectors" title="Connectors" meta={rows.length || undefined}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No connectors.{" "}
          <a
            href="/connectors"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Add one
          </a>
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 -mx-1">
          {rows.map((r) => (
            <div
              key={r.key}
              className="flex items-center gap-2 rounded-md px-1 py-1 text-[13px]"
            >
              <span className="flex size-5 items-center justify-center rounded bg-muted">
                <PlugIcon className="size-3 text-muted-foreground" />
              </span>
              <span className="flex-1 truncate capitalize">{r.name}</span>
              {r.used ? (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {r.used}×
                </span>
              ) : null}
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  r.status === "on" && "bg-emerald-500",
                  r.status === "pending" && "bg-amber-500",
                  r.status === "error" && "bg-destructive",
                  r.status === "off" && "bg-muted-foreground/30",
                )}
                title={r.status}
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Outputs                                                             */
/* ------------------------------------------------------------------ */

function OutputsCard({ summary }: { summary: SessionSummary }) {
  const images = useMemo(
    () =>
      summary.outputs.flatMap((o) =>
        o.kind === "image" ? [o.image] : [],
      ) as InlineImage[],
    [summary.outputs],
  );
  const files = summary.outputs.filter((o) => o.kind === "file");
  const [lightbox, setLightbox] = useState<number | null>(null);
  if (!images.length && !files.length) return null;

  const scrollTo = (messageId: string) =>
    document
      .querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <Card id="outputs" title="Outputs" meta={images.length + files.length}>
      {images.length > 0 && (
        <div className="mb-2 grid grid-cols-3 gap-1.5">
          {images.map((img, i) => (
            <button
              key={img.src.slice(0, 80) + i}
              type="button"
              onClick={() => setLightbox(i)}
              className="aspect-square overflow-hidden rounded-md border bg-muted hover:ring-2 hover:ring-ring/40"
              title={img.alt || "Image"}
            >
              <img
                src={img.src}
                alt={img.alt || ""}
                loading="lazy"
                className="size-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col -mx-1">
        {files.map((f) =>
          f.kind !== "file" ? null : (
            <Tooltip key={f.path}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => scrollTo(f.messageId)}
                  className="flex items-center gap-2 rounded-md px-1 py-1 text-left text-[13px] hover:bg-accent/60"
                >
                  <FileCode2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{f.name}</span>
                  <span className="font-mono text-[10px] tabular-nums">
                    {f.added ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        +{f.added}
                      </span>
                    ) : null}
                    {f.removed ? (
                      <span className="ml-1 text-destructive">
                        −{f.removed}
                      </span>
                    ) : null}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="left"
                className="max-w-sm break-all font-mono text-[11px]"
              >
                {f.verb} {f.path}
              </TooltipContent>
            </Tooltip>
          ),
        )}
      </div>
      {images.length > 0 && files.length === 0 && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <ImageIcon className="size-3" /> {images.length} image
          {images.length === 1 ? "" : "s"}
        </div>
      )}
      <ImageLightbox
        images={images}
        index={lightbox}
        onIndexChange={setLightbox}
      />
    </Card>
  );
}
