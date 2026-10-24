"use client";

import { appStore } from "@/app/store";
import { useChat } from "@ai-sdk/react";
import clsx from "clsx";
import { cn, createDebounce, generateUUID } from "lib/utils";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { chatFilesFrom } from "lib/file-preview/chat-files";
import { ArtifactPane } from "./artifacts/artifact-pane";
import { buildPlanDecision, useArtifacts } from "./artifacts/use-artifacts";
import { ChatGreeting } from "./chat-greeting";
import { LoginPanel } from "./chat/login-panel";
import { ErrorMessage, PreviewMessage } from "./message";
import PromptInput from "./prompt-input";
import { MemberThreadBanner } from "./workspace/agent-switcher";
import { SwarmStrip } from "./workspace/swarm-strip";
import { ChatToolbar } from "./workspace/chat-toolbar";
import { SessionPanel } from "./workspace/session-panel";
import { AgentPane } from "./workspace/agent-pane";
import { useSwarm, type SwarmMember } from "@/lib/backend/swarm-api";
import { getAgentScope } from "@/lib/backend/agent-scope";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "ui/resizable";

import {
  DefaultChatTransport,
  TextUIPart,
  UIMessage,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useShallow } from "zustand/shallow";

import { chatUxStore } from "@/app/store/chat-ux-store";
import {
  type PendingFollowUp,
  restoreParkedFiles,
} from "@/lib/chat/followup-queue";
import { summarizeSession } from "lib/chat-ux/session-summary";
import { applyRuntimeThreadTitle } from "@/lib/backend/runtime-thread-title";
import { useFileDragOverlay } from "@/hooks/use-file-drag-overlay";
import { useToRef } from "@/hooks/use-latest";
import { useMounted } from "@/hooks/use-mounted";
import { useThreadFileUploader } from "@/hooks/use-thread-file-uploader";
import { useMessageReadAloudStore } from "@/lib/ai/speech/read-aloud-store";
import { deleteThread } from "@/lib/backend/chat-api";
import { useFileArtifacts } from "@/lib/backend/artifacts-api";
import { backendFetch } from "@/lib/backend/client";
import { backendUrl } from "@/lib/backend/config";
import { getCachedVoiceSettings } from "@/lib/backend/voice-api";
import {
  ChatApiSchemaRequestBody,
  ChatAttachment,
  ChatModel,
} from "app-types/chat";
import { AnimatePresence, motion } from "framer-motion";
import { DefaultToolName } from "lib/ai/tools";
import { getStorageManager } from "lib/browser-stroage";
import { Shortcuts, isShortcutEvent } from "lib/keyboard-shortcuts";
import { ArrowDown, FilePlus, Loader } from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useVoiceStore } from "@/lib/voice/voice-store";
import { useVoiceChatBridge } from "@/lib/voice/use-voice-chat-bridge";
import { VoiceDock, VoiceRoom } from "./voice-room/voice-room";
import { mutate } from "swr";
import { safe } from "ts-safe";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Think } from "ui/think";
import { WorkStatusDock } from "./work-status-dock";
import { TextShimmer } from "ui/text-shimmer";

type Props = {
  threadId: string;
  initialMessages: Array<UIMessage>;
  selectedChatModel?: string;
  /** Team agent this chat belongs to (sent as `agentId`); unset = main chat. */
  agentId?: string;
  /** URL to show once the first message is sent; defaults to `/?thread=<id>`. */
  threadPath?: string;
  /** Replaces the greeting shown while the chat is empty. */
  emptyState?: ReactNode;
  /** Replaces the composer's folder picker when the folder is fixed. */
  workspaceLabel?: string;
};

const LightRays = dynamic(() => import("ui/light-rays"), {
  ssr: false,
});

const Particles = dynamic(() => import("ui/particles"), {
  ssr: false,
});

const debounce = createDebounce();

const firstTimeStorage = getStorageManager("IS_FIRST");
const isFirstTime = firstTimeStorage.get() ?? true;
firstTimeStorage.set(false);

