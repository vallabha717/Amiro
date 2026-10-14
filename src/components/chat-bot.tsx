"use client";

import { appStore } from "@/app/store";
import { useChat } from "@ai-sdk/react";
import clsx from "clsx";
import { cn, createDebounce, generateUUID, truncateString } from "lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArtifactPane } from "./artifacts/artifact-pane";
import {
  type ArtifactTab,
  buildPlanDecision,
  useArtifacts,
} from "./artifacts/use-artifacts";
import { usePlanDecision } from "./artifacts/use-plan-decision";
import { ChatGreeting } from "./chat-greeting";
import { LoginPanel } from "./chat/login-panel";
import { ErrorMessage, PreviewMessage } from "./message";
import PromptInput from "./prompt-input";

import {
  DefaultChatTransport,
  TextUIPart,
  UIMessage,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useShallow } from "zustand/shallow";

import { ChatGraphCanvas } from "@/components/chat-graph/chat-graph-canvas";
import { useGenerateThreadTitle } from "@/hooks/queries/use-generate-thread-title";
import { useFileDragOverlay } from "@/hooks/use-file-drag-overlay";
import { useToRef } from "@/hooks/use-latest";
import { useMounted } from "@/hooks/use-mounted";
import { useThreadFileUploader } from "@/hooks/use-thread-file-uploader";
import { deleteThread } from "@/lib/backend/chat-api";
import { backendFetch } from "@/lib/backend/client";
import { backendUrl } from "@/lib/backend/config";
import {
  ChatApiSchemaRequestBody,
  ChatAttachment,
  ChatModel,
} from "app-types/chat";
import { WORKFLOW_VIEW_LAUNCH_DATE } from "app-types/chat-graph";
import { AnimatePresence, motion } from "framer-motion";
import { DefaultToolName } from "lib/ai/tools";
import { getStorageManager } from "lib/browser-stroage";
import { Shortcuts, isShortcutEvent } from "lib/keyboard-shortcuts";
import { ArrowDown, FilePlus, Loader } from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
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

