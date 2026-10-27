"use client";

import { mutate } from "swr";
import { apiFetch } from "./client";
import type { TeamRoom, TeamRoomDraft, TeamRoomMessage } from "./team-room-api";

// Same as TEAM_ROOM_KEY; repeated so this module does not import its importer.
const ROOM_KEY = "/api/team/room";
const RETRY_MS = [1000, 2000, 5000, 10000, 15000];
/** Views come and go on navigation; keep the stream through the gap. */
const LINGER_MS = 3000;

/** One event from `GET /api/team/room/stream`; see backend/src/routes/team_room.rs. */
export type TeamRoomEvent =
  | ({ type: "snapshot" } & TeamRoom)
  | { type: "message"; message: TeamRoomMessage }
  | { type: "draft"; draft: TeamRoomDraft }
  | { type: "draft.end"; id: string }
  | { type: "working"; working: string[] };

/**
 * Splits complete SSE frames off `buffer`: the JSON `data:` of each, and the
 * unfinished rest. Keepalive comments and empty frames are dropped.
 */
export function parseSseFrames(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const rest = frames.pop() ?? "";
  const events = frames
    .map((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data.startsWith("{"));
  return { events, rest };
}

const EMPTY: TeamRoom = { messages: [], working: [], drafts: [], maxHops: 4 };

/** The room after `event`. Never duplicates a message, whatever arrives twice. */
export function applyTeamRoomEvent(room: TeamRoom | undefined, event: TeamRoomEvent): TeamRoom {
  const current = room ?? EMPTY;
  const drafts = current.drafts ?? [];
  switch (event.type) {
    case "snapshot": {
      const { type: _type, ...snapshot } = event;
      return { ...snapshot, drafts: snapshot.drafts ?? [] };
    }
    case "message": {
      const { message } = event;
      const known = current.messages.some((m) => m.id === message.id);
      return {
        ...current,
        messages: known ? current.messages : [...current.messages, message],
        drafts: message.draftId ? drafts.filter((d) => d.id !== message.draftId) : drafts,
      };
    }
    case "draft": {
      const { draft } = event;
      // A late draft frame must not bring back a reply that already landed.
      if (current.messages.some((m) => m.draftId === draft.id)) return current;
      const others = drafts.filter((d) => d.id !== draft.id);
      return { ...current, drafts: [...others, draft] };
    }
    case "draft.end":
      return { ...current, drafts: drafts.filter((d) => d.id !== event.id) };
    case "working":
      return { ...current, working: event.working };
  }
}

// ---------------------------------------------------------------------------
// One shared connection for every open view
// ---------------------------------------------------------------------------

let users = 0;
let abort: AbortController | null = null;
let lingering: ReturnType<typeof setTimeout> | null = null;
let connected = false;
const listeners = new Set<() => void>();

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const listener of listeners) listener();
}

export function teamRoomLiveConnected() {
  return connected;
}

async function run(signal: AbortSignal) {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const response = await apiFetch("/api/team/room/stream", {
        signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const data of events) {
          const event = JSON.parse(data) as TeamRoomEvent;
          if (event.type === "snapshot") {
            setConnected(true);
            attempt = 0;
          }
          void mutate(ROOM_KEY, (room?: TeamRoom) => applyTeamRoomEvent(room, event), {
            revalidate: false,
          });
        }
      }
    } catch {
      // Dropped, refused or offline: fall back to polling and try again.
    }
    setConnected(false);
    if (signal.aborted) return;
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Keeps the live stream open while at least one caller holds it. Returns the
 * release function (a React effect's cleanup).
 */
export function subscribeTeamRoomLive(): () => void {
  users += 1;
  if (lingering) {
    clearTimeout(lingering);
    lingering = null;
  }
  if (!abort) {
    abort = new AbortController();
    void run(abort.signal);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users > 0) return;
    lingering = setTimeout(() => {
      lingering = null;
      if (users > 0) return;
      abort?.abort();
      abort = null;
      setConnected(false);
    }, LINGER_MS);
  };
}

/** For `useSyncExternalStore`: re-render when the stream connects or drops. */
subscribeTeamRoomLive.connected = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
