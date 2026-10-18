import type { ToolCategory } from "lib/chat-ux/tool-categories";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SessionPanelSection =
  | "agents"
  | "tasks"
  | "context"
  | "connectors"
  | "outputs";

/**
 * Chat presentation preferences: the right-hand session panel, the tool
 * filter, and which swarm agent the composer is talking to.
 *
 * Kept out of the main app store on purpose. That store's persisted shape is
 * versioned by name and carries safety-relevant settings (permission mode);
 * panel layout is cosmetic and should be free to change without a migration.
 */
export interface ChatUxState {
  panelOpen: boolean;
  collapsedSections: SessionPanelSection[];
  /** Tool categories hidden from the transcript. */
  hiddenToolCategories: ToolCategory[];
  /** Hide every tool row and keep only prose, images and answers. */
  hideAllTools: boolean;
  /**
   * Swarm member the composer addresses, per thread. Undefined means the
   * coordinator (the thread's own agent).
   */
  targetAgentByThread: Record<string, string | undefined>;
  /**
   * Swarm members open side by side with a thread, by session id, in the
   * order they were opened. The thread itself never goes away: opening an
   * agent adds a pane next to it, like the TUI's popped-out agent views.
   */
  agentPanesByThread: Record<string, string[]>;
  mutate: (
    patch:
      | Partial<Omit<ChatUxState, "mutate">>
      | ((s: ChatUxState) => Partial<Omit<ChatUxState, "mutate">>),
  ) => void;
}

export const chatUxStore = create<ChatUxState>()(
  persist(
    (set) => ({
      panelOpen: true,
      collapsedSections: [],
      hiddenToolCategories: [],
      hideAllTools: false,
      targetAgentByThread: {},
      agentPanesByThread: {},
      mutate: (patch) => set(patch as any),
    }),
    {
      name: "amiro-chat-ux-v1",
      partialize: (s) => ({
        panelOpen: s.panelOpen,
        collapsedSections: s.collapsedSections,
        hiddenToolCategories: s.hiddenToolCategories,
        hideAllTools: s.hideAllTools,
        // Kept across reloads: a user watching three agents work should get
        // the same layout back after a refresh.
        agentPanesByThread: s.agentPanesByThread,
      }),
    },
  ),
);

export function toggleIn<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** Open a swarm member beside `threadId` (no-op if already open). */
export function openAgentPane(threadId: string, sessionId: string) {
  chatUxStore.getState().mutate((s) => {
    const open = s.agentPanesByThread[threadId] ?? [];
    if (open.includes(sessionId)) return {};
    return { agentPanesByThread: { ...s.agentPanesByThread, [threadId]: [...open, sessionId] } };
  });
}

export function closeAgentPane(threadId: string, sessionId: string) {
  chatUxStore.getState().mutate((s) => ({
    agentPanesByThread: {
      ...s.agentPanesByThread,
      [threadId]: (s.agentPanesByThread[threadId] ?? []).filter((id) => id !== sessionId),
    },
  }));
}

export function toggleAgentPane(threadId: string, sessionId: string) {
  const open = chatUxStore.getState().agentPanesByThread[threadId] ?? [];
  if (open.includes(sessionId)) closeAgentPane(threadId, sessionId);
  else openAgentPane(threadId, sessionId);
}