type Props = {
  threadId: string;
  initialMessages: Array<UIMessage>;
  selectedChatModel?: string;
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

export default function ChatBot({ threadId, initialMessages }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
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
    threadImageToolModel,
    workflowView,
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
      state.threadImageToolModel,
      state.workflowView,
      state.artifactView,
    ]),
  );

  const generateTitle = useGenerateThreadTitle({
    threadId,
  });

  const [showParticles, setShowParticles] = useState(isFirstTime);

  const onFinish = useCallback(() => {
    const messages = latestRef.current.messages;
    const prevThread = latestRef.current.threadList.find(
      (v) => v.id === threadId,
    );
    const isNewThread =
      !prevThread?.title &&
      messages.filter((v) => v.role === "user" || v.role === "assistant")
        .length < 3;
    if (isNewThread) {
      const part = messages
        .slice(0, 2)
        .flatMap((m) =>
          m.parts
            .filter((v) => v.type === "text")
            .map(
              (p) =>
                `${m.role}: ${truncateString((p as TextUIPart).text, 500)}`,
            ),
        );
      if (part.length > 0) {
        generateTitle(part.join("\n\n"));
      }
    } else if (latestRef.current.threadList[0]?.id !== threadId) {
      mutate("/api/thread");
    }
  }, []);

  const [input, setInput] = useState("");

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
        const threadUrl = `/?thread=${threadId}`;
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
        };
        return { body: requestBody };
      },
    }),
    messages: initialMessages,
    generateId: generateUUID,
    experimental_throttle: 100,
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

  // The workflow canvas has nothing to derive from until the thread has at
  // least one message, so an untouched "new chat" shows the plain greeting.
  // Keying off messages.length (rather than the persisted thread) makes it
  // appear on the same render as the optimistically-appended user message.
  const isWorkflowViewActive = useMemo(() => {
    if (!workflowView.isOpen) return false;
    if (messages.length === 0) return false;
    const thread = threadList.find((t) => t.id === threadId);
    if (!thread) return true;
    return (
      new Date(thread.createdAt).getTime() >=
      WORKFLOW_VIEW_LAUNCH_DATE.getTime()
    );
  }, [workflowView.isOpen, messages.length, threadList, threadId]);

  // The plan, task list and walkthrough, read back out of the transcript.
  const artifacts = useArtifacts(messages, isLoading);

  const hasArtifact = Boolean(
    artifacts.plan || artifacts.todos || artifacts.walkthrough,
  );
  const isArtifactViewActive = artifactView.isOpen && hasArtifact;

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
    if (workflowView.isOpen) return;
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
    workflowView.isOpen,
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
        const textParts = (first as { parts: Array<{ type?: string; text?: string }> })
          .parts.filter((part) => part?.type === "text");
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

  // Answering a plan from the graph goes through the same decision helper the
  // artifact header and the chat card use, so "Proceed" means one thing --
  // including the permission-mode switch, which is the half a second copy
  // would forget.
  const { grantedMode, decide } = usePlanDecision(addToolResult);

  const graphActions = useMemo(
    () => ({
      openArtifact: (tab: ArtifactTab) =>
        appStoreMutate((state) => ({
          artifactView: { ...state.artifactView, isOpen: true, tab },
        })),
      proceedWithPlan: (toolCallId: string) => {
        const plan = artifacts.plan;
        if (!plan || plan.toolCallId !== toolCallId) return;
        // No comments from this surface: the graph node has no gutter to
        // write them in. Someone who wants to annotate uses Review, which
        // opens the pane where the document is.
        decide(plan, "proceed", [], grantedMode);
      },
      // isLoading alone, not isPendingToolCall. isPendingToolCall is true
      // exactly when the last part of the last message is an unresolved
      // tool call -- which a suspended propose_plan always is, by
      // definition, until it is answered. Including it here disabled the
      // one button whose entire job is to answer it: the call could never
      // resolve because the button that resolves it was disabled by the
      // call being unresolved.
      busy: isLoading,
    }),
    [appStoreMutate, artifacts.plan, decide, grantedMode, isLoading],
  );

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
        {showParticles && !isWorkflowViewActive && !isArtifactViewActive && (
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
  }, [showParticles, isWorkflowViewActive, isArtifactViewActive]);

  const handleFocus = useCallback(() => {
    setShowParticles(false);
    debounce(() => setShowParticles(true), 60000);
  }, []);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isScrollAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    setIsAtBottom(isScrollAtBottom);
    handleFocus();
  }, [handleFocus]);

  const scrollToBottom = useCallback(() => {
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

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

  useEffect(() => {
    if (isInitialThreadEntry)
      containerRef.current?.scrollTo({
        top: containerRef.current?.scrollHeight,
        behavior: "instant",
      });
  }, [isInitialThreadEntry]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
      {/* The wide pane is shared, and the artifact pane wins it when open.
          That is the right way round because opening it is always a
          deliberate act -- clicking Review on a halted node, or a plan card
          in the chat. The auto-open below is the one case that is not
          deliberate, and it declines to fire while the graph is up rather
          than taking the pane out from under it. Closing the pane hands the
          graph straight back. */}
      <div
        className={cn(
          "flex min-w-0 w-full h-full max-w-full overflow-hidden",
          (isWorkflowViewActive || isArtifactViewActive) &&
            "gap-2 p-1.5 bg-muted/20",
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
              threadId={threadId}
              addToolResult={addToolResult}
              // Same fix as graphActions.busy just above: isPendingToolCall
              // is true for the very call Proceed/Send exist to resolve, so
              // including it here deadlocks the pane's own buttons.
              busy={isLoading}
              canReturnToGraph={isWorkflowViewActive}
            />
          </div>
        ) : isWorkflowViewActive ? (
          <div className="flex-1 min-w-0 h-full relative z-40 rounded-xl border border-border shadow-xl overflow-hidden bg-background">
            <ChatGraphCanvas messages={messages} actions={graphActions} />
          </div>
        ) : null}
        <div
          className={cn(
            emptyMessage ? "justify-center pb-24" : "justify-end",
            "flex flex-col min-w-0 relative h-full z-40",
            "transition-[width] duration-[240ms] ease-[var(--ease-drawer)] motion-reduce:transition-none",
            (isWorkflowViewActive || isArtifactViewActive) &&
              "w-[380px] shrink-0 rounded-xl border border-border shadow-xl overflow-hidden bg-background",
            !isWorkflowViewActive && !isArtifactViewActive && "w-full",
          )}
        >
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
            <ChatGreeting />
          ) : (
            <>
              <div
                data-testid="chat-messages-container"
                data-state={isLoading || isPendingToolCall ? "streaming" : "ready"}
                className={
                  "flex flex-col gap-2 overflow-y-auto pt-6 pb-40 z-10 [scrollbar-gutter:stable_both-edges]"
                }
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
                          ? "min-h-[calc(5dvh-40px)]"
                          : ""
                      }
                    />
                  );
                })}
                {space && (
                  <>
                    <div className="w-full mx-auto max-w-3xl px-6 relative">
                      <div className={space == "space" ? "opacity-0" : ""}>
                        <Think />
                      </div>
                    </div>
                    <div className="min-h-[calc(5dvh-56px)]" />
                  </>
                )}

                {error && <ErrorMessage error={error} />}
                <div className="min-w-0 min-h-16" />
              </div>
            </>
          )}

          <div
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

            <PromptInput
              input={input}
              threadId={threadId}
              sendMessage={handleComposerSend}
              setInput={setInput}
              isLoading={isLoading || isPendingToolCall}
              onStop={handleStop}
              onFocus={isFirstTime ? undefined : handleFocus}
            />
          </div>
          <DeleteThreadPopup
            threadId={threadId}
            onClose={() => setIsDeleteThreadPopupOpen(false)}
            open={isDeleteThreadPopupOpen}
          />
        </div>
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
