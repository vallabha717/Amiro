import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ChatMention, ChatModel, ChatThread } from "app-types/chat";
import { AllowedMCPServer, MCPServerInfo } from "app-types/mcp";
import { OPENAI_VOICE } from "lib/ai/speech/open-ai/use-voice-chat.openai";
import { AppDefaultToolkit } from "lib/ai/tools";
import { ArchiveWithItemCount } from "app-types/archive";

export interface UploadedFile {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
  isUploading?: boolean;
  progress?: number;
  previewUrl?: string;
  abortController?: AbortController;
  dataUrl?: string; // Full data URL format: "data:image/png;base64,..."
}

export interface AppState {
  threadList: ChatThread[];
  mcpList: (MCPServerInfo & { id: string })[];
  currentThreadId: ChatThread["id"] | null;
  toolChoice: "auto" | "none" | "manual";
  /**
   * How much the agent may do without asking, sent with every chat request
   * and enforced server-side (backend-go/internal/agent/permission).
   *
   * Persisted, and deliberately defaulted to "interactive" rather than
   * "auto": this is the setting that decides whether a model can overwrite
   * a file or run a shell command unattended, and a preference that
   * silently comes back as the permissive one after a browser restart is
   * not a safety control.
   */
  permissionMode: "plan" | "manual" | "interactive" | "edit" | "auto";
  projectDirectory: string;
  recentProjectDirectories: string[];
  allowedMcpServers?: Record<string, AllowedMCPServer>;
  allowedAppDefaultToolkit?: AppDefaultToolkit[];
  generatingTitleThreadIds: string[];
  archiveList: ArchiveWithItemCount[];
  threadMentions: {
    [threadId: string]: ChatMention[];
  };
  threadFiles: {
    [threadId: string]: UploadedFile[];
  };
  threadImageToolModel: {
    [threadId: string]: string | undefined;
  };
  toolPresets: {
    allowedMcpServers?: Record<string, AllowedMCPServer>;
    allowedAppDefaultToolkit?: AppDefaultToolkit[];
    name: string;
  }[];
  chatModel?: ChatModel;
  openShortcutsPopup: boolean;
  openChatPreferences: boolean;
  openUserSettings: boolean;
  mcpCustomizationPopup?: MCPServerInfo & { id: string };
  temporaryChat: {
    isOpen: boolean;
    instructions: string;
    chatModel?: ChatModel;
  };
  voiceChat: {
    isOpen: boolean;
    options: {
      provider: string;
      providerOptions?: Record<string, any>;
    };
  };
  /**
   * The artifact pane: the implementation plan, the task list, and the
   * walkthrough.
   *
   * `openedFor` is the tool call id the pane was last auto-opened for, and
   * exists so the auto-open fires once per proposal. Without it, a user who
   * closes the pane to read the chat has it reopened on the next render --
   * the same "auto-collapse fires once" rule the work log follows.
   */
  artifactView: {
    isOpen: boolean;
    tab: "plan" | "tasks" | "walkthrough" | "files";
    openedFor?: string;
    /** File artifact to select when the Files tab opens (set by the chat card's Open button). */
    fileId?: string;
    /** Workspace file to show in the Files tab viewer (set by clicking a path in chat). */
    workspacePath?: string;
  };
  /**
   * The permission mode in effect before the user switched to Plan.
   *
   * Approving a plan means "go do this", so Proceed has to restore a mode
   * that can actually write. Remembering what they were in beats picking one:
   * a user who works in Manual and drops into Plan to think should come back
   * to Manual, not be silently promoted to something more permissive.
   */
  modeBeforePlan?: "manual" | "interactive" | "edit" | "auto";
  pendingThreadMention?: ChatMention;
  pendingChatPrompt?: string;
}

export interface AppDispatch {
  mutate: (state: Mutate<AppState>) => void;
}

const initialState: AppState = {
  threadList: [],
  archiveList: [],
  generatingTitleThreadIds: [],
  threadMentions: {},
  threadFiles: {},
  threadImageToolModel: {},
  mcpList: [],
  currentThreadId: null,
  toolChoice: "auto",
  permissionMode: "auto",
  projectDirectory: "",
  recentProjectDirectories: [],
  allowedMcpServers: undefined,
  openUserSettings: false,
  allowedAppDefaultToolkit: [
    AppDefaultToolkit.Code,
    AppDefaultToolkit.Visualization,
    AppDefaultToolkit.File,
    AppDefaultToolkit.Memory,
    AppDefaultToolkit.WebSearch,
    AppDefaultToolkit.Http,
  ],
  toolPresets: [],
  chatModel: undefined,
  openShortcutsPopup: false,
  openChatPreferences: false,
  mcpCustomizationPopup: undefined,
  temporaryChat: {
    isOpen: false,
    instructions: "",
  },
  voiceChat: {
    isOpen: false,
    options: {
      provider: "openai",
      providerOptions: {
        model: OPENAI_VOICE["Alloy"],
      },
    },
  },
  artifactView: {
    isOpen: false,
    tab: "plan",
  },
  modeBeforePlan: undefined,
  pendingThreadMention: undefined,
  pendingChatPrompt: undefined,
};

export const appStore = create<AppState & AppDispatch>()(
  persist(
    (set) => ({
      ...initialState,
      mutate: set,
    }),
    {
      name: "mc-app-store-v2.0.1",
      partialize: (state) => ({
        chatModel: state.chatModel || initialState.chatModel,
        toolChoice: state.toolChoice || initialState.toolChoice,
        permissionMode: state.permissionMode || initialState.permissionMode,
        projectDirectory: state.projectDirectory || initialState.projectDirectory,
        recentProjectDirectories:
          state.recentProjectDirectories || initialState.recentProjectDirectories,
        allowedMcpServers:
          state.allowedMcpServers || initialState.allowedMcpServers,
        allowedAppDefaultToolkit: (
          state.allowedAppDefaultToolkit ??
          initialState.allowedAppDefaultToolkit
        )?.filter((v) => Object.values(AppDefaultToolkit).includes(v)),
        temporaryChat: {
          ...initialState.temporaryChat,
          ...state.temporaryChat,
          isOpen: false,
        },
        toolPresets: state.toolPresets || initialState.toolPresets,
        // Deliberately not persisted open. The pane belongs to a specific
        // proposal in a specific thread; restoring it across a reload into a
        // different conversation would show an artifact from another one.
        // `modeBeforePlan` does persist, because the round trip it serves
        // (switch to Plan, reload, approve) spans exactly that boundary.
        modeBeforePlan: state.modeBeforePlan,
        voiceChat: {
          ...initialState.voiceChat,
          ...state.voiceChat,
          isOpen: false,
        },
      }),
    },
  ),
);
