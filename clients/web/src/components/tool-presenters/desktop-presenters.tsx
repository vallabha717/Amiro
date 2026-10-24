"use client";

import dynamic from "next/dynamic";
import { MAIN_AGENT_ID } from "@/lib/backend/agents-api";
import { useAgentScope } from "@/lib/backend/agent-scope";
import { windowsFromToolText } from "@/lib/backend/desktop-api";
import { textsOf } from "./artifact-presenters";
import type { PresenterProps, ToolPresenter } from "./types";

/**
 * The agent's desktop tools render the TV in the chat (Vellum shows the
 * assistant's screen inline the same way). The main agent's tools come from
 * the amiro MCP server (`desktop_open`, `desktop_state`); a team agent's run
 * in its container (`agent_desktop_open`, `agent_desktop_state`).
 */

// noVNC needs the browser, and only chats that use the desktop need it.
const DesktopChatCard = dynamic(
  () => import("@/components/desktop-preview/desktop-chat-card").then((m) => m.DesktopChatCard),
  { ssr: false },
);

const DESKTOP_TOOLS = [
  "desktop_open",
  "desktop_state",
  "agent_desktop_open",
  "agent_desktop_state",
] as const;
type DesktopTool = (typeof DESKTOP_TOOLS)[number];

function outputText(output: unknown): string {
  const parts: string[] = [];
  textsOf(output, parts);
  return parts.join("\n");
}

/** One line for the collapsed header: `desktop · open files /home/agent/x`. */
export function desktopGlance(tool: DesktopTool, { input, status }: PresenterProps): string {
  const opening = tool.endsWith("_open");
  if (status === "error") return opening ? "⚠ desktop open failed" : "⚠ desktop check failed";
  if (!opening) return status === "pending" ? "desktop · looking…" : "desktop · looked at the screen";
  const app = typeof input?.app === "string" ? input.app : "app";
  const target = typeof input?.target === "string" && input.target ? ` ${input.target}` : "";
  return `desktop · ${status === "pending" ? "opening" : "opened"} ${app}${target}`;
}

function DesktopToolCard({ tool, output, status, errorText }: PresenterProps & { tool: DesktopTool }) {
  const scope = useAgentScope();
  // Team agents' own tools act on their container; the amiro server's on main.
  const agentId = tool.startsWith("agent_") ? (scope ?? MAIN_AGENT_ID) : MAIN_AGENT_ID;
  return (
    <DesktopChatCard
      agentId={agentId}
      windows={status === "success" ? windowsFromToolText(outputText(output)) : []}
      pending={status === "pending"}
      error={status === "error" ? errorText || outputText(output) || undefined : undefined}
    />
  );
}

function presenterFor(tool: DesktopTool): ToolPresenter {
  const Card = (props: PresenterProps) => <DesktopToolCard {...props} tool={tool} />;
  return { glance: (props) => desktopGlance(tool, props), Compact: Card, Expanded: Card };
}

export const desktopPresenters: Record<DesktopTool, ToolPresenter> = Object.fromEntries(
  DESKTOP_TOOLS.map((tool) => [tool, presenterFor(tool)]),
) as Record<DesktopTool, ToolPresenter>;

/** `{server: "amiro", tool: "desktop_open", arguments}` from the runtime's mcp_call. */
function mcpDesktopTarget(input: any): { tool: DesktopTool; args: any } | undefined {
  if (input?.server !== "amiro" || typeof input?.tool !== "string") return undefined;
  const bare = input.tool.replace(/^(mcp__amiro__|amiro__|amiro_)/, "");
  return (DESKTOP_TOOLS as readonly string[]).includes(bare)
    ? { tool: bare as DesktopTool, args: input.arguments }
    : undefined;
}

/**
 * Whether a tool part is one of the desktop tools, called directly or through
 * the runtime's MCP dispatch. Chat pulls these out of the folded work log so
 * the TV is always visible, as it is for OpenUI surfaces.
 */
export function isDesktopToolCall(toolName: string | undefined, input: any): boolean {
  if (!toolName) return false;
  if ((DESKTOP_TOOLS as readonly string[]).includes(toolName.replace(/^(mcp__amiro__|amiro__|amiro_)/, ""))) {
    return true;
  }
  return (toolName === "mcp" || toolName === "mcp_call") && mcpDesktopTarget(input) !== undefined;
}

/** Desktop calls dispatched through mcp_call get the TV card; others keep `base`. */
export function withDesktopMcpCard(base: ToolPresenter): ToolPresenter {
  const pick = (props: PresenterProps) => {
    const target = mcpDesktopTarget(props.input);
    return target ? { presenter: desktopPresenters[target.tool], props: { ...props, input: target.args } } : undefined;
  };
  return {
    glance: (props) => {
      const hit = pick(props);
      return hit ? hit.presenter.glance(hit.props) : base.glance(props);
    },
    Compact: (props) => {
      const hit = pick(props);
      if (hit?.presenter.Compact) return hit.presenter.Compact(hit.props);
      return base.Compact ? base.Compact(props) : null;
    },
    Expanded: (props) => {
      const hit = pick(props);
      if (hit?.presenter.Expanded) return hit.presenter.Expanded(hit.props);
      return base.Expanded ? base.Expanded(props) : null;
    },
  };
}
