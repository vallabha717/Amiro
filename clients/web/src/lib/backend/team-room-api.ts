"use client";

import useSWR from "swr";
import { apiJson, fetcher } from "./client";

/** Who posted a room message; see backend/src/routes/team_room.rs. */
export type TeamRoomSender =
  | { type: "user"; id: string; name: string }
  | { type: "agent"; id: string; name: string }
  | { type: "system" };

/** One message in the Team room. */
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
}

export interface TeamRoom {
  messages: TeamRoomMessage[];
  /** Agents answering a room message right now. */
  working: string[];
  maxHops: number;
}

export const TEAM_ROOM_KEY = "/api/team/room";

/** The caller's room; polls quickly while an agent is working. */
export function useTeamRoom() {
  return useSWR<TeamRoom>(TEAM_ROOM_KEY, fetcher, {
    refreshInterval: (room) => (room?.working.length ? 1500 : 6000),
    revalidateOnFocus: true,
  });
}

export function postTeamRoomMessage(text: string) {
  return apiJson<{ message: TeamRoomMessage }>(TEAM_ROOM_KEY, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}
