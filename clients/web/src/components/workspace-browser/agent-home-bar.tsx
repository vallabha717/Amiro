"use client";

import { apiJson } from "@/lib/backend/client";
import { cn } from "lib/utils";
import {
  Activity,
  BookOpen,
  Clock,
  Fingerprint,
  Heart,
  Loader2,
  Play,
  Sparkles,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "ui/popover";
import { Switch } from "ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";

/** GET /api/agent-home (backend/src/agent_home.rs). */
export interface AgentHomeStatus {
  files: { name: string; exists: boolean; size: number; modifiedAt: string | null }[];
  journalCount: number;
  heartbeat: {
    enabled: boolean;
    intervalHours: number;
    quietStart: string;
    quietEnd: string;
    timezone: string;
    lastHeartbeatAt: string | null;
    lastResult: string | null;
    threadId: string | null;
    nextDueAt: string | null;
  };
}

/** The agent's own files, in the order a person thinks about them. */
export const AGENT_FILES = [
  { name: "IDENTITY.md", label: "Identity", icon: Fingerprint, hint: "Name and personality, set on the Personality page." },
  { name: "SOUL.md", label: "Soul", icon: Heart, hint: "How your agent works — and what it has learned about working with you." },
  { name: "USER.md", label: "You", icon: UserRound, hint: "Your profile: who you are and how you like things. You both keep it current." },
  { name: "NOW.md", label: "Now", icon: Clock, hint: "Its scratchpad for what's happening right now. Rewritten as things change." },
  { name: "HEARTBEAT.md", label: "Heartbeat", icon: Activity, hint: "The checklist it runs on its own every few hours." },
  { name: "BOOTSTRAP.md", label: "First chat", icon: Sparkles, hint: "The plan for your first conversation. It deletes itself afterwards." },
] as const;

const INTERVALS = [1, 2, 4, 8, 12, 24];

function relative(iso: string | null): string {
  if (!iso) return "never";
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const unit = abs < 3_600_000 ? [Math.round(abs / 60_000), "min"] : [Math.round(abs / 3_600_000), "h"];
  return ms < 0 ? `${unit[0]} ${unit[1]} ago` : `in ${unit[0]} ${unit[1]}`;
}

function HeartbeatControl({
  status,
  canWrite,
  onChanged,
}: {
  status: AgentHomeStatus;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const hb = status.heartbeat;
  const [busy, setBusy] = useState<"save" | "run" | null>(null);

  const save = async (patch: Partial<AgentHomeStatus["heartbeat"]>) => {
    setBusy("save");
    try {
      await apiJson("/api/agent-home/heartbeat", { method: "PUT", body: JSON.stringify(patch) });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update the heartbeat");
    } finally {
      setBusy(null);
    }
  };
  const runNow = async () => {
    setBusy("run");
    try {
      const res = await apiJson<{ result?: string }>("/api/agent-home/heartbeat/run", { method: "POST" });
      toast.success(
        res?.result === "message" ? "Heartbeat done — your agent left you a note" : "Heartbeat done — nothing to report",
      );
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Heartbeat failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="agent-home-heartbeat"
          className="ml-auto inline-flex h-7 items-center gap-2 rounded-full border border-border/60 bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="relative flex size-2">
            {hb.enabled && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />}
            <span className={cn("relative inline-flex size-2 rounded-full", hb.enabled ? "bg-emerald-500" : "bg-muted-foreground/40")} />
          </span>
          {hb.enabled ? `Heartbeat · every ${hb.intervalHours}h` : "Heartbeat off"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" data-testid="agent-home-heartbeat-panel">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Heartbeat</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Between chats your agent reviews NOW.md, follows up on loose ends and writes its journal. It only
                messages you when it has something worth saying.
              </p>
            </div>
            <Switch
              checked={hb.enabled}
              disabled={!canWrite || busy !== null}
              onCheckedChange={(enabled) => save({ enabled })}
              aria-label="Heartbeat on or off"
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Every</span>
            <div className="flex gap-1">
              {INTERVALS.map((h) => (
                <button
                  key={h}
                  type="button"
                  disabled={!canWrite || busy !== null}
                  onClick={() => save({ intervalHours: h })}
                  className={cn(
                    "h-6 rounded-full px-2 font-medium transition-colors",
                    hb.intervalHours === h ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
                  )}
                >
                  {h}h
                </button>
              ))}
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Quiet hours</dt>
            <dd>
              {hb.quietStart}–{hb.quietEnd} <span className="text-muted-foreground">({hb.timezone})</span>
            </dd>
            <dt className="text-muted-foreground">Last run</dt>
            <dd>
              {relative(hb.lastHeartbeatAt)}
              {hb.lastResult === "message" ? " · left a note" : hb.lastResult === "quiet" ? " · nothing to report" : ""}
            </dd>
            {hb.enabled && (
              <>
                <dt className="text-muted-foreground">Next</dt>
                <dd>{relative(hb.nextDueAt)}</dd>
              </>
            )}
          </dl>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="secondary" disabled={!canWrite || busy !== null} onClick={runNow} className="h-8">
              {busy === "run" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Run now
            </Button>
            {hb.threadId && (
              <Button asChild size="sm" variant="ghost" className="h-8">
                <Link href={`/?thread=${encodeURIComponent(hb.threadId)}`}>Open its notes</Link>
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The agent's home files, one click away: identity, soul, your profile, its
 * scratchpad, its heartbeat checklist and its journal. They live at the top
 * of the workspace and are loaded into every conversation.
 */
export function AgentHomeBar({
  activePath,
  canWrite,
  onOpen,
  onOpenJournal,
}: {
  activePath: string | null;
  canWrite: boolean;
  onOpen: (path: string) => void;
  onOpenJournal: () => void;
}) {
  const { data, mutate } = useSWR<AgentHomeStatus>("/api/agent-home", (url: string) => apiJson(url), {
    shouldRetryOnError: false,
    revalidateOnFocus: true,
  });
  if (!data) return null;
  const present = new Set(data.files.filter((f) => f.exists).map((f) => f.name));

  return (
    <div
      data-testid="workspace-agent-strip"
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-card/60 px-3 py-2"
    >
      <span className="pr-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Agent home
      </span>
      {AGENT_FILES.filter((f) => present.has(f.name)).map(({ name, label, icon: Icon, hint }) => (
        <Tooltip key={name}>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={`workspace-agent-${name}`}
              aria-pressed={activePath === name}
              onClick={() => onOpen(name)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                activePath === name
                  ? "border-primary/30 bg-primary/10 text-foreground"
                  : "border-border/60 bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                name === "BOOTSTRAP.md" && "border-dashed",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">{hint}</TooltipContent>
        </Tooltip>
      ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="workspace-agent-journal"
            onClick={onOpenJournal}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border/60 bg-background px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <BookOpen className="size-3.5" aria-hidden="true" />
            Journal
            {data.journalCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{data.journalCount}</span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">Short dated entries your agent writes about how things are going.</TooltipContent>
      </Tooltip>
      <HeartbeatControl status={data} canWrite={canWrite} onChanged={() => void mutate()} />
    </div>
  );
}
