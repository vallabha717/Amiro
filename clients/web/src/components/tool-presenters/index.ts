import { agentPresenters } from "./agent-presenters";
import {
  artifactPresenters,
  withArtifactMcpCard,
} from "./artifact-presenters";
import { codeIntelPresenters } from "./code-intel-presenters";
import { filePresenters } from "./file-presenters";
import { jcodePresenters } from "./jcode-presenters";
import { planPresenters } from "./plan-presenters";
import { shellPresenters } from "./shell-presenters";
import type { ToolPresenter, ToolPresenterRegistry } from "./types";

export * from "./types";
export * from "./approval-card";

/**
 * The one place a tool name maps to how it looks.
 *
 * Both surfaces read this registry: chat renders `Expanded` inside a
 * message, and the approval card renders `Compact` as its body. Neither
 * keeps its own switch statement, so adding a tool means adding one entry
 * here rather than editing two unrelated files and forgetting the second.
 *
 * Presenters for the remaining older toolkits (charts, web search, image
 * generation) still live in `tool-invocation/` and are dispatched by
 * message-parts.tsx directly. They migrate into this registry as they are
 * touched -- the shell moved here in Phase 3 because the approval card
 * needs its `Compact` view. A big-bang refactor would risk regressing
 * renderers like interactive-table (526 lines, dynamically imported) for no
 * immediate gain.
 */
export const toolPresenters: ToolPresenterRegistry = {
  ...filePresenters,
  ...shellPresenters,
  ...agentPresenters,
  ...codeIntelPresenters,
  ...planPresenters,
  ...jcodePresenters,
  ...artifactPresenters,
  // Artifact operations dispatched through the runtime's mcp_call wrapper
  // render the file card; every other MCP call keeps the generic card.
  mcp_call: withArtifactMcpCard(jcodePresenters["mcp_call"]),
};

export function getToolPresenter(
  toolName: string | undefined,
): ToolPresenter | undefined {
  if (!toolName) return undefined;
  const direct = toolPresenters[toolName];
  if (direct) return direct;
  // Agent-bridge tools arrive namespaced with their server. The runtime
  // dispatches MCP tools as mcp__<server>__<tool> (double underscores);
  // older surfaces use single underscores. Resolve the bare tool so a
  // namespaced call renders the same card. Scoped to the amiro server on
  // purpose: stripping a segment off any unknown id could dress an
  // unrelated tool in the wrong card (propose_plan must never resolve
  // through plan).
  let rest = toolName;
  if (rest.startsWith("mcp__")) rest = rest.slice("mcp__".length);
  else if (rest.startsWith("mcp_")) rest = rest.slice("mcp_".length);
  if (rest.startsWith("amiro__")) rest = rest.slice("amiro__".length);
  else if (rest.startsWith("amiro_")) rest = rest.slice("amiro_".length);
  else return undefined;
  if (!rest || rest === toolName) return undefined;
  return toolPresenters[rest];
}

/**
 * Short label for a tool run, for surfaces that only have room for text.
 * Falls back to the tool name so an unregistered tool degrades to what the
 * UI would have shown anyway rather than to an empty string.
 */
export function toolGlance(
  toolName: string,
  props: Parameters<ToolPresenter["glance"]>[0],
): string {
  const presenter = getToolPresenter(toolName);
  if (!presenter) return toolName;
  try {
    return presenter.glance(props);
  } catch {
    return toolName;
  }
}