export default function ChatBot({
  threadId,
  initialMessages,
  agentId,
  threadPath,
  emptyState,
  workspaceLabel,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The composer, dock and strips float over the message list; the list's
  // bottom padding follows their real height so nothing scrolls under them.
  const overlayRef = useRef<HTMLDivElement>(null);
  const [overlayHeight, setOverlayHeight] = useState(176);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const { uploadFiles } = useThreadFileUploader(threadId);
  const handleFileDrop = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      await uploadFiles(files);
    },
    [uploadFiles],
  );
  const { isDragging } = useFileDragOverlay({
    onDropFiles: handleFileDrop,
  });

  const [
    appStoreMutate,
    model,
    toolChoice,
    permissionMode,
    projectDirectory,
    allowedAppDefaultToolkit,
    allowedMcpServers,
    threadList,
    threadMentions,
    pendingThreadMention,
    pendingChatPrompt,
    threadImageToolModel,
    artifactView,
  ] = appStore(
    useShallow((state) => [
      state.mutate,
      state.chatModel,
      state.toolChoice,
      state.permissionMode,
      state.projectDirectory,
      state.allowedAppDefaultToolkit,
      state.allowedMcpServers,
      state.threadList,
      state.threadMentions,
      state.pendingThreadMention,
      state.pendingChatPrompt,
      state.threadImageToolModel,
      state.artifactView,
    ]),
  );

  const [showParticles, setShowParticles] = useState(isFirstTime);
  const showParticlesRef = useRef(showParticles);
  showParticlesRef.current = showParticles;

  const onFinish = useCallback(
    (finishEvent?: { message?: UIMessage; messages?: UIMessage[] }) => {
      const messages = finishEvent?.messages ?? latestRef.current.messages;
      // The runtime names the session during the real chat turn. Refresh its
      // persisted mapping, never send a second inference request just for a title.
      void mutate("/api/thread");

      try {
        const voiceSettings = getCachedVoiceSettings();
        // In a voice call the live session already speaks every answer.
        if (
          voiceSettings.readAloudEnabled &&
          voiceSettings.autoReadAloud &&
          !useVoiceStore.getState().active
        ) {
          const lastAssistantMsg =
            (finishEvent?.message?.role === "assistant"
              ? finishEvent.message
              : undefined) ??
            [...messages].reverse().find((m) => m.role === "assistant");
          if (lastAssistantMsg) {
            const text = (lastAssistantMsg.parts ?? [])
              .filter((p) => p.type === "text")
              .map((p) => (p as TextUIPart).text)
              .join("\n\n");
            if (text.trim()) {
              void useMessageReadAloudStore.getState().playMessage({
                messageId: lastAssistantMsg.id,
                text,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    },
    [],
  );

  const [input, setInput] = useState("");

  // A follow-up typed while the agent is still responding. Enter parks it
  // here instead of being swallowed; it flushes as the next turn once the
  // current one settles. Single slot: a newer follow-up replaces the older
  // one, so there is never an ambiguous backlog. Owned by thread key
  // (ChatBot remounts per thread), so a thread switch drops the draft the
  // same way it drops the composer's text.
  const [pendingFollowUp, setPendingFollowUp] =
    useState<PendingFollowUp | null>(null);
  const pendingRef = useRef<PendingFollowUp | null>(null);
  pendingRef.current = pendingFollowUp;

  // The ai SDK's makeRequest re-checks sendAutomaticallyWhen after *every*
  // request settles, including one the user just aborted via stop() --
  // gated only on the request not having errored, and an abort is not an
  // error (ai/dist/index.mjs's makeRequest, the `!isError` branch after its
  // finally block). So a Stop click that lands while the last model step's
  // tool calls all happen to already be resolved -- common mid-turn, since
  // that is exactly when the model is generating the *next* step and the
  // user has time to react -- gets silently followed by a fresh request,
  // and the agent keeps going as if nothing happened. This ref is consumed
  // by the very next sendAutomaticallyWhen check so that one, and only
  // that one, resumption is suppressed.
  const suppressNextAutoResumeRef = useRef(false);

  const {
    messages,
    status,
    setMessages,
    addToolResult: _addToolResult,
    error,
    sendMessage,
    stop,
  } = useChat({
    id: threadId,
    sendAutomaticallyWhen: (params) => {
      if (suppressNextAutoResumeRef.current) {
        suppressNextAutoResumeRef.current = false;
        return false;
      }
      return lastAssistantMessageIsCompleteWithToolCalls(params);
    },
    transport: new DefaultChatTransport({
      api: backendUrl("/api/chat"),
      fetch: backendFetch,
      prepareSendMessagesRequest: ({ messages, body, id }) => {
        // In a team agent's space or Amiro the URL names the agent/amiro.
        const scope = getAgentScope();
        const prefix = scope ? `/${encodeURIComponent(scope)}` : "/amiro";
        const threadUrl = threadPath ?? `${prefix}?thread=${threadId}`;
        if (window.location.pathname + window.location.search !== threadUrl) {
          console.log("replace-state");
          window.history.replaceState({}, "", threadUrl);
        }
        const lastMessage = messages.at(-1)!;
        // Filter out UI-only parts (e.g., source-url) so the model doesn't receive unknown parts
        const attachments: ChatAttachment[] = lastMessage.parts.reduce(
          (acc: ChatAttachment[], part: any) => {
            if (part?.type === "file") {
              acc.push({
                type: "file",
                url: part.url,
                mediaType: part.mediaType,
                filename: part.filename,
              });
            } else if (part?.type === "source-url") {
              acc.push({
                type: "source-url",
                url: part.url,
                mediaType: part.mediaType,
                filename: part.title,
              });
            }
            return acc;
          },
          [],
        );

        const sanitizedLastMessage = {
          ...lastMessage,
          parts: lastMessage.parts.filter((p: any) => p?.type !== "source-url"),
        } as typeof lastMessage;
        const hasFilePart = lastMessage.parts?.some(
          (p) => (p as any)?.type === "file",
        );

        const hasNonSkillMention = latestRef.current.mentions?.some(
          (m) => m.type !== "skill",
        );

        const requestBody: ChatApiSchemaRequestBody = {
          ...body,
          id,
          chatModel:
            (body as { model: ChatModel })?.model ?? latestRef.current.model,
          toolChoice: latestRef.current.toolChoice,
          permissionMode: latestRef.current.permissionMode,
          workspaceRoot: latestRef.current.projectDirectory || undefined,
          workingDir: latestRef.current.projectDirectory || undefined,
          projectDirectory: latestRef.current.projectDirectory || undefined,
          allowedAppDefaultToolkit:
            hasNonSkillMention || hasFilePart
              ? []
              : latestRef.current.allowedAppDefaultToolkit,
          allowedMcpServers: hasNonSkillMention
            ? {}
            : latestRef.current.allowedMcpServers,
          mentions: latestRef.current.mentions,
          message: sanitizedLastMessage,
          imageTool: {
            model: latestRef.current.threadImageToolModel[threadId],
          },
          attachments,
          // In a team agent's space (agent-scope.ts) every new chat is with
          // that agent.
          agentId: agentId ?? getAgentScope() ?? undefined,
        };
        return { body: requestBody };
      },
    }),
    messages: initialMessages,
    generateId: generateUUID,
    experimental_throttle: 100,
    onData: (part) => {
      if (part.type === "data-thread-title") {
        applyRuntimeThreadTitle(part.data, threadId);
      }
    },
    onFinish,
  });
  const [isDeleteThreadPopupOpen, setIsDeleteThreadPopupOpen] = useState(false);
  // `/login` is intercepted in the composer (see handleComposerSend below) and
  // opens this inline panel instead of ever becoming a message.
  const [isLoginPanelOpen, setIsLoginPanelOpen] = useState(false);

  const addToolResult = useCallback(
    async (result: Parameters<typeof _addToolResult>[0]) => {
      await _addToolResult(result);
      // sendMessage();
    },
    [_addToolResult],
  );

  // Stop must mean stop -- see suppressNextAutoResumeRef above for why the
  // library's own abort isn't enough on its own.
  const handleStop = useCallback(() => {
    suppressNextAutoResumeRef.current = true;
    stop();
  }, [stop]);

  const mounted = useMounted();

  const latestRef = useToRef({
    toolChoice,
    permissionMode,
    projectDirectory,
    model,
    allowedAppDefaultToolkit,
    allowedMcpServers,
    messages,
    threadList,
    threadId,
    mentions: threadMentions[threadId],
    threadImageToolModel,
  });

  const isLoading = useMemo(
    () => status === "streaming" || status === "submitted",
    [status],
  );

  const emptyMessage = useMemo(
    () => messages.length === 0 && !error,
    [messages.length, error],
  );

  // The plan, task list and walkthrough, read back out of the transcript.
  const artifacts = useArtifacts(messages, isLoading);
  const chatFiles = useMemo(() => chatFilesFrom(messages), [messages]);
  const { data: fileArtifacts } = useFileArtifacts(true);

  // Agents, tasks, context, connectors and outputs for the session panel,
  // read back out of the same transcript the artifacts come from.
  const sessionSummary = useMemo(
    () => summarizeSession(messages, isLoading),
    [messages, isLoading],
  );
  const sessionPanelOpen = chatUxStore((state) => state.panelOpen);

  const hasArtifact = Boolean(
    artifacts.plan ||
      artifacts.todos ||
      artifacts.walkthrough ||
      (fileArtifacts?.length ?? 0) > 0,
  );
  // The Files tab is server state rather than transcript state, and the
  // toolbar opens it directly — so an explicitly opened Files tab counts as
  // active even before the first file exists.
  const isArtifactViewActive =
    artifactView.isOpen && (hasArtifact || artifactView.tab === "files");

  // Swarm agents open side by side with this chat. The chat itself stays on
  // screen, exactly as the TUI keeps the main transcript while an agent is
  // popped out; panes are only added next to it.
  const openPaneIds = chatUxStore(
    (state) => state.agentPanesByThread[threadId],
  );
  const { data: swarm } = useSwarm(
    openPaneIds?.length ? threadId : undefined,
    isLoading,
  );
  const agentPanes = useMemo(() => {
    if (!openPaneIds?.length) return [];
    const known: SwarmMember[] = [
      ...(swarm?.coordinator ? [swarm.coordinator] : []),
      ...(swarm?.members ?? []),
    ];
    return openPaneIds.flatMap((sessionId) => {
      const member =
        known.find((m) => m.sessionId === sessionId) ??
        // Not reported yet (just spawned, or the poll has not landed):
        // show it under the label its spawn call gave it.
        (() => {
          const s = sessionSummary.spawned.find(
            (x) => x.sessionId === sessionId,
          );
          return s
            ? ({
                sessionId,
                label: s.label,
                swarmStatus: "running",
                userConnected: false,
              } as SwarmMember)
            : ({ sessionId, userConnected: false } as SwarmMember);
        })();
      return [
        {
          member,
          coordinator: member.sessionId === swarm?.coordinator?.sessionId,
        },
      ];
    });
  }, [openPaneIds, swarm, sessionSummary.spawned]);
  const showAgentPanes = agentPanes.length > 0 && !isArtifactViewActive;
  const chatPanelSize = showAgentPanes
    ? Math.max(34, 100 - 33 * agentPanes.length)
    : 100;

  // The assistant message an in-flight turn's artifacts belong to. A revised
  // plan reuses this same id (the suspend/resume round trip continues the
  // same message rather than minting a new one -- see route.go), so keying
  // auto-open on it is what makes "once per turn" and "once per proposal"
  // the same rule: a revision does not reopen a pane the user already has
  // open on the growing document, but a genuinely new turn gets a fresh shot.
  const latestAssistantMessageId = useMemo(() => {
    const last = messages.at(-1);
    return last?.role === "assistant" ? last.id : undefined;
  }, [messages]);

  // Auto-open the instant a plan or walkthrough *starts* -- not once it
  // finishes. That is the entire point: the document is worth watching grow,
  // and waiting for the tool call to fully resolve before showing anything
  // is the wait this exists to remove. Only when nothing else owns the wide
  // pane, and only once per turn -- reopening on every render would fight a
  // user who closed it to read the chat, the same mistake the work log's
  // auto-collapse was careful not to make.
  //
  // Tasks is deliberately not part of this. A todo list is routine -- most
  // turns write one -- and popping the pane open for it would make the
  // feature feel naggy rather than helpful. Its content already streams live
  // in the work log, and once the pane is open for any reason the Tasks tab
  // shows the same live list.
  useEffect(() => {
    if (!latestAssistantMessageId) return;
    if (artifactView.openedFor === latestAssistantMessageId) return;
    const tab = artifacts.plan
      ? "plan"
      : artifacts.walkthrough
        ? "walkthrough"
        : undefined;
    if (!tab) return;
    appStoreMutate((state) => ({
      artifactView: {
        ...state.artifactView,
        isOpen: true,
        tab,
        openedFor: latestAssistantMessageId,
      },
    }));
  }, [
    latestAssistantMessageId,
    artifacts.plan,
    artifacts.walkthrough,
    artifactView.openedFor,
    appStoreMutate,
  ]);

  const isInitialThreadEntry = useMemo(
    () =>
      initialMessages.length > 0 &&
      initialMessages.at(-1)?.id === messages.at(-1)?.id,
    [messages],
  );

  /**
   * The propose_plan call the transcript is currently suspended on, if any.
   *
   * A plan is the one pause that is not a prompt. Every other unresolved tool
   * call is a question with a fixed set of answers -- approve this write, deny
   * it -- and the composer stays locked because typing prose at it would go
   * nowhere. A proposed plan is a document, and "actually, do it this way
   * instead" is the most natural thing a reader has to say about one. Locking
   * the composer on it left the turn looking hung with no way out but the two
   * buttons in the artifact header.
   */
  const pendingPlanToolCallId = useMemo(() => {
    if (status != "ready") return undefined;
    const lastMessage = messages.at(-1);
    if (lastMessage?.role != "assistant") return undefined;
    for (const part of lastMessage.parts ?? []) {
      if (!isToolUIPart(part)) continue;
      if (getToolName(part) !== DefaultToolName.ProposePlan) continue;
      if (part.state.startsWith("output")) continue;
      return part.toolCallId;
    }
    return undefined;
  }, [status, messages]);

  const isPendingToolCall = useMemo(() => {
    if (status != "ready") return false;
    const lastMessage = messages.at(-1);
    if (lastMessage?.role != "assistant") return false;
    const lastPart = lastMessage.parts?.at(-1);
    if (!lastPart) return false;
    if (!isToolUIPart(lastPart)) return false;
    if (lastPart.state.startsWith("output")) return false;
    // A suspended plan is answerable by typing; see pendingPlanToolCallId.
    if (getToolName(lastPart) === DefaultToolName.ProposePlan) return false;
    return true;
  }, [status, messages]);

  /**
   * Send a chat message, answering a suspended plan first if there is one.
   *
   * A tool call left unresolved is not a state the transcript can be sent in
   * -- the provider rejects a tool_use with no tool_result -- so a user who
   * replies in prose rather than clicking Proceed has to have their reply
   * turned into an answer. It is a *revision*: they did not approve, so the
   * agent must not start work, and the message they just wrote is the reason
   * why. The note points the model at it rather than duplicating it, because
   * the message itself arrives in the same request, one turn later.
   *
   * The auto-resume suppression is the same one Stop uses: writing a tool
   * result satisfies `lastAssistantMessageIsCompleteWithToolCalls`, which
   * would fire a request of its own carrying the answer but not the message
   * the user is sending in the same breath.
   */
  const sendMessageAnsweringPlan = useCallback<typeof sendMessage>(
    async (...args) => {
      if (pendingPlanToolCallId) {
        suppressNextAutoResumeRef.current = true;
        await _addToolResult({
          tool: DefaultToolName.ProposePlan,
          toolCallId: pendingPlanToolCallId,
          output: buildPlanDecision("revise", [
            {
              quote: "",
              note: "The user replied in chat instead of answering here. Do not start work; read their next message and treat it as their response to this plan.",
            },
          ]),
        });
      }
      return sendMessage(...args);
    },
    [pendingPlanToolCallId, _addToolResult, sendMessage],
  );

  /**
   * The composer's own send path, wrapping sendMessageAnsweringPlan so a bare
   * `/login` command opens the provider panel instead of being sent.
   *
   * It has to happen here -- before the message reaches useChat -- because
   * sendMessage appends to the transcript immediately: intercepting any later
   * would put the command in the thread and, worse, ship it to the model.
   * Nothing here ever forwards the command text to the chat API.
   */
  const handleComposerSend = useCallback<typeof sendMessage>(
    async (...args) => {
      const first = args[0];
      let text: string | undefined;
      if (typeof first === "string") {
        text = first;
      } else if (first && Array.isArray((first as { parts?: unknown }).parts)) {
        const textParts = (
          first as { parts: Array<{ type?: string; text?: string }> }
        ).parts.filter((part) => part?.type === "text");
        if (textParts.length === 1) text = textParts[0].text;
      }
      if (text?.trim().toLowerCase() === "/login") {
        setIsLoginPanelOpen(true);
        return;
      }
      return sendMessageAnsweringPlan(...args);
    },
    [sendMessageAnsweringPlan],
  );

  // The plan-aware send above, reachable from the queue flush below. A ref
  // (not a dep) because the flush effect must not resubscribe or refire when
  // the plan state changes mid-turn.
  const sendAnsweringPlanRef = useRef(sendMessageAnsweringPlan);
  sendAnsweringPlanRef.current = sendMessageAnsweringPlan;

  /**
   * Send a parked follow-up as a fresh turn, translating its plan-revision
   * the same way a live reply would: answering a suspended plan first, then
   * sending the follow-up text as the user's response to it.
   */
  const flushPendingFollowUp = useCallback(async (pending: PendingFollowUp) => {
    try {
      await sendAnsweringPlanRef.current({
        role: "user",
        parts: pending.attachmentParts as any,
      });
    } catch {
      // The turn failed (offline, provider down): hand the text back so
      // nothing the user typed is lost.
      setInput(pending.text);
    }
  }, []);

  /**
   * Interrupt the live turn and send the follow-up at once (Cmd/Ctrl+Enter).
   * The stop is desynced from the flush so the stop's abort-settle can never
   * swallow the very message the user asked to send right now: the parked
   * message waits for status to land on ready, then flushes. If the user
   * parks something else in the meantime, that newer message wins.
   */
  const interruptAndSend = useCallback(
    (pending: PendingFollowUp) => {
      setPendingFollowUp(pending);
      suppressNextAutoResumeRef.current = true;
      stop();
    },
    [stop],
  );

  /**
   * Cancel the parked follow-up. The composer is empty (parking cleared it),
   * so hand the text and its files back untouched.
   */
  const cancelPendingFollowUp = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    setPendingFollowUp(null);
    setInput(pending.text);
    if (pending.files.length > 0) {
      appStoreMutate((prev) => ({
        threadFiles: {
          ...prev.threadFiles,
          [threadId]: [
            ...(prev.threadFiles[threadId] ?? []),
            ...restoreParkedFiles(
              prev.threadFiles[threadId] ?? [],
              pending.files,
            ),
          ],
        },
      }));
    }
  }, [threadId, appStoreMutate]);

  /**
   * Park a follow-up typed while the agent responds. Single slot: a newer
   * follow-up replaces the older one. If it arrives mid-stop (the previous
   * turn was just interrupted and has not settled yet), it takes over as the
   * message that flushes; otherwise it waits for the live turn to finish.
   */
  const queuePendingFollowUp = useCallback((pending: PendingFollowUp) => {
    setPendingFollowUp(pending);
  }, []);

  /**
   * Flush the parked follow-up once the transcript is idle again. Gated on
   * `status` (not `isLoading`): an approval halt also has status ready, but
   * its transcript cannot take a new turn until the tool call is resolved,
   * hence the extra gate. Clears the slot *before* sending: a failed flush
   * restores the text to the composer instead of leaving a stale chip that
   * would flush twice.
   */
  useEffect(() => {
    if (status !== "ready") return;
    if (error) return;
    const pending = pendingRef.current;
    if (!pending) return;
    if (isPendingToolCall) return;
    setPendingFollowUp(null);
    void flushPendingFollowUp(pending);
  }, [status, error, isPendingToolCall, flushPendingFollowUp]);

  // Voice: spoken turns go through the same chat stream as typed ones, and
  // the answer streams back to the voice session to be spoken.
  useVoiceChatBridge({
    messages,
    status,
    sendMessage: handleComposerSend as any,
    stop: handleStop,
  });
  const voiceActive = useVoiceStore((s) => s.active);
  const voiceMinimized = useVoiceStore((s) => s.minimized);

  // Relay `sendPrompt(text)` calls from inline VisualSurface iframes as real
  // user turns on the active conversation.
  useEffect(() => {
    const onVisualPrompt = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      const prompt = typeof detail?.prompt === "string" ? detail.prompt.trim() : "";
      if (!prompt) return;
      void handleComposerSend({
        role: "user",
        parts: [{ type: "text", text: prompt }],
      });
    };
    window.addEventListener("amiro:send-prompt", onVisualPrompt);
    return () => window.removeEventListener("amiro:send-prompt", onVisualPrompt);
  }, [handleComposerSend]);

  const space = useMemo(() => {
    if (!isLoading || error) return false;
    const lastMessage = messages.at(-1);
    if (lastMessage?.role == "user") return "think";
    const lastPart = lastMessage?.parts?.at(-1);
    if (!lastPart) return "think";
    const secondPart = lastMessage?.parts?.[1];
    if (secondPart?.type == "text" && secondPart.text.length == 0)
      return "think";
    if (lastPart?.type == "step-start") {
      return lastMessage?.parts?.length == 1 ? "think" : "space";
    }
    return false;
  }, [isLoading, messages.at(-1)]);

  const particle = useMemo(() => {
    return (
      <AnimatePresence>
        {showParticles && !isArtifactViewActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 5 }}
            className="absolute inset-0 pointer-events-none overflow-hidden z-10"
          >
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-hidden">
              <LightRays />
            </div>
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-hidden">
              <Particles particleCount={400} particleBaseSize={10} />
            </div>

            <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-hidden">
              <div className="w-full h-full bg-gradient-to-t from-background to-50% to-transparent z-20" />
            </div>
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-hidden">
              <div className="w-full h-full bg-gradient-to-l from-background to-20% to-transparent z-20" />
            </div>
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none overflow-hidden">
              <div className="w-full h-full bg-gradient-to-r from-background to-20% to-transparent z-20" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }, [showParticles, isArtifactViewActive]);

  const handleFocus = useCallback(() => {
    // Only set state when the particles are actually showing. This runs from
    // the [input] effect on every keystroke, and a keystroke commits at sync
    // priority, so React flushes that effect synchronously. A redundant
    // setShowParticles(false) there is not reliably bailed out eagerly: it
    // leaves a Default-lane update pending after every commit. React 19
    // counts each such commit as a nested update and never resets the
    // counter while typing, so ~50 fast keystrokes threw "Maximum update
    // depth exceeded" from whichever setState came next (often the composer's).
    if (showParticlesRef.current) setShowParticles(false);
    debounce(() => setShowParticles(true), 60000);
  }, []);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isScrollAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    setIsAtBottom(isScrollAtBottom);
    if (isScrollAtBottom) stickToBottomRef.current = true;
    handleFocus();
  }, [handleFocus]);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setOverlayHeight(el.offsetHeight));
    ro.observe(el);
    setOverlayHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [messages.length > 0]);

  // Follow the answer while it grows, until the reader scrolls away.
  const stickToBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  const isStreamingNow = isLoading || isPendingToolCall;
  useEffect(() => {
    if (!isStreamingNow) return;
    // A new turn always starts pinned to the bottom.
    stickToBottomRef.current = true;
    const container = containerRef.current;
    if (!container) return;
    const release = () => {
      stickToBottomRef.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) release();
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) release();
    };
    let lastTouchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      // Finger moving down drags content down, i.e. scrolls up.
      if (y != null && lastTouchY != null && y > lastTouchY) release();
      lastTouchY = y ?? null;
    };
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    let raf = 0;
    const tick = () => {
      if (stickToBottomRef.current) {
        const gap =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        if (gap > 1) container.scrollTop = container.scrollHeight;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKey);
    };
  }, [isStreamingNow]);

  useEffect(() => {
    appStoreMutate({ currentThreadId: threadId });
    return () => {
      appStoreMutate({ currentThreadId: null });
    };
  }, [threadId]);

  useEffect(() => {
    if (pendingThreadMention && threadId) {
      appStoreMutate((prev) => ({
        threadMentions: {
          ...prev.threadMentions,
          [threadId]: [pendingThreadMention],
        },
        pendingThreadMention: undefined,
      }));
    }
  }, [pendingThreadMention, threadId, appStoreMutate]);

  const dispatchedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingChatPrompt || !threadId) return;
    if (status !== "ready") return;
    const promptToSend = pendingChatPrompt.trim();
    if (!promptToSend) {
      appStoreMutate({ pendingChatPrompt: undefined });
      return;
    }
    if (dispatchedPromptRef.current === `${threadId}:${promptToSend}`) return;
    dispatchedPromptRef.current = `${threadId}:${promptToSend}`;
    appStoreMutate({ pendingChatPrompt: undefined });
    void handleComposerSend({
      role: "user",
      parts: [{ type: "text", text: promptToSend }],
    });
  }, [pendingChatPrompt, threadId, status, appStoreMutate, handleComposerSend]);

  useEffect(() => {
    if (isInitialThreadEntry)
      containerRef.current?.scrollTo({
        top: containerRef.current?.scrollHeight,
        behavior: "instant",
      });
  }, [isInitialThreadEntry]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isShortcutEvent(e, Shortcuts.toggleSessionPanel)) {
        e.preventDefault();
        chatUxStore.getState().mutate((st) => ({ panelOpen: !st.panelOpen }));
        return;
      }
      const toPrevious = isShortcutEvent(e, Shortcuts.previousPrompt);
      if (toPrevious || isShortcutEvent(e, Shortcuts.nextPrompt)) {
        // jcode's prompt jump: scroll to the previous / next message you sent.
        const container = containerRef.current;
        if (!container) return;
        e.preventDefault();
        const top = container.getBoundingClientRect().top;
        const prompts = Array.from(
          container.querySelectorAll<HTMLElement>('[data-message-role="user"]'),
        ).map((el) => ({ el, y: el.getBoundingClientRect().top - top }));
        const target = toPrevious
          ? prompts.filter((p) => p.y < -4).at(-1)
          : prompts.find((p) => p.y > 4);
        target?.el.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const messages = latestRef.current.messages;
      if (messages.length === 0) return;
      const isLastMessageCopy = isShortcutEvent(e, Shortcuts.lastMessageCopy);
      const isDeleteThread = isShortcutEvent(e, Shortcuts.deleteThread);
      if (!isDeleteThread && !isLastMessageCopy) return;
      e.preventDefault();
      e.stopPropagation();
      if (isLastMessageCopy) {
        const lastMessage = messages.at(-1);
        const lastMessageText = lastMessage!.parts
          .filter((part): part is TextUIPart => part.type == "text")
          ?.at(-1)?.text;
        if (!lastMessageText) return;
        navigator.clipboard.writeText(lastMessageText);
        toast.success("Last message copied to clipboard");
      }
      if (isDeleteThread) {
        setIsDeleteThreadPopupOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (mounted) {
      handleFocus();
    }
  }, [input]);

  return (
    <>
      {particle}
      {/* The wide pane holds the artifact pane when it is open: the
          implementation plan, the task list, the walkthrough. Opening it is
          always a deliberate act -- clicking Review on a halted node, or a
          plan card in the chat -- except for the auto-open below, which
          fires at most once per turn and never reopens a pane the user
          closed. */}
      <div
        className={cn(
          "flex min-w-0 w-full h-full max-w-full overflow-hidden",
          isArtifactViewActive && "gap-2 p-1.5 bg-muted/20",
        )}
      >
        {isArtifactViewActive ? (
          <div
            className={cn(
              "flex-1 min-w-0 h-full relative z-40 rounded-xl border border-border shadow-xl overflow-hidden bg-background",
              // Enter and exit along one path, on the drawer curve the rest
              // of the app uses. The chat column's width transition below is
              // deliberately the same duration and curve, so the two read as
              // one movement rather than two things that happened at once.
              "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-[0.98] motion-safe:duration-[240ms] motion-safe:ease-[var(--ease-drawer)]",
            )}
          >
            <ArtifactPane
              artifacts={artifacts}
              chatFiles={chatFiles}
              threadId={threadId}
              addToolResult={addToolResult}
              // isLoading alone, not isPendingToolCall: isPendingToolCall is
              // true for the very call Proceed/Send exist to resolve, so
              // including it here would deadlock the pane's own buttons.
              busy={isLoading}
            />
          </div>
        ) : null}
        {/* Always a panel group, even with no agents open: wrapping the chat
            only when the first pane opens would remount it and drop whatever
            the user was typing. */}
        <ResizablePanelGroup
          direction="horizontal"
          className={cn(
            "min-w-0 transition-[width] duration-[240ms] ease-[var(--ease-drawer)] motion-reduce:transition-none",
            isArtifactViewActive ? "!w-[380px] shrink-0 flex-none" : "flex-1",
          )}
        >
          <ResizablePanel
            id="chat"
            order={0}
            minSize={30}
            defaultSize={chatPanelSize}
          >
            <div
              className={cn(
                emptyMessage ? "justify-center pb-24" : "justify-end",
                "flex flex-col min-w-0 relative h-full z-40 w-full",
                isArtifactViewActive &&
                  "rounded-xl border border-border shadow-xl overflow-hidden bg-background",
              )}
            >
              <MemberThreadBanner threadId={threadId} />
              <AnimatePresence>
                {voiceActive && !voiceMinimized && (
                  <VoiceRoom key="voice-room" threadId={threadId} />
                )}
              </AnimatePresence>
              {!emptyMessage && !isArtifactViewActive && (
                <ChatToolbar
                  summary={sessionSummary}
                  className="absolute top-2 right-3 z-30"
                />
              )}
              {isDragging && (
                <div className="absolute inset-0 z-40 bg-background/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
                  <div className="rounded-2xl px-6 py-5 bg-background/80 shadow-xl border border-border flex items-center gap-3">
                    <div className="rounded-full bg-primary/10 p-2 text-primary">
                      <FilePlus className="size-6" />
                    </div>
                    <span className="text-sm text-muted-foreground">
                      Drop files to upload
                    </span>
                  </div>
                </div>
              )}
              {emptyMessage ? (
                (emptyState ?? <ChatGreeting />)
              ) : (
                <>
                  <div
                    data-testid="chat-messages-container"
                    data-state={
                      isLoading || isPendingToolCall ? "streaming" : "ready"
                    }
                    className={
                      "flex flex-col gap-1 overflow-y-auto pt-12 z-10 [scrollbar-gutter:stable_both-edges]"
                    }
                    style={{ paddingBottom: overlayHeight + 56 + 12 }}
                    ref={containerRef}
                    onScroll={handleScroll}
                  >
                    {messages.map((message, index) => {
                      const isLastMessage = messages.length - 1 === index;
                      return (
                        <PreviewMessage
                          threadId={threadId}
                          prevMessage={messages[index - 1]}
                          key={message.id}
                          message={message}
                          status={status}
                          addToolResult={addToolResult}
                          isLoading={isLoading || isPendingToolCall}
                          isLastMessage={isLastMessage}
                          setMessages={setMessages}
                          sendMessage={sendMessage}
                          className={
                            isLastMessage &&
                            message.role != "user" &&
                            !space &&
                            (message.parts?.length ?? 0) > 1
                              ? ""
                              : ""
                          }
                        />
                      );
                    })}
                    {space && (
                      <>
                        <div className="w-full mx-auto max-w-3xl px-6 relative">
                          <div
                            className={cn(
                              "flex items-center gap-1.5 py-1",
                              space == "space" ? "opacity-0" : "",
                            )}
                          >
                            {space === "think" ? (
                              <TextShimmer
                                as="span"
                                data-testid="streaming-thinking-indicator"
                                className="font-normal text-xs [--base-color:#a1a1aa] [--base-gradient-color:#52525b] dark:[--base-color:#a1a1aa] dark:[--base-gradient-color:#f4f4f5]"
                              >
                                Thinking
                              </TextShimmer>
                            ) : (
                              <Think />
                            )}
                          </div>
                        </div>
                      </>
                    )}

                    {error && <ErrorMessage error={error} />}
                    <div className="min-w-0 min-h-2" />
                  </div>
                </>
              )}

              <div
                ref={overlayRef}
                className={clsx(
                  messages.length && "absolute bottom-14",
                  "w-full z-10",
                )}
              >
                <div className="max-w-3xl mx-auto relative flex justify-center items-center -top-2">
                  <ScrollToBottomButton
                    show={!isAtBottom && messages.length > 0}
                    onClick={scrollToBottom}
                  />
                </div>

                {isLoginPanelOpen && (
                  <div className="max-w-3xl mx-auto px-4 mb-2">
                    <LoginPanel onClose={() => setIsLoginPanelOpen(false)} />
                  </div>
                )}

                <AnimatePresence>
                  {voiceActive && voiceMinimized && (
                    <div key="voice-dock" className="max-w-3xl mx-auto px-6 mb-2">
                      <VoiceDock />
                    </div>
                  )}
                </AnimatePresence>
                {!emptyMessage && (
                  <div className="max-w-3xl mx-auto px-6">
                    <WorkStatusDock
                      message={messages.at(-1)}
                      running={isLoading}
                    />
                  </div>
                )}
                <div className="max-w-3xl mx-auto px-6 mb-1.5">
                  <SwarmStrip
                    threadId={threadId}
                    isRunning={isLoading}
                    spawned={sessionSummary.spawned}
                  />
                </div>
                <PromptInput
                  input={input}
                  threadId={threadId}
                  sendMessage={handleComposerSend}
                  setInput={setInput}
                  isLoading={isLoading || isPendingToolCall}
                  onStop={handleStop}
                  onFocus={isFirstTime ? undefined : handleFocus}
                  pendingFollowUp={pendingFollowUp}
                  onQueueFollowUp={queuePendingFollowUp}
                  onCancelFollowUp={cancelPendingFollowUp}
                  onInterruptAndSend={interruptAndSend}
                  workspaceLabel={workspaceLabel}
                />
              </div>
              <DeleteThreadPopup
                threadId={threadId}
                onClose={() => setIsDeleteThreadPopupOpen(false)}
                open={isDeleteThreadPopupOpen}
              />
            </div>
          </ResizablePanel>
          {showAgentPanes &&
            agentPanes.map(({ member, coordinator }, i) => (
              <Fragment key={member.sessionId}>
                <ResizableHandle withHandle />
                <ResizablePanel
                  id={`agent-${member.sessionId}`}
                  order={i + 1}
                  minSize={18}
                  defaultSize={(100 - chatPanelSize) / agentPanes.length}
                  className="relative z-40"
                >
                  <AgentPane
                    threadId={threadId}
                    member={member}
                    coordinator={coordinator}
                  />
                </ResizablePanel>
              </Fragment>
            ))}
        </ResizablePanelGroup>
        {/* The session panel shares the row with the chat column, not the
            artifact pane: with a plan open the chat is already squeezed to
            380px, and a third column would leave nothing readable. */}
        {sessionPanelOpen && !emptyMessage && !isArtifactViewActive && (
          <SessionPanel
            threadId={threadId}
            summary={sessionSummary}
            isRunning={isLoading}
          />
        )}
      </div>
    </>
  );
}

