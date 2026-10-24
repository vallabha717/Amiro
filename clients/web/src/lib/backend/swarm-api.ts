"use client";

import type { UIMessage } from "ai";
import useSWR from "swr";
import { apiJson, fetcher } from "./client";

/** One agent in a thread's swarm, as backend/src/swarm.rs reports it. */
export interface SwarmMember {
  sessionId: string;
  /** Memorable animal/entity name extracted from the runtime session (e.g. "octopus"). */
  shortName?: string | null;
  /** Emoji icon for the animal/entity name (e.g. "🐙"). */
  icon?: string | null;
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

/** Session animal/client names to emoji icons (matches `amiro_core::id::SESSION_NAMES`). */
export const SESSION_ANIMAL_ICONS: Record<string, string> = {
  ant: "🐜",
  bat: "🦇",
  bird: "🐦",
  bug: "🐛",
  cat: "🐱",
  chicken: "🐔",
  chick: "🐥",
  chipmunk: "🌰",
  cow: "🐄",
  crocodile: "🐊",
  cricket: "🦗",
  dog: "🐕",
  dove: "🤍",
  eagle: "🦅",
  fish: "🐟",
  fox: "🦊",
  giraffe: "🦒",
  hamster: "🐹",
  ladybug: "🐞",
  lobster: "🦞",
  mosquito: "🦟",
  owl: "🦉",
  ox: "🐂",
  pig: "🐷",
  rat: "🐀",
  ram: "🐏",
  rooster: "🐓",
  shrimp: "🦐",
  sauropod: "🦕",
  blowfish: "🐡",
  buffalo: "🐃",
  butterfly: "🦋",
  badger: "🦡",
  bear: "🐻",
  crab: "🦀",
  deer: "🦌",
  duck: "🦆",
  frog: "🐸",
  goat: "🐐",
  lion: "🦁",
  wolf: "🐺",
  horse: "🐴",
  koala: "🐨",
  llama: "🦙",
  mouse: "🐭",
  otter: "🦦",
  panda: "🐼",
  peacock: "🦚",
  penguin: "🐧",
  shark: "🦈",
  sheep: "🐑",
  sloth: "🦥",
  snail: "🐌",
  snake: "🐍",
  spider: "🧶",
  squid: "🦑",
  swan: "🦢",
  "t-rex": "🦖",
  tiger: "🐯",
  turkey: "🦃",
  whale: "🐋",
  turtle: "🐢",
  rabbit: "🐰",
  parrot: "🦜",
  jaguar: "🐆",
  lizard: "🦎",
  monkey: "🐒",
  gorilla: "🦍",
  orangutan: "🦧",
  camel: "🐫",
  elephant: "🐘",
  rhino: "🦏",
  hippo: "🦛",
  boar: "🐗",
  unicorn: "🦄",
  kangaroo: "🦘",
  hedgehog: "🦔",
  skunk: "🦨",
  raccoon: "🦝",
  flamingo: "🦩",
  dolphin: "🐬",
  octopus: "🐙",
  scorpion: "🦂",
  zebra: "🦓",
  stallion: "🐎",
  dromedary: "🐪",
  hog: "🐖",
  kitten: "🐈",
  poodle: "🐩",
  hare: "🐇",
  vole: "🐁",
  dragon: "🐉",
  humpback: "🐳",
  guppy: "🐠",
  nautilus: "🐚",
  hatchling: "🐣",
  wyvern: "🐲",
  calf: "🐮",
  macaque: "🐵",
  tigress: "🐅",
  puppy: "🐶",
  duckling: "🐤",
  mizaru: "🙈",
  kikazaru: "🙉",
  iwazaru: "🙊",
  retriever: "🦮",
  pawprint: "🐾",
  piglet: "🐽",
  bonehound: "🦴",
  sabertooth: "🦷",
  microbe: "🦠",
  mushroom: "🍄",
  cactus: "🌵",
  clover: "🍀",
  sunflower: "🌻",
  hibiscus: "🌺",
  blossom: "🌸",
  daisy: "🌼",
  tulip: "🌷",
  rose: "🌹",
  maple: "🍁",
  seedling: "🌱",
  evergreen: "🌲",
  palmtree: "🌴",
  herb: "🌿",
};

/** Extract the animal/entity short name from a session ID (e.g. `session_octopus_1792835224856_...` -> `"octopus"`). */
export function extractSessionShortName(
  sessionId?: string | null,
): string | null {
  if (!sessionId || typeof sessionId !== "string") return null;
  if (!sessionId.startsWith("session_")) return null;
  const rest = sessionId.slice("session_".length);
  const idx = rest.indexOf("_");
  if (idx <= 0) return null;
  return rest.slice(0, idx);
}

/** Get the emoji icon for a session animal/entity name. */
export function sessionAnimalIcon(name?: string | null): string | null {
  if (!name) return null;
  return SESSION_ANIMAL_ICONS[name.toLowerCase()] ?? "💫";
}

/** Resolve `(shortName, icon)` from an object that may carry `shortName`, `icon`, or `sessionId`. */
export function resolveSessionIdentity(item?: {
  sessionId?: string | null;
  shortName?: string | null;
  icon?: string | null;
} | null): { shortName: string | null; icon: string | null } {
  if (!item) return { shortName: null, icon: null };
  const shortName =
    (typeof item.shortName === "string" && item.shortName.trim()) ||
    extractSessionShortName(item.sessionId);
  const icon =
    (typeof item.icon === "string" && item.icon.trim()) ||
    (shortName ? sessionAnimalIcon(shortName) : null);
  return { shortName: shortName ?? null, icon: icon ?? null };
}

/** Format a thread's display title with its animal emoji and short name (e.g. `🐙 octopus · Morning briefing`). */
export function formatThreadAnimalTitle(
  thread?: {
    title?: string | null;
    sessionId?: string | null;
    shortName?: string | null;
    icon?: string | null;
  } | null,
  fallback = "New Chat",
): string {
  const baseTitle = thread?.title?.trim() || fallback;
  const { shortName, icon } = resolveSessionIdentity(thread);
  if (!shortName) return baseTitle;
  const prefix = `${icon ? `${icon} ` : ""}${shortName}`;
  if (baseTitle.toLowerCase().startsWith(shortName.toLowerCase()) || (icon && baseTitle.startsWith(icon))) {
    return baseTitle;
  }
  return `${prefix} · ${baseTitle}`;
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

export function memberName(m: SwarmMember, coordinator = false): string {
  const { shortName, icon } = resolveSessionIdentity(m);
  if (coordinator) {
    if (shortName) {
      return `${icon ? `${icon} ` : ""}${shortName}`;
    }
    return "Coordinator";
  }
  if (shortName && m.label) {
    return `${icon ? `${icon} ` : ""}${shortName} · ${m.label}`;
  }
  if (shortName) {
    return `${icon ? `${icon} ` : ""}${shortName}`;
  }
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
