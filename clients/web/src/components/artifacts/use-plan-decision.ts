"use client";

import { appStore } from "@/app/store";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { DefaultToolName } from "lib/ai/tools";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { GrantedMode } from "./plan-artifact";
import {
  type PlanArtifact,
  type PlanComment,
  buildPlanDecision,
} from "./use-artifacts";

/**
 * Answering a proposed plan, in one place.
 *
 * Two surfaces offer Proceed -- the artifact header and the plan card in the
 * chat stream -- because the user may be looking at either when they decide.
 * Both call this. Copies of "write the tool result, then change the
 * permission mode" are chances for one to forget the second half, and the
 * second half is the one that decides what the agent is allowed to do next.
 */
export function usePlanDecision(
  addToolResult?: UseChatHelpers<UIMessage>["addToolResult"],
) {
  const [permissionMode, modeBeforePlan, mutate] = appStore(
    useShallow((state) => [
      state.permissionMode,
      state.modeBeforePlan,
      state.mutate,
    ]),
  );

  /**
   * The mode Proceed will hand back.
   *
   * Approving a plan means "go do this", and Plan mode refuses every write,
   * so proceeding without changing the mode would leave the agent refused on
   * its first real step -- which reads as a bug, not as a policy.
   *
   * Restoring the mode the user was in beats picking one for them. Someone
   * who works in Manual and drops into Plan to think should land back in
   * Manual and keep approving individual writes; silently promoting them to
   * Edit because it is more convenient would grant, on their behalf, exactly
   * the permission Phase 3 exists to make them grant deliberately.
   */
  const grantedMode = useMemo<GrantedMode>(() => {
    if (permissionMode !== "plan") return permissionMode as GrantedMode;
    return modeBeforePlan ?? "manual";
  }, [permissionMode, modeBeforePlan]);

  const decide = useCallback(
    (
      plan: PlanArtifact,
      decision: "proceed" | "revise",
      comments: PlanComment[],
      mode: GrantedMode,
    ) => {
      if (!addToolResult) return;

      if (decision === "proceed" && permissionMode === "plan") {
        // Cleared alongside the switch: leaving it set would make a *later*
        // Plan session restore a mode the user chose for a different task.
        mutate({ permissionMode: mode, modeBeforePlan: undefined });
      }

      addToolResult({
        tool: DefaultToolName.ProposePlan,
        toolCallId: plan.toolCallId,
        output: buildPlanDecision(decision, comments, mode),
      });
    },
    [addToolResult, mutate, permissionMode],
  );

  return { grantedMode, decide };
}
