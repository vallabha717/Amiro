import { stepKindOf } from "lib/ai/tools/step-kind";

/**
 * The buckets the transcript's tool filter offers.
 *
 * Coarser than StepKind on purpose. StepKind answers "what happened" so a
 * work log can say "Explored 3 files"; this answers "which kind of noise do
 * I want out of the way", and a user hiding terminal output does not want
 * to hunt for `git` separately from `bash`.
 */
export type ToolCategory =
  | "terminal"
  | "files"
  | "web"
  | "connectors"
  | "agents"
  | "planning"
  | "other";

export const TOOL_CATEGORIES: {
  id: ToolCategory;
  label: string;
  description: string;
}[] = [
  {
    id: "terminal",
    label: "Terminal",
    description: "Shell commands, git, background jobs",
  },
  { id: "files", label: "Files", description: "Reads, searches and edits" },
  { id: "web", label: "Web", description: "Search, fetch, browser, HTTP" },
  {
    id: "connectors",
    label: "Connectors",
    description: "Gmail, Calendar, MCP and Composio tools",
  },
  {
    id: "agents",
    label: "Agents",
    description: "Swarm, subagents, delegated tasks",
  },
  { id: "planning", label: "Planning", description: "Todos, plans, memory" },
  { id: "other", label: "Other", description: "Everything else" },
];

/**
 * Connector tools arrive under several naming schemes: the runtime's own
 * `gmail`/`calendar`, Claude-style `mcp__server__tool`, `server_tool` from
 * the MCP bridge, and Composio's upper-case `GMAIL_SEND_EMAIL` slugs. Match
 * the scheme, not a list of servers, so a newly connected app is still a
 * connector without anyone editing this file.
 */
const CONNECTOR_PATTERNS: RegExp[] = [
  /^mcp(__|_|$)/i,
  /^composio/i,
  /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/, // Composio action slugs
  /^(gmail|calendar|gcal|gdrive|drive|slack|notion|linear|github|jira|figma|outlook|teams)([_.-]|$)/i,
];

export function toolCategoryOf(
  toolName: string | undefined,
  input?: unknown,
): ToolCategory {
  if (!toolName) return "other";
  if (CONNECTOR_PATTERNS.some((re) => re.test(toolName))) return "connectors";

  switch (stepKindOf(toolName, input)) {
    case "command":
      return "terminal";
    case "explore":
    case "edit":
    case "orient":
      return "files";
    case "search":
      return "web";
    case "delegate":
      return "agents";
    case "plan":
    case "remember":
    case "summarize":
      return "planning";
    default:
      return "other";
  }
}

/** Short human name for a connector tool, e.g. `mcp__gmail__send` -> `gmail`. */
export function connectorNameOf(toolName: string): string | undefined {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName);
  if (mcp) return mcp[1];
  const slug = /^([A-Z][A-Z0-9]*)_/.exec(toolName);
  if (slug) return slug[1].toLowerCase();
  const plain = /^(gmail|calendar|gcal|gdrive|drive|slack|notion|linear|github|jira|figma|outlook|teams)/i.exec(
    toolName,
  );
  return plain?.[1].toLowerCase();
}