function DeleteThreadPopup({
  threadId,
  onClose,
  open,
}: { threadId: string; onClose: () => void; open: boolean }) {
  const t = useTranslations();
  const [isDeleting, setIsDeleting] = useState(false);
  const router = useRouter();
  const handleDelete = useCallback(() => {
    setIsDeleting(true);
    safe(() => deleteThread(threadId))
      .watch(() => setIsDeleting(false))
      .ifOk(() => {
        toast.success(t("Chat.Thread.threadDeleted"));
        router.push("/");
      })
      .ifFail(() => toast.error(t("Chat.Thread.failedToDeleteThread")))
      .watch(() => onClose());
  }, [threadId, router]);
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Chat.Thread.deleteChat")}</DialogTitle>
          <DialogDescription>
            {t("Chat.Thread.areYouSureYouWantToDeleteThisChatThread")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("Common.cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete} autoFocus>
            {t("Common.delete")}
            {isDeleting && <Loader className="size-3.5 ml-2 animate-spin" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ScrollToBottomButtonProps {
  show: boolean;
  onClick: () => void;
  className?: string;
}

function ScrollToBottomButton({
  show,
  onClick,
  className,
}: ScrollToBottomButtonProps) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.2, ease: "easeInOut" }}
          className={className}
        >
          <Button
            onClick={onClick}
            className="shadow-lg backdrop-blur-sm border transition-colors"
            size="icon"
            variant="ghost"
          >
            <ArrowDown />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
