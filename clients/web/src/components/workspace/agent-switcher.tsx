"use client";

import {
  type SwarmActivity,
  type SwarmMember,
  memberName,
  openSwarmMember,
  swarmActivity,
  useSwarm,
} from "@/lib/backend/swarm-api";
import type { SpawnedAgent } from "lib/chat-ux/session-summary";
import { cn } from "lib/utils";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CrownIcon,
  Loader2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { ActivityDot } from "./session-panel";

// ACTIVITY_STYLE in session-panel is module-private; only the labels are
// needed here and the dot itself comes from the shared ActivityDot.
const ACTIVITY_LABEL: Record<SwarmActivity, string> = {
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  idle: "Idle",
};

const MAX_AVATARS = 4;

/** Same merge AgentsCard does: backend list first, transcript spawns fill the gap. */
function useMergedSwarm(threadId: string, isRunning: boolean, spawned?: SpawnedAgent[]) {
  const { data } = useSwarm(threadId, isRunning);
  const coordinator = data?.coordinator ?? null;
  const members = useMemo<SwarmMember[]>(() => {
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
  return { coordinator, members };
}

/** Open (or create) the thread bound to an agent and navigate there. */
function useOpenAgent(fromThreadId: string) {
  const router = useRouter();
  const [opening, setOpening] = useState<string | null>(null);
  const open = useCallback(
    async (m: SwarmMember) => {
      if (m.threadId) return router.push(`/?thread=${m.threadId}`);
      setOpening(m.sessionId);
      try {
        const id = await openSwarmMember(m.sessionId, fromThreadId);
        router.push(`/?thread=${id}`);
      } catch (e: any) {
        toast.error(e?.message || "Could not open that agent");
      } finally {
        setOpening(null);
      }
    },
    [router, fromThreadId],
  );
  return { opening, open };
}

// Deterministic per-agent color so an agent keeps its avatar across polls.
// Inline hsl() because Tailwind cannot see dynamically built class names.
function avatarColor(sessionId: string) {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 42%)`;
}

function initials(name: string) {
  const parts = name.split(/[\s\-_/]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return s.toUpperCase();
}

function WorkingCluster({ working }: { working: SwarmMember[] }) {
  if (working.length === 0) return null;
  const shown = working.slice(0, MAX_AVATARS);
  const extra = working.length - shown.length;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="group"
          aria-label={`${working.length} agent${working.length === 1 ? "" : "s"} working`}
          className="flex items-center rounded-full pr-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex items-center -space-x-1.5">
            {shown.map((m) => (
              <span
                key={m.sessionId}
                className="relative flex size-5 items-center justify-center rounded-full text-[9px] font-semibold text-white ring-2 ring-background"
                style={{ backgroundColor: avatarColor(m.sessionId) }}
              >
                <span className="absolute -inset-0.5 rounded-full ring-2 ring-emerald-500/60 animate-pulse" />
                <span className="relative">{initials(memberName(m))}</span>
              </span>
            ))}
          </span>
          {extra > 0 && (
            <span className="ml-1 text-[11px] font-medium text-muted-foreground">+{extra}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        <div className="flex flex-col gap-0.5">
          {working.map((m) => (
            <span key={m.sessionId} className="flex items-center gap-1.5">
              <ActivityDot activity="working" /> {memberName(m)}
              <span className="opacity-70">Working</span>
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function AgentSwitcher({
  threadId,
  isRunning,
  spawned,
}: {
  threadId: string;
  isRunning: boolean;
  spawned?: SpawnedAgent[];
}) {
  const { coordinator, members } = useMergedSwarm(threadId, isRunning, spawned);
  const { opening, open } = useOpenAgent(threadId);

  const currentMember = members.find((m) => m.threadId === threadId);
  const onCoordinator = !currentMember;
  const working = members.filter((m) => swarmActivity(m) === "working");

  // An ordinary chat has no swarm; leave it looking exactly as before.
  if (!coordinator && members.length === 0) return null;

  const label = currentMember ? memberName(currentMember) : "Coordinator";
  const memberIds = new Set(members.map((m) => m.sessionId));
  const rows: { m: SwarmMember; isCoordinator: boolean; depth: number }[] = [
    ...(coordinator ? [{ m: coordinator, isCoordinator: true, depth: 0 }] : []),
    ...members.map((m) => ({
      m,
      isCoordinator: false,
      // Only nest under another member; the coordinator is the implicit root.
      depth: m.parentSessionId && memberIds.has(m.parentSessionId) ? 1 : 0,
    })),
  ];

  return (
    <div className="flex w-full justify-start">
      <div className="inline-flex items-center gap-1 rounded-full border border-border bg-background/95 py-0.5 pl-1 text-xs text-muted-foreground shadow-xs backdrop-blur">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Chatting with ${label}. Switch agent`}
              className="flex items-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 outline-none data-[state=open]:bg-accent"
            >
              {onCoordinator ? <CrownIcon className="size-3" /> : <BotIcon className="size-3" />}
              <span>To:</span>
              <span className="max-w-40 truncate font-medium text-foreground">{label}</span>
              <ChevronDownIcon className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-64">
            {rows.map(({ m, isCoordinator, depth }) => {
              const current = isCoordinator
                ? m.threadId === threadId || (onCoordinator && !m.threadId)
                : m.threadId === threadId;
              // The open thread's live state beats the persisted snapshot.
              const activity = current
                ? isRunning
                  ? "working"
                  : "idle"
                : swarmActivity(m);
              return (
                <DropdownMenuItem
                  key={`${isCoordinator ? "c" : "m"}-${m.sessionId}`}
                  disabled={opening !== null && opening !== m.sessionId}
                  // Keep the menu open while a member thread is being created
                  // so the spinner is visible; navigation unmounts us anyway.
                  onSelect={(e) => {
                    if (current) return;
                    if (!m.threadId) e.preventDefault();
                    void open(m);
                  }}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  className="gap-2"
                >
                  {isCoordinator ? (
                    <CrownIcon className="size-3.5" />
                  ) : (
                    <BotIcon className="size-3.5" />
                  )}
                  <ActivityDot activity={activity} />
                  <span className="min-w-0 flex-1 truncate">
                    {isCoordinator ? "Coordinator" : memberName(m)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {ACTIVITY_LABEL[activity]}
                  </span>
                  {opening === m.sessionId ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : current ? (
                    <CheckIcon className="size-3.5" />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <WorkingCluster working={working} />
      </div>
    </div>
  );
}

export function MemberThreadBanner({ threadId }: { threadId: string }) {
  // Passive poll: the banner has no run state of its own.
  const { coordinator, members } = useMergedSwarm(threadId, false);
  const { opening, open } = useOpenAgent(threadId);

  const member = members.find((m) => m.threadId === threadId);
  if (!member || !coordinator) return null;

  const activity = swarmActivity(member);
  return (
    <div className="absolute left-1/2 top-2 z-30 flex w-[min(42rem,calc(100%-12rem))] -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 text-xs shadow-sm backdrop-blur">
      <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-2">
        <span className="flex items-center gap-1.5 truncate">
          <span>
            You&apos;re chatting directly with{" "}
            <span className="font-medium">{memberName(member)}</span>
          </span>
          <ActivityDot activity={activity} />
          <span className="text-muted-foreground">{ACTIVITY_LABEL[activity]}</span>
        </span>
        <span className="hidden truncate text-[11px] text-muted-foreground xl:inline">
          Messages go straight to this agent; the coordinator isn&apos;t told.
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn("h-6 shrink-0 gap-1 px-2 text-xs")}
        disabled={opening !== null}
        onClick={() => void open(coordinator)}
      >
        {opening ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <ArrowLeftIcon className="size-3" />
        )}
        Back to coordinator
      </Button>
    </div>
  );
}
