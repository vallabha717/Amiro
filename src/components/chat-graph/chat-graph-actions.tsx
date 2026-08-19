"use client";

import { type ReactNode, createContext, useContext } from "react";
import type { ArtifactTab } from "../artifacts/use-artifacts";

/**
 * What a graph node can do besides being looked at.
 *
 * React Flow hands a node only its `data`, which is derived from the
 * transcript and has to stay serializable -- callbacks cannot live there. A
 * context is the alternative that keeps the node dumb: it consumes actions
 * without knowing who supplies them, and the canvas stays a pure view of
 * `messages`.
 *
 * Both actions are optional. A read-only surface (a shared thread, an export)
 * renders the same graph with no way to answer a gate, and a node whose
 * buttons are absent is the honest rendering of that -- better than buttons
 * that appear and do nothing.
 */
export interface ChatGraphActions {
  openArtifact?: (tab: ArtifactTab) => void;
  /** Answer a suspended propose_plan call and let the run continue. */
  proceedWithPlan?: (toolCallId: string) => void;
  /** True while a turn is in flight, so the gate's buttons can disable. */
  busy?: boolean;
}

const ChatGraphActionsContext = createContext<ChatGraphActions>({});

export function ChatGraphActionsProvider({
  value,
  children,
}: {
  value: ChatGraphActions;
  children: ReactNode;
}) {
  return (
    <ChatGraphActionsContext.Provider value={value}>
      {children}
    </ChatGraphActionsContext.Provider>
  );
}

export function useChatGraphActions(): ChatGraphActions {
  return useContext(ChatGraphActionsContext);
}
