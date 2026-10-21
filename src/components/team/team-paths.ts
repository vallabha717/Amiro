/** Team with an agent's fixed Team thread open beside the list. */
export function teamThreadPath(agentId: string): string {
  return `/team?agent=${encodeURIComponent(agentId)}`;
}

/**
 * The agent's own space: the full Amiro app acting as that agent (its chats,
 * models, connectors, keys, schedules). The main agent's space is Amiro as it
 * always was; a team agent's is scoped by `?agent=` (agent-scope.ts).
 */
export function agentSpacePath(agentId: string): string {
  return agentId === "main" ? "/" : `/?agent=${encodeURIComponent(agentId)}`;
}
