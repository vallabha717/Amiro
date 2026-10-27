"use client";

import { useEffect, useSyncExternalStore } from "react";
import useSWR from "swr";
import { apiJson, fetcher } from "./client";
import { subscribeTeamRoomLive, teamRoomLiveConnected } from "./team-room-live";

/** Who posted a room message; see backend/src/routes/team_room.rs. */
export type TeamRoomSender =
  | { type: "user"; id: string; name: string }
  | { type: "agent"; id: string; name: string }
  | { type: "system" };

/** One message in the Huddle. */
export interface TeamRoomMessage {
  id: string;
  from: TeamRoomSender;
  /** Agent ids the message was handed to (its @mentions). */
  to: string[];
  text: string;
  /** 0 for a person's message; each agent reply in a chain adds one. */
  hop: number;
  createdAt: string;
  replyTo?: string;
  /** The reply @mentioned teammates, but the chain had reached its limit. */
  limitReached?: boolean;
  /**
   * System notices: `error` when an agent could not answer, `empty` when it
   * finished its turn without saying anything.
   */
  kind?: "error" | "empty";
  agentId?: string;
  detail?: string;
  /** The draft this finished reply (or notice) replaces. */
  draftId?: string;
  /** Still being written: a draft shown as a message (see `draftMessage`). */
  streaming?: boolean;
  /** The tool a streaming reply is using right now. */
  tool?: string | null;
}

/** A reply an agent is writing right now. */
export interface TeamRoomDraft {
  id: string;
  agentId: string;
  replyTo: string;
  text: string;
  tool: string | null;
  startedAt: string;
}

export interface TeamRoom {
  messages: TeamRoomMessage[];
  /** Agents answering a room message right now. */
  working: string[];
  drafts: TeamRoomDraft[];
  maxHops: number;
}

export const TEAM_ROOM_KEY = "/api/team/room";

/**
 * The caller's room, kept current by the live stream while any view is open.
 * Polling is only the fallback for when the stream is down.
 */
export function useTeamRoom() {
  const live = useSyncExternalStore(
    subscribeTeamRoomLive.connected,
    teamRoomLiveConnected,
    () => false,
  );
  useEffect(() => subscribeTeamRoomLive(), []);
  return useSWR<TeamRoom>(TEAM_ROOM_KEY, fetcher, {
    refreshInterval: (room) => (live ? 30000 : room?.working.length ? 1500 : 6000),
    revalidateOnFocus: !live,
  });
}

/** A draft drawn as a message, so every view renders it like the rest. */
export function draftMessage(draft: TeamRoomDraft, name: string): TeamRoomMessage {
  return {
    id: `draft-${draft.id}`,
    from: { type: "agent", id: draft.agentId, name },
    to: [],
    text: draft.text,
    hop: 0,
    createdAt: draft.startedAt,
    replyTo: draft.replyTo,
    streaming: true,
    tool: draft.tool,
  };
}

/**
 * The room's messages followed by the replies still being written, drawn as
 * messages. Every view (the Huddle, agent-to-agent) shows this timeline.
 */
export function roomTimeline(
  room: TeamRoom | undefined,
  nameOf: (agentId: string) => string,
): TeamRoomMessage[] {
  const messages = room?.messages ?? [];
  const drafts = (room?.drafts ?? []).map((d) => draftMessage(d, nameOf(d.agentId)));
  return [...messages, ...drafts];
}

export function postTeamRoomMessage(text: string) {
  return apiJson<{ message: TeamRoomMessage }>(TEAM_ROOM_KEY, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}
