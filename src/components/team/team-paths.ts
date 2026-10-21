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

/**
 * Strips the leading agent slug (e.g. /amiro or /<agent-id>) from a pathname,
 * leaving the bare sub-path (e.g. /connectors, /agent/workspace).
 */
export function stripAgentPrefix(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const first = segments[0];
  if (RESERVED_PREFIXES.has(first)) return pathname;
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
  if (RESERVED_PREFIXES.has(first)) return null;
  if (first === "amiro" || first === "main") return null;
  return decodeURIComponent(first);
}
