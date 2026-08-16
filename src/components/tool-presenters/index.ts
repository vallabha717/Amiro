import { agentPresenters } from "./agent-presenters";
import { codeIntelPresenters } from "./code-intel-presenters";
import { filePresenters } from "./file-presenters";
import { shellPresenters } from "./shell-presenters";
import type { ToolPresenter, ToolPresenterRegistry } from "./types";

export * from "./types";
export * from "./approval-card";

/**
 * The one place a tool name maps to how it looks.
 *
 * Both surfaces read this registry: chat renders `Expanded` inside a
 * message, the workflow canvas renders `glance`/`Compact` on the node face
 * and `Expanded` in the result dialog. Neither keeps its own switch
 * statement, so adding a tool means adding one entry here rather than
 * editing two unrelated files and forgetting the second.
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
};

export function getToolPresenter(
  toolName: string | undefined,
): ToolPresenter | undefined {
  if (!toolName) return undefined;
  return toolPresenters[toolName];
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
