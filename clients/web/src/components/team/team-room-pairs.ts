import type { TeamRoomMessage } from "@/lib/backend/team-room-api";

function senderId(message: TeamRoomMessage): string | null {
  return message.from.type === "system"
    ? (message.agentId ?? null)
    : message.from.id;
}

/**
 * The room messages between agents `a` and `b`: one handing work to the other
 * (an @mention), the other's answer to it, and any notice about that answer.
 * Oldest first, like the room.
 */
export function pairMessages(
  messages: TeamRoomMessage[],
  a: string,
  b: string,
): TeamRoomMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const agentFrom = (m: TeamRoomMessage | undefined) =>
    m && m.from.type === "agent" ? m.from.id : null;
  return messages.filter((m) => {
    const from = senderId(m);
    if (from !== a && from !== b) return false;
    const other = from === a ? b : a;
    if (m.from.type === "agent" && m.to.includes(other)) return true;
    return agentFrom(m.replyTo ? byId.get(m.replyTo) : undefined) === other;
  });
}
