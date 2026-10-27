/** Team with an agent's fixed Team thread open beside the list. */
export function teamThreadPath(agentId: string): string {
  return `/team?agent=${encodeURIComponent(agentId)}`;
}

const RESERVED_PREFIXES = new Set([
  "api",
  "team",
  "setup",
  "sign-in",
  "onboarding",
  "export",
  "_next",
  "storage",
  "health",
  "favicon.ico",
  "agent",
]);

/**
 * The agent's own space: the full Amiro app acting as that agent (its chats,
 * models, connectors, keys, schedules). The main agent's space is /amiro;
 * a team agent's is /<agentId>.
 */
export function agentSpacePath(agentId: string): string {
  return !agentId || agentId === "main" || agentId === "amiro"
    ? "/amiro"
    : `/${encodeURIComponent(agentId)}`;
}

/**
 * Builds an agent-prefixed route for a given sub-path (e.g. /connectors, /agent, /schedules).
 * For main/amiro: /amiro/connectors. For team agent: /<agentId>/connectors.
 */
export function agentScopedPath(
  agentId: string | null | undefined,
  subPath: string,
): string {
  const prefix =
    !agentId || agentId === "main" || agentId === "amiro"
      ? "/amiro"
      : `/${encodeURIComponent(agentId)}`;
  const clean = subPath.startsWith("/") ? subPath : `/${subPath}`;
  if (clean === "/" || clean === "") return prefix;
  return `${prefix}${clean}`;
}

/** Team with the Huddle (every agent's group chat) open beside the list. */
export const TEAM_HUDDLE_PATH = "/team?view=huddle";

/** `?with=` value for your own chat with the space's agent. */
export const TEAM_WITH_YOU = "you";

/**
 * Team inside an agent's space: the Huddle, or with `withId` the space
 * agent's conversation with you (`TEAM_WITH_YOU`) or with a teammate.
 * E.g. /amiro/team-room, /<space>/team-room?with=<id>.
 */
export function teamRoomPath(
  spaceAgentId: string | null | undefined,
  withId?: string | null,
): string {
  const base = agentScopedPath(spaceAgentId, "/team-room");
  return withId ? `${base}?with=${encodeURIComponent(withId)}` : base;
}

/** Pre-#19 chat-area roots that now live under an agent's space. */
const LEGACY_CHAT_ROOTS = new Set([
  "connectors",
  "agent",
  "schedules",
  "skills",
  "skill",
  "channels",
  "contacts",
  "archive",
  "admin",
  "mcp",
]);

/**
 * Where a bare `/` or legacy chat-area path (e.g. /admin/providers) belongs in
 * the agent-scoped URL scheme, as `path?query`. A legacy path's `?agent=` picks
 * the agent and is dropped from the query. Returns null when the path is
 * already agent-scoped (or not a chat-area path), so callers never rewrite a
 * URL onto itself.
 */
export function legacyAgentRedirect(
  pathname: string,
  search: string,
  agentScope: string | null | undefined,
): string | null {
  const params = new URLSearchParams(search);
  let target: string;
  if (pathname === "/") {
    target = agentScopedPath(agentScope, "/");
  } else {
    const first = pathname.split("/").filter(Boolean)[0];
    if (!first || !LEGACY_CHAT_ROOTS.has(first)) return null;
    target = agentScopedPath(params.get("agent") || agentScope, pathname);
    params.delete("agent");
  }
  if (target === pathname) return null;
  const q = params.toString();
  return q ? `${target}?${q}` : target;
}

/**
 * Strips the leading agent slug (e.g. /amiro or /<agent-id>) from a pathname,
 * leaving the bare sub-path (e.g. /connectors, /agent/workspace).
 */
export function stripAgentPrefix(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const first = segments[0];
  if (RESERVED_PREFIXES.has(first) || LEGACY_CHAT_ROOTS.has(first)) {
    return pathname;
  }
  const rest = segments.slice(1).join("/");
  return rest ? `/${rest}` : "/";
}

/**
 * Checks if a pathname matches a target sub-path regardless of agent prefix.
 */
export function matchSubPath(pathname: string, targetSubPath: string): boolean {
  const stripped = stripAgentPrefix(pathname);
  if (targetSubPath === "/" || targetSubPath === "") {
    return stripped === "" || stripped === "/";
  }
  return stripped === targetSubPath || stripped.startsWith(`${targetSubPath}/`);
}

/**
 * Extracts the agent identifier from the first pathname segment, or null for Amiro/reserved.
 */
export function resolveAgentFromPathname(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0];
  if (RESERVED_PREFIXES.has(first) || LEGACY_CHAT_ROOTS.has(first)) {
    return null;
  }
  if (first === "amiro" || first === "main") return null;
  return decodeURIComponent(first);
}
