"use client";

import type { UIMessage } from "ai";
import useSWR from "swr";
import { apiJson, fetcher } from "./client";

/** One agent in a thread's swarm, as backend/src/swarm.rs reports it. */
export interface SwarmMember {
  sessionId: string;
  parentSessionId?: string | null;
  label?: string | null;
  title?: string | null;
  /** This API connection's view: e.g. "idle", "running". */
  status?: string | null;
  /** The runtime's persisted swarm lifecycle status. */
  swarmStatus?: string | null;
  userConnected: boolean;
  lastActiveAtMs?: number | null;
  workingDir?: string | null;
  /** The thread already bound to this member, if one was opened before. */
  threadId?: string | null;
}

export interface SwarmSnapshot {
  coordinator: SwarmMember | null;
  members: SwarmMember[];
}

export type SwarmActivity = "working" | "waiting" | "done" | "failed" | "idle";

/**
 * Collapse the runtime's many lifecycle strings (amiro-swarm-core
 * SwarmLifecycleStatus) into the five states the UI draws. Unknown strings
 * read as idle rather than as an error -- the runtime promises new ones.
 */
export function swarmActivity(m: Pick<SwarmMember, "status" | "swarmStatus">): SwarmActivity {
  const s = (m.swarmStatus || m.status || "").toLowerCase();
  if (["running", "running_stale", "spawned", "processing", "busy", "working"].includes(s))
    return "working";
  if (["queued", "blocked", "pending", "todo", "ready"].includes(s)) return "waiting";
  if (["completed", "done", "stopped"].includes(s)) return "done";
  if (["failed", "crashed", "error"].includes(s)) return "failed";
  return "idle";
}

export function memberName(m: SwarmMember): string {
  return m.label || m.title || `agent ${m.sessionId.slice(0, 6)}`;
}

/**
 * Poll a thread's swarm. Fast while anything is working, slow otherwise --
 * the backend reads a persisted snapshot, so there is no push to subscribe
 * to yet.
 */
export function useSwarm(threadId: string | undefined, active: boolean) {
  const res = useSWR<SwarmSnapshot>(
    threadId ? `/api/swarm/members?thread=${encodeURIComponent(threadId)}` : null,
    fetcher,
    {
      refreshInterval: (data) => {
        const working = data?.members.some((m) => swarmActivity(m) === "working");
        return active || working ? 2500 : 15000;
      },
      revalidateOnFocus: true,
      shouldRetryOnError: false,
      keepPreviousData: true,
    },
  );
  return res;
}

export async function openSwarmMember(
  sessionId: string,
  fromThreadId: string,
): Promise<string> {
  const res = await apiJson<{ threadId: string }>("/api/swarm/open", {
    method: "POST",
    body: JSON.stringify({ sessionId, fromThreadId }),
  });
  return res.threadId;
}

/**
 * Live transcript of one swarm member (or the coordinator), read through
 * the thread the user is on. Polls quickly while the agent is working and
 * slowly otherwise; the runtime has no push channel for another session yet.
 */
export function useAgentTranscript(
  threadId: string | undefined,
  sessionId: string | undefined,
  working: boolean,
) {
  return useSWR<{ sessionId: string; messages: UIMessage[] }>(
    threadId && sessionId
      ? `/api/swarm/transcript?thread=${encodeURIComponent(threadId)}&session=${encodeURIComponent(sessionId)}`
      : null,
    fetcher,
    {
      refreshInterval: working ? 2000 : 10000,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
      keepPreviousData: true,
    },
  );
}
