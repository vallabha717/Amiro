"use client";

import { useCopy } from "@/hooks/use-copy";
import { useSmoothText } from "@/hooks/use-smooth-text";
import { rewriteStorageUrl } from "@/lib/backend/config";
import type { UseChatHelpers } from "@ai-sdk/react";
import {
  FileUIPart,
  ToolUIPart,
  UIMessage,
  getToolName,
  isToolUIPart,
} from "ai";
import { stepKindOf } from "lib/ai/tools/step-kind";
import { parseToolTiming } from "lib/ai/tools/timing";
import { cn, safeJSONParse, truncateString } from "lib/utils";
import {
  Check,
  ChevronDownIcon,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  EllipsisIcon,
  FileIcon,
  History,
  Loader,
  Pencil,
  RefreshCw,
  Square,
  Trash2,
  TriangleAlert,
  Volume2,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import JsonView from "ui/json-view";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { RewindConfirmDialog } from "./checkpoint/rewind-confirm-dialog";
import { Markdown } from "./markdown";
import { MessageEditor } from "./message-editor";
import { parseInlineVisuals, VisualSurface } from "./visual/visual-surface";

import {
  deleteMessage as deleteMessageAction,
  deleteMessagesAfter as deleteMessagesByChatIdAfterTimestampAction,
} from "@/lib/backend/chat-api";
import { AnimatePresence, motion } from "framer-motion";
import { SelectModel } from "./select-model";

import { ChatMetadata, ChatModel, ManualToolConfirmTag } from "app-types/chat";
import { toast } from "sonner";
import { safe } from "ts-safe";

import { useMessageReadAloudStore } from "@/lib/ai/speech/read-aloud-store";
import { getCachedVoiceSettings } from "@/lib/backend/voice-api";
import { extractMCPToolId } from "lib/ai/mcp/mcp-tool-id";
import { useTranslations } from "next-intl";
import { Separator } from "ui/separator";

import { DefaultToolName, ImageToolName } from "lib/ai/tools";
import equal from "lib/equal";
import {
  Shortcut,
  getShortcutKeyList,
  isShortcutEvent,
} from "lib/keyboard-shortcuts";
import { TextShimmer } from "ui/text-shimmer";

import { notify } from "lib/notify";
import dynamic from "next/dynamic";
import { ModelProviderIcon } from "ui/model-provider-icon";
import { ToolRenderBoundary } from "./tool-invocation/tool-render-boundary";
import {
  getToolPresenter,
  presenterPropsFromToolPart,
} from "./tool-presenters";

type MessagePart = UIMessage["parts"][number];
type TextMessagePart = Extract<MessagePart, { type: "text" }>;
type AssistMessagePart = Extract<MessagePart, { type: "text" }>;

interface UserMessagePartProps {
  part: TextMessagePart;
  isLast: boolean;
  message: UIMessage;
  setMessages?: UseChatHelpers<UIMessage>["setMessages"];
  sendMessage?: UseChatHelpers<UIMessage>["sendMessage"];
  status?: UseChatHelpers<UIMessage>["status"];
  isError?: boolean;
  readonly?: boolean;
}

interface AssistMessagePartProps {
  part: AssistMessagePart;
  isLast?: boolean;
  isLoading?: boolean;
  message: UIMessage;
  prevMessage?: UIMessage;
  showActions: boolean;
  threadId?: string;
  setMessages?: UseChatHelpers<UIMessage>["setMessages"];
  sendMessage?: UseChatHelpers<UIMessage>["sendMessage"];
  isError?: boolean;
  readonly?: boolean;
}

interface ToolMessagePartProps {
  part: ToolUIPart;
  messageId: string;
  showActions: boolean;
  isLast?: boolean;
  isManualToolInvocation?: boolean;
  addToolResult?: UseChatHelpers<UIMessage>["addToolResult"];
  isError?: boolean;
  setMessages?: UseChatHelpers<UIMessage>["setMessages"];
  readonly?: boolean;
}

const MAX_TEXT_LENGTH = 600;
export const UserMessagePart = memo(
  function UserMessagePart({
    part,
    isLast,
    status,
    message,
    setMessages,
    sendMessage,
    readonly,
    isError,
  }: UserMessagePartProps) {
    const { copied, copy } = useCopy();
    const t = useTranslations();
    const [mode, setMode] = useState<"view" | "edit">("view");
    const [isDeleting, setIsDeleting] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const scrolledRef = useRef(false);

    const isLongText = part.text.length > MAX_TEXT_LENGTH;
    const displayText =
      expanded || !isLongText
        ? part.text
        : truncateString(part.text, MAX_TEXT_LENGTH);

    const deleteMessage = useCallback(async () => {
      if (!setMessages) return;
      const ok = await notify.confirm({
        title: "Delete Message",
        description: "Are you sure you want to delete this message?",
      });
      if (!ok) return;
      safe(() => setIsDeleting(true))
        .ifOk(() => deleteMessageAction(message.id))
        .ifOk(() =>
          setMessages((messages) => {
            const index = messages.findIndex((m) => m.id === message.id);
            if (index !== -1) {
              return messages.filter((_, i) => i !== index);
            }
            return messages;
          }),
        )
        .ifFail((error) => toast.error(error.message))
        .watch(() => setIsDeleting(false))
        .unwrap();
    }, [message.id]);

    useEffect(() => {
      if (status === "submitted" && isLast && !scrolledRef.current) {
        scrolledRef.current = true;
        ref.current?.scrollIntoView({ behavior: "smooth" });
      }
    }, [status]);

    if (mode === "edit" && setMessages && sendMessage) {
      return (
        <div className="flex flex-row gap-2 items-start w-full">
          <MessageEditor
            message={message}
            setMode={setMode}
            setMessages={setMessages}
            sendMessage={sendMessage}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-2 items-end my-2">
        <div
          data-testid="message-content"
          data-role="user"
          className={cn(
            "flex flex-col gap-4 max-w-full ring ring-input relative overflow-hidden",
            {
              "bg-accent text-accent-foreground px-4 py-3 rounded-2xl": isLast,
              "opacity-50": isError,
            },
            isError && "border-destructive border",
          )}
        >
          {isLongText && !expanded && (
            <div className="absolute pointer-events-none bg-gradient-to-t from-accent to-transparent w-full h-40 bottom-0 left-0" />
          )}
          <p className={cn("whitespace-pre-wrap text-sm break-words")}>
            {displayText}
          </p>
          {isLongText && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
              className="h-auto p-1 text-xs z-10 text-muted-foreground hover:text-foreground self-start"
            >
              <span className="flex items-center gap-1">
                {t(expanded ? "Common.showLess" : "Common.showMore")}
                {expanded ? (
                  <ChevronUp className="size-3" />
                ) : (
                  <ChevronDownIcon className="size-3" />
                )}
              </span>
            </Button>
          )}
        </div>
        {isLast && (
          <div className="flex w-full justify-end md:opacity-0 group-hover/message:opacity-100 transition-opacity duration-300">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="message-edit-button"
                  variant="ghost"
                  size="icon"
                  className={cn("size-3! p-4!")}
                  onClick={() => copy(part.text)}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy</TooltipContent>
            </Tooltip>
            {!readonly && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid="message-edit-button"
                      variant="ghost"
                      size="icon"
                      className="size-3! p-4!"
                      onClick={() => setMode("edit")}
                    >
                      <Pencil />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Edit</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      disabled={isDeleting}
                      onClick={deleteMessage}
                      variant="ghost"
                      size="icon"
                      className="size-3! p-4! hover:text-destructive"
                    >
                      {isDeleting ? (
                        <Loader className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="text-destructive" side="bottom">
                    Delete Message
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
        )}
        <div ref={ref} className="min-w-0" />
      </div>
    );
  },
  (prev, next) => {
    if (prev.part.text != next.part.text) return false;
    if (prev.isError != next.isError) return false;
    if (prev.isLast != next.isLast) return false;
    if (prev.status != next.status) return false;
    if (prev.message.id != next.message.id) return false;
    if (!equal(prev.part, next.part)) return false;
    return true;
  },
);
UserMessagePart.displayName = "UserMessagePart";

export const AssistMessagePart = memo(function AssistMessagePart({
  part,
  showActions,
  message,
  prevMessage,
  isError,
  threadId,
  setMessages,
  readonly,
  sendMessage,
  isLast,
  isLoading: isMessageLoading,
}: AssistMessagePartProps) {
  const { copied, copy } = useCopy();
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [rewindOpen, setRewindOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const metadata = message.metadata as ChatMetadata | undefined;
  const t = useTranslations("Checkpoint");

  // Only the actively streaming last part is paced; finished messages pass
  // streaming=false from the start so the hook never schedules a frame.
  const isStreamingText = Boolean(isLast && isMessageLoading);
  const displayText = useSmoothText(part.text, isStreamingText);
  // Keep the caret until the reveal has caught up, not just until the stream ends.
  const showCaret = isStreamingText || displayText.length < part.text.length;

  const isReadAloudStoreActive = useMessageReadAloudStore(
    (s) => s.messageId === message.id,
  );
  const readAloudStatus = useMessageReadAloudStore((s) => s.status);
  const isThisReading = isReadAloudStoreActive && readAloudStatus !== "idle";
  const isThisLoading = isReadAloudStoreActive && readAloudStatus === "loading";
  const isThisPlaying = isReadAloudStoreActive && readAloudStatus === "playing";
  const isReadAloudEnabled = getCachedVoiceSettings().readAloudEnabled ?? true;

  // "Rewind to here" only makes sense on a message that actually wrote a
  // file -- docs/coding-agent-parity/phases/phase-01-checkpoints-and-rewind.md's
  // deliverable 3: "the action appears only on messages with file writes".
  // stepKindOf's "edit" category (write_file/edit_file/multi_edit) is the
  // same categorization the work-log rows already use, so this reads the
  // message the same way a human scanning the transcript does, rather than
  // re-deriving a second notion of "which tools count as writes".
  const hasFileWrites = useMemo(
    () =>
      message.parts.some(
        (p) => isToolUIPart(p) && stepKindOf(getToolName(p)) === "edit",
      ),
    [message.parts],
  );

  const deleteMessage = useCallback(async () => {
    if (!setMessages) return;
    const ok = await notify.confirm({
      title: "Delete Message",
      description: "Are you sure you want to delete this message?",
    });
    if (!ok) return;
    safe(() => setIsDeleting(true))
      .ifOk(() => deleteMessageAction(message.id))
      .ifOk(() =>
        setMessages((messages) => {
          const index = messages.findIndex((m) => m.id === message.id);
          if (index !== -1) {
            return messages.filter((_, i) => i !== index);
          }
          return messages;
        }),
      )
      .ifFail((error) => toast.error(error.message))
      .watch(() => setIsDeleting(false))
      .unwrap();
  }, [message.id]);

  const handleModelChange = (model: ChatModel) => {
    if (!setMessages || !sendMessage || !prevMessage) return;
    safe(() => setIsLoading(true))
      .ifOk(() =>
        threadId
          ? deleteMessagesByChatIdAfterTimestampAction(message.id)
          : Promise.resolve(),
      )
      .ifOk(() =>
        setMessages((messages) => {
          const index = messages.findIndex((m) => m.id === prevMessage.id);
          if (index !== -1) {
            return [...messages.slice(0, index)];
          }
          return messages;
        }),
      )
      .ifOk(() =>
        sendMessage(prevMessage, {
          body: {
            model,
          },
        }),
      )
      .ifFail((error) => toast.error(error.message))
      .watch(() => setIsLoading(false))
      .unwrap();
  };

  const inlineVisualSegments = useMemo(
    () =>
      // Strip inline SECRET_PROMPT / <secret_prompt> and OAUTH_CONNECT blocks from prose
      // so only the interactive cards appear below the message.
      parseInlineVisuals(
        displayText
          .replace(/<secret_prompt\b[^>]*>[\s\S]*?<\/secret_prompt>/gi, "")
          .replace(/<secret_prompt\b[^>]*\/>/gi, "")
          .replace(/^\s*SECRET_PROMPT\s*:?\s*\{[^\n]*\}\s*$/gim, "")
          .replace(/^\s*OAUTH_CONNECT\s*:?\s*\{[^\n]*\}\s*$/gim, ""),
      ),
    [displayText],
  );
  const cleanedDisplayText = useMemo(
    () =>
      displayText
        .replace(/<secret_prompt\b[^>]*>[\s\S]*?<\/secret_prompt>/gi, "")
        .replace(/<secret_prompt\b[^>]*\/>/gi, "")
        .replace(/^\s*SECRET_PROMPT\s*:?\s*\{[^\n]*\}\s*$/gim, "")
        .replace(/^\s*OAUTH_CONNECT\s*:?\s*\{[^\n]*\}\s*$/gim, ""),
    [displayText],
  );

  return (
    <div
      className={cn(
        isLoading && "animate-pulse",
        "flex flex-col gap-2 group/message",
      )}
    >
      <div
        data-testid="message-content"
        data-role="assistant"
        className={cn(
          "flex flex-col gap-2 px-2 text-justify [text-align-last:left]",
          {
            "opacity-50 border border-destructive bg-card rounded-lg": isError,
          },
        )}
      >
        {inlineVisualSegments ? (
          inlineVisualSegments.map((seg, idx) =>
            seg.type === "visual" ? (
              <VisualSurface
                key={seg.id}
                surfaceId={seg.id}
                html={seg.html}
                height={seg.height}
                title={seg.title}
                onSendPrompt={
                  sendMessage
                    ? (prompt) =>
                        sendMessage({
                          role: "user",
                          parts: [{ type: "text", text: prompt }],
                        })
                    : undefined
                }
              />
            ) : seg.content.trim() ? (
              <Markdown
                key={`${message.id}-seg-${idx}`}
                isStreaming={
                  isStreamingText && idx === inlineVisualSegments.length - 1
                }
              >
                {seg.content}
              </Markdown>
            ) : null,
          )
        ) : (
          <Markdown isStreaming={isStreamingText}>{cleanedDisplayText}</Markdown>
        )}
        {showCaret && (
          // Sibling after the markdown (not injected into it) so partial
          // markdown never breaks; it sits inline after the last block.
          <span
            aria-hidden
            className="-mt-1 ml-0.5 inline-block h-[1em] w-[0.5em] self-start rounded-[1px] bg-foreground/60 align-text-bottom motion-safe:animate-pulse"
          />
        )}
      </div>
      {showActions && (
        <div className="flex w-full">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="message-edit-button"
                variant="ghost"
                size="icon"
                className="size-3! p-4!"
                onClick={() => copy(part.text)}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy</TooltipContent>
          </Tooltip>
          {isReadAloudEnabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="message-read-aloud-button"
                  variant="ghost"
                  size="icon"
                  className="size-3! p-4!"
                  onClick={() =>
                    useMessageReadAloudStore
                      .getState()
                      .toggle({ messageId: message.id, text: part.text })
                  }
                >
                  {isThisLoading ? (
                    <Loader className="animate-spin" />
                  ) : isThisPlaying ? (
                    <Square className="size-3 fill-current" />
                  ) : (
                    <Volume2 />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isThisReading ? "Stop reading" : "Read aloud"}
              </TooltipContent>
            </Tooltip>
          )}
          {!readonly && hasFileWrites && threadId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="rewind-to-here-button"
                  variant="ghost"
                  size="icon"
                  className="size-3! p-4!"
                  onClick={() => setRewindOpen(true)}
                >
                  <History />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("rewindAction")}</TooltipContent>
            </Tooltip>
          )}
          {!readonly && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <SelectModel onSelect={handleModelChange}>
                      <Button
                        data-testid="message-change-model-button"
                        variant="ghost"
                        size="icon"
                        className="size-3! p-4! data-[state=open]:bg-secondary!"
                        aria-label="Change Model"
                      >
                        {<RefreshCw />}
                      </Button>
                    </SelectModel>
                  </div>
                </TooltipTrigger>
                <TooltipContent>Change Model</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={isDeleting}
                    onClick={deleteMessage}
                    className="size-3! p-4! hover:text-destructive"
                  >
                    {isDeleting ? (
                      <Loader className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-destructive">
                  Delete Message
                </TooltipContent>
              </Tooltip>
            </>
          )}

          {metadata && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-3! p-4! opacity-0 group-hover/message:opacity-100 transition-opacity duration-300"
                >
                  <EllipsisIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="p-4 w-72 bg-card border shadow-lg">
                <div className="space-y-4">
                  {metadata.chatModel && (
                    <>
                      <div className="space-y-2">
                        <h4 className="text-sm font-semibold text-foreground">
                          Model
                        </h4>
                        <div className="flex gap-3 items-center">
                          <ModelProviderIcon
                            provider={metadata.chatModel.provider}
                            className="size-5 flex-shrink-0"
                          />
                          <div className="space-y-0.5 flex-1">
                            <div className="text-sm font-medium text-foreground">
                              {metadata.chatModel.provider}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {metadata.chatModel.model}
                              {metadata.toolCount !== undefined &&
                                metadata.toolCount > 0 && (
                                  <span className="ml-2">
                                    • {metadata.toolCount} tools
                                  </span>
                                )}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="border-t border-border/50" />
                    </>
                  )}

                  {metadata.usage && (
                    <>
                      <div className="flex flex-col gap-2">
                        <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                          Token Usage
                          <span className="text-xs text-muted-foreground font-normal">
                            {
                              message.parts.filter(
                                (v) => v.type != "step-start",
                              ).length
                            }{" "}
                            Steps
                          </span>
                        </h4>
                        <p className="px-2 mb-2 text-xs text-muted-foreground">
                          High input token usage may occur when many tools are
                          available.
                        </p>
                        <div className="space-y-2">
                          {metadata.usage.inputTokens !== undefined && (
                            <div className="flex items-center justify-between py-1 px-2 rounded-md bg-muted/30">
                              <span className="text-xs text-muted-foreground">
                                Input
                              </span>
                              <span className="text-xs font-mono font-medium">
                                {metadata.usage.inputTokens.toLocaleString()}
                              </span>
                            </div>
                          )}
                          {metadata.usage.outputTokens !== undefined && (
                            <div className="flex items-center justify-between py-1 px-2 rounded-md bg-muted/30">
                              <span className="text-xs text-muted-foreground">
                                Output
                              </span>
                              <span className="text-xs font-mono font-medium">
                                {metadata.usage.outputTokens.toLocaleString()}
                              </span>
                            </div>
                          )}
                          {metadata.usage.totalTokens !== undefined && (
                            <div className="flex items-center justify-between py-1.5 px-2 rounded-md bg-primary/10 border border-primary/20">
                              <span className="text-xs font-medium text-primary">
                                Total
                              </span>
                              <span className="text-xs font-mono font-bold text-primary">
                                {metadata.usage.totalTokens.toLocaleString()}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
      {threadId && hasFileWrites && (
        <RewindConfirmDialog
          threadId={threadId}
          turnId={message.id}
          open={rewindOpen}
          onOpenChange={setRewindOpen}
          onRestored={() => setRewindOpen(false)}
        />
      )}
      <div ref={ref} className="min-w-0" />
    </div>
  );
});
AssistMessagePart.displayName = "AssistMessagePart";
const reasoningTransition = { duration: 0.22, ease: [0.23, 1, 0.32, 1] } as const;

export const ReasoningPart = memo(function ReasoningPart({
  reasoningText,
  isThinking,
}: {
  reasoningText: string;
  isThinking?: boolean;
  readonly?: boolean;
}) {
  // null = follow the agent (open while thinking, collapsed after). Once the
  // user clicks, their choice wins so we never re-collapse something they
  // deliberately opened.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const isExpanded = userExpanded ?? Boolean(isThinking);

  // Follow the stream to the end while it is thinking, until the user
  // scrolls up to read (then leave them alone; scrolling back to the bottom
  // re-attaches). Driven by a ResizeObserver on the content, because the
  // markdown grows after render and a one-shot scroll lands short.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    if (!isThinking || !isExpanded) return;
    pinnedRef.current = true;
    toBottom();
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) toBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [isThinking, isExpanded]);
  useEffect(() => {
    if (isThinking && pinnedRef.current) toBottom();
  }, [reasoningText, isThinking]);

  const toggle = () => setUserExpanded(!isExpanded);

  return (
    <div
      data-testid="reasoning-part"
      data-thinking={isThinking ? "true" : "false"}
      className="flex flex-col select-none my-1 animate-in fade-in duration-200"
    >
      <button
        type="button"
        data-testid="message-reasoning-toggle"
        aria-expanded={isExpanded}
        onClick={toggle}
        className="group/thinking flex items-center gap-1.5 text-xs cursor-pointer py-0.5 text-muted-foreground/75 hover:text-muted-foreground transition-colors w-fit max-w-full bg-transparent border-0 p-0 text-left"
      >
        <ChevronRight
          size={13}
          className={cn(
            "shrink-0 text-muted-foreground/60 transition-transform duration-200",
            isExpanded && "rotate-90",
          )}
        />
        {isThinking ? (
          <TextShimmer
            as="span"
            className="font-normal text-xs [--base-color:#a1a1aa] [--base-gradient-color:#52525b] dark:[--base-color:#a1a1aa] dark:[--base-gradient-color:#f4f4f5]"
          >
            Thinking
          </TextShimmer>
        ) : (
          <span className="font-normal text-xs text-muted-foreground/75">
            Thinking
          </span>
        )}
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            data-testid="message-reasoning"
            key="reasoning-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={reasoningTransition}
            className="overflow-hidden"
          >
            <div
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                pinnedRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
              data-testid="message-reasoning-scroll"
              className={cn(
                "max-h-36 overflow-y-auto pt-1.5 text-xs leading-relaxed font-normal",
                "text-zinc-400 dark:text-zinc-400",
                "[&_p]:text-zinc-400 dark:[&_p]:text-zinc-400",
                "[&_li]:text-zinc-400 dark:[&_li]:text-zinc-400",
                "[&_strong]:text-zinc-400 dark:[&_strong]:text-zinc-400 [&_strong]:font-normal",
                "[&_code]:bg-transparent [&_code]:text-zinc-400 dark:[&_code]:text-zinc-400 [&_code]:px-0",
              )}
            >
              <div ref={contentRef}>
                <Markdown isStreaming={Boolean(isThinking)}>
                  {reasoningText || "Thinking…"}
                </Markdown>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
ReasoningPart.displayName = "ReasoningPart";

const loading = memo(function Loading() {
  return (
    <div className="px-6 py-4">
      <div className="h-44 w-full rounded-md opacity-0" />
    </div>
  );
});

const PieChart = dynamic(
  () => import("./tool-invocation/pie-chart").then((mod) => mod.PieChart),
  {
    ssr: false,
    loading,
  },
);

const BarChart = dynamic(
  () => import("./tool-invocation/bar-chart").then((mod) => mod.BarChart),
  {
    ssr: false,
    loading,
  },
);

const LineChart = dynamic(
  () => import("./tool-invocation/line-chart").then((mod) => mod.LineChart),
  {
    ssr: false,
    loading,
  },
);

const InteractiveTable = dynamic(
  () =>
    import("./tool-invocation/interactive-table").then(
      (mod) => mod.InteractiveTable,
    ),
  {
    ssr: false,
    loading,
  },
);

const WebSearchToolInvocation = dynamic(
  () =>
    import("./tool-invocation/web-search").then(
      (mod) => mod.WebSearchToolInvocation,
    ),
  {
    ssr: false,
    loading,
  },
);

const ImageGeneratorToolInvocation = dynamic(
  () =>
    import("./tool-invocation/image-generator").then(
      (mod) => mod.ImageGeneratorToolInvocation,
    ),
  {
    ssr: false,
    loading,
  },
);

// Local shortcuts for tool invocation approval/rejection
const approveToolInvocationShortcut: Shortcut = {
  description: "approveToolInvocation",
  shortcut: {
    key: "Enter",
    command: true,
  },
};

const rejectToolInvocationShortcut: Shortcut = {
  description: "rejectToolInvocation",
  shortcut: {
    key: "Escape",
    command: true,
  },
};

export const ToolMessagePart = memo(
  ({
    part,
    isLast,
    showActions,
    addToolResult,
    isError,
    messageId,
    setMessages,
    isManualToolInvocation,
  }: ToolMessagePartProps) => {
    const t = useTranslations("");

    const { output, toolCallId, state, input, errorText } = part;

    const toolName = useMemo(() => getToolName(part), [part.type]);

    const isCompleted = useMemo(() => {
      return state.startsWith("output");
    }, [state]);

    // null = follow the call: web searches and fetches open while they run
    // (so the live card is visible) and fold away when done. A click wins
    // from then on.
    const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
    const { copied: copiedInput, copy: copyInput } = useCopy();
    const { copied: copiedOutput, copy: copyOutput } = useCopy();
    const [isDeleting, setIsDeleting] = useState(false);

    // Handle keyboard shortcuts for approve/reject actions
    useEffect(() => {
      // Only enable shortcuts when manual tool invocation buttons are shown
      if (!isManualToolInvocation) return;

      const handleKeyDown = (e: KeyboardEvent) => {
        const isApprove = isShortcutEvent(e, approveToolInvocationShortcut);
        const isReject = isShortcutEvent(e, rejectToolInvocationShortcut);

        if (!isApprove && !isReject) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (isApprove) {
          addToolResult?.({
            tool: toolName,
            toolCallId,
            output: ManualToolConfirmTag.create({ confirm: true }),
          });
        }

        if (isReject) {
          addToolResult?.({
            tool: toolName,
            toolCallId,
            output: ManualToolConfirmTag.create({ confirm: false }),
          });
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isManualToolInvocation, isLast]);

    const deleteMessage = useCallback(async () => {
      const ok = await notify.confirm({
        title: "Delete Message",
        description: "Are you sure you want to delete this message?",
      });
      if (!ok) return;
      safe(() => setIsDeleting(true))
        .ifOk(() => deleteMessageAction(messageId))
        .ifOk(() =>
          setMessages?.((messages) => {
            const index = messages.findIndex((m) => m.id === messageId);
            if (index !== -1) {
              return messages.filter((_, i) => i !== index);
            }
            return messages;
          }),
        )
        .ifFail((error) => toast.error(error.message))
        .watch(() => setIsDeleting(false))
        .unwrap();
    }, [messageId]);

    const onToolCallDirect = useCallback(
      (result: any) => {
        addToolResult?.({
          tool: toolName,
          toolCallId,
          output: result,
        });
      },
      [addToolResult, toolCallId],
    );

    const result = useMemo(() => {
      if (state == "output-error") {
        return errorText;
      }
      if (isCompleted) {
        return Array.isArray(output)
          ? {
              ...output,
              content: output.map((node) => {
                // mcp tools
                if (node?.type === "text" && typeof node?.text === "string") {
                  const parsed = safeJSONParse(node.text);
                  return {
                    ...node,
                    text: parsed.success ? parsed.value : node.text,
                  };
                }
                return node;
              }),
            }
          : output;
      }
      return null;
    }, [isCompleted, output, state, errorText]);

    const presenterProps = useMemo(
      () => presenterPropsFromToolPart(part),
      [part],
    );
    const isWebCall =
      toolName === "websearch" ||
      toolName === "webfetch" ||
      toolName === "webSearch" ||
      toolName === "webContent";
    const expanded =
      userExpanded ?? (isWebCall && presenterProps.status === "pending");
    const setExpanded = (next: boolean | ((v: boolean) => boolean)) =>
      setUserExpanded(typeof next === "function" ? next(expanded) : next);

    const presenter = useMemo(
      () => getToolPresenter(toolName),
      [toolName],
    );

    const CustomToolComponent = useMemo(() => {
      // Registry first: a tool with a presenter renders through a shared
      // component, so the chat and any other surface cannot drift. Tools
      // still living in tool-invocation/ fall through below.
      if (presenter?.Expanded) {
        const Expanded = presenter.Expanded;
        return (
          <Expanded
            key={`${toolCallId}-${toolName}`}
            {...presenterProps}
          />
        );
      }

      if (
        toolName === DefaultToolName.WebSearch ||
        toolName === DefaultToolName.WebContent
      ) {
        return <WebSearchToolInvocation part={part} />;
      }

      if (toolName === ImageToolName) {
        return <ImageGeneratorToolInvocation part={part} />;
      }

      if (state === "output-available") {
        switch (toolName) {
          case DefaultToolName.CreatePieChart:
            return (
              <PieChart key={`${toolCallId}-${toolName}`} {...(input as any)} />
            );
          case DefaultToolName.CreateBarChart:
            return (
              <BarChart key={`${toolCallId}-${toolName}`} {...(input as any)} />
            );
          case DefaultToolName.CreateLineChart:
            return (
              <LineChart
                key={`${toolCallId}-${toolName}`}
                {...(input as any)}
              />
            );
          case DefaultToolName.CreateTable:
            return (
              <InteractiveTable
                key={`${toolCallId}-${toolName}`}
                {...(input as any)}
              />
            );
        }
      }
      return null;
    }, [
      presenter,
      presenterProps,
      toolName,
      state,
      onToolCallDirect,
      result,
      input,
      output,
      errorText,
      part,
      toolCallId,
    ]);

    const { serverName: mcpServerName, toolName: mcpToolName } = useMemo(() => {
      return extractMCPToolId(toolName);
    }, [toolName]);

    const parsedTiming = useMemo(() => {
      return parseToolTiming(output);
    }, [output]);

    const isExecuting = useMemo(() => {
      return !isCompleted && Boolean(isLast);
    }, [isCompleted, isLast]);

    const toolDescription = useMemo(() => {
      const intent =
        typeof (input as any)?.intent === "string"
          ? (input as any).intent.trim()
          : typeof (input as any)?.description === "string"
            ? (input as any).description.trim()
            : "";
      const glance = presenter?.glance(presenterProps)?.trim() ?? "";
      if (intent && glance && intent !== glance) {
        return `${intent} · ${glance}`;
      }
      if (intent) return intent;
      if (glance) return glance;
      return mcpToolName ? `${mcpServerName} / ${mcpToolName}` : mcpServerName;
    }, [input, presenter, presenterProps, mcpServerName, mcpToolName]);

    return (
      <div className="group w-full">
        <div className="flex flex-col w-full my-0.5 fade-in duration-200 animate-in">
          <button
            type="button"
            data-testid="tool-call-toggle"
            data-tool-name={toolName}
            aria-expanded={expanded}
            className={cn(
              "group/pill flex items-center gap-2 py-1 px-1.5 rounded-md text-xs cursor-pointer transition-colors text-left w-full hover:bg-muted/40",
              isError || presenterProps.status === "error"
                ? "text-destructive"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
                expanded && "rotate-90",
              )}
            />
            {isExecuting || presenterProps.status === "pending" ? (
              <Loader className="size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : isError || presenterProps.status === "error" ? (
              <TriangleAlert className="size-3 shrink-0 text-destructive" />
            ) : null}
            <div className="min-w-0 flex items-center gap-1.5 truncate flex-1">
              {isExecuting || presenterProps.status === "pending" ? (
                <TextShimmer
                  as="span"
                  className="truncate text-xs font-normal"
                >
                  {toolDescription}
                </TextShimmer>
              ) : (
                <span className="truncate text-xs font-normal">
                  {toolDescription}
                </span>
              )}
            </div>
            {parsedTiming.duration ? (
              <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground">
                {parsedTiming.duration}
              </span>
            ) : null}
          </button>

          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                data-testid="tool-call-details"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                className="flex flex-col gap-2 pt-1.5 pl-4 pr-1 overflow-hidden"
              >
                {CustomToolComponent ? (
                  <ToolRenderBoundary
                    key={`${toolCallId}-${state}`}
                    toolName={toolName}
                    input={input}
                  >
                    {CustomToolComponent}
                  </ToolRenderBoundary>
                ) : (
                  <>
                    <div
                      className={cn(
                        "min-w-0 w-full p-3 rounded-lg bg-card border text-xs transition-colors",
                      )}
                    >
                      <div className="flex items-center mb-1">
                        <h5 className="text-muted-foreground font-medium select-none">
                          Request
                        </h5>
                        <div className="flex-1" />
                        {copiedInput ? (
                          <Check className="size-3 text-emerald-500" />
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-4 text-muted-foreground"
                            onClick={() =>
                              copyInput(JSON.stringify(input, null, 2))
                            }
                          >
                            <Copy className="size-3" />
                          </Button>
                        )}
                      </div>
                      <div className="max-h-[260px] overflow-y-auto">
                        <JsonView data={input} />
                      </div>
                    </div>

                    {result !== null && result !== undefined ? (
                      <div
                        className={cn(
                          "min-w-0 w-full p-3 rounded-lg bg-card border text-xs transition-colors",
                        )}
                      >
                        <div className="flex items-center mb-1">
                          <h5 className="text-muted-foreground font-medium select-none">
                            Response
                          </h5>
                          <div className="flex-1" />
                          {copiedOutput ? (
                            <Check className="size-3 text-emerald-500" />
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-4 text-muted-foreground"
                              onClick={() =>
                                copyOutput(
                                  typeof result === "string"
                                    ? result
                                    : JSON.stringify(result, null, 2),
                                )
                              }
                            >
                              <Copy className="size-3" />
                            </Button>
                          )}
                        </div>
                        <div className="max-h-[260px] overflow-y-auto">
                          {typeof result === "string" ? (
                            <pre className="font-mono text-xs whitespace-pre-wrap leading-relaxed text-muted-foreground">
                              {parsedTiming.cleanText || result}
                            </pre>
                          ) : (
                            <JsonView data={result} />
                          )}
                        </div>
                      </div>
                    ) : null}
                  </>
                )}

                {isManualToolInvocation && (
                  <div className="flex flex-row gap-2 items-center mt-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="rounded-full text-xs hover:ring py-2"
                      onClick={() =>
                        addToolResult?.({
                          tool: toolName,
                          toolCallId,
                          output: ManualToolConfirmTag.create({
                            confirm: true,
                          }),
                        })
                      }
                    >
                      <Check />
                      {t("Common.approve")}
                      <Separator orientation="vertical" className="h-4" />
                      <span className="text-muted-foreground">
                        {getShortcutKeyList(
                          approveToolInvocationShortcut,
                        ).join(" ")}
                      </span>
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="rounded-full text-xs hover:ring py-2"
                      onClick={() =>
                        addToolResult?.({
                          tool: toolName,
                          toolCallId,
                          output: ManualToolConfirmTag.create({
                            confirm: false,
                          }),
                        })
                      }
                    >
                      <X />
                      {t("Common.reject")}
                      <Separator orientation="vertical" className="h-4" />
                      <span className="text-muted-foreground">
                        {getShortcutKeyList(
                          rejectToolInvocationShortcut,
                        ).join(" ")}
                      </span>
                    </Button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {showActions && (
            <div className="flex flex-row gap-2 items-center mt-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    disabled={isDeleting}
                    onClick={deleteMessage}
                    variant="ghost"
                    size="icon"
                    className="size-3! p-4! opacity-0 group-hover/message:opacity-100 hover:text-destructive"
                  >
                    {isDeleting ? (
                      <Loader className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-destructive" side="bottom">
                  Delete Message
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
    );
  },
  (prev, next) => {
    if (prev.isError !== next.isError) return false;
    if (prev.isLast !== next.isLast) return false;
    if (prev.showActions !== next.showActions) return false;
    if (prev.isManualToolInvocation !== next.isManualToolInvocation)
      return false;
    if (prev.messageId !== next.messageId) return false;
    if (!equal(prev.part, next.part)) return false;
    return true;
  },
);

ToolMessagePart.displayName = "ToolMessagePart";

// File Message Part Component
interface FileMessagePartProps {
  part: FileUIPart; // FileUIPart from AI SDK
  isUserMessage: boolean;
}

export const FileMessagePart = memo(
  ({ part, isUserMessage }: FileMessagePartProps) => {
    const isImage = part.mediaType?.startsWith("image/");

    const ext =
      part.filename?.split(".").pop()?.toUpperCase() ||
      part.mediaType?.split("/").pop()?.toUpperCase() ||
      "";
    const fileExtension =
      ext.length > 0 && ext.length <= 4 ? ext : "FILE";
    const fileUrl = rewriteStorageUrl(part.url);
    const filename =
      part.filename || part.url?.split("/").pop() || "Attachment";

    // Sent attachments sit directly on top of the message bubble, Gemini
    // style: a compact card with the thumbnail (or type tile) on the left
    // and a truncated name, matching the composer's attachment tiles.
    if (isImage && fileUrl) {
      return (
        <div
          className={cn(
            "max-w-xs overflow-hidden rounded-2xl border border-border bg-card shadow-xs",
            isUserMessage ? "ml-auto" : "mr-auto",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fileUrl}
            alt={part.filename || "Uploaded image"}
            className="max-h-56 w-full object-cover"
          />
          {part.filename && (
            <div className="truncate px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
              {part.filename}
            </div>
          )}
        </div>
      );
    }

    // Non-image file
    return (
      <div
        className={cn(
          "flex max-w-xs items-center gap-2.5 rounded-2xl border border-border bg-card py-1.5 pl-1.5 pr-1 shadow-xs",
          isUserMessage ? "ml-auto" : "mr-auto",
        )}
      >
        <div
          aria-hidden
          className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted font-mono text-[10px] font-bold uppercase tracking-wide text-muted-foreground"
        >
          {fileExtension.length > 4 ? (
            <FileIcon className="size-4" />
          ) : (
            fileExtension
          )}
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p
            className="truncate text-sm font-medium text-foreground"
            title={filename}
          >
            {filename}
          </p>
          {part.mediaType &&
            part.mediaType !== "application/octet-stream" && (
              <p
                className="mt-0.5 truncate text-[11px] text-muted-foreground"
                title={part.mediaType}
              >
                {part.mediaType}
              </p>
            )}
        </div>
        {fileUrl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              >
                <a href={fileUrl} download={part.filename ?? filename}>
                  <Download className="size-3.5" />
                  <span className="sr-only">Download {filename}</span>
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  },
);

FileMessagePart.displayName = "FileMessagePart";

// Source URL (non-model) attachment renderer
export function SourceUrlMessagePart({
  part,
  isUserMessage,
}: {
  part: { type: "source-url"; url: string; title?: string; mediaType?: string };
  isUserMessage: boolean;
}) {
  const href = rewriteStorageUrl(part.url);
  const name = part.title || part.url?.split("/").pop() || "attachment";
  const ext = name.split(".").pop()?.toUpperCase() || "FILE";
  const mediaType =
    part.mediaType && part.mediaType !== "application/octet-stream"
      ? part.mediaType
      : undefined;
  return (
    <div
      className={cn(
        "max-w-md rounded-2xl border border-border/80 p-4 backdrop-blur-sm shadow-sm",
        isUserMessage
          ? "ml-auto bg-accent text-accent-foreground border-accent/40"
          : "mr-auto bg-muted/60 text-foreground",
      )}
    >
      <div className="flex items-start gap-4 max-w-sm">
        <div
          className={cn(
            "flex-shrink-0 rounded-xl p-3",
            isUserMessage ? "bg-accent-foreground/10" : "bg-muted",
          )}
        >
          <FileIcon
            className={cn(
              "size-6",
              isUserMessage
                ? "text-accent-foreground/80"
                : "text-muted-foreground",
            )}
          />
        </div>
        <div className="flex-1 min-w-0 space-y-1 pr-3">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "text-sm font-medium hover:underline line-clamp-1",
              isUserMessage ? "text-accent-foreground" : "text-foreground",
            )}
            title={name}
          >
            {name}
          </a>
          <div
            className={cn(
              "flex flex-wrap items-center gap-2 text-xs",
              isUserMessage
                ? "text-accent-foreground/70"
                : "text-muted-foreground",
            )}
          >
            <Badge
              variant="outline"
              className={cn(
                "uppercase tracking-wide px-2 py-0.5",
                isUserMessage &&
                  "border-accent-foreground/30 text-accent-foreground/90",
              )}
            >
              {ext}
            </Badge>
            {mediaType && (
              <span className="truncate max-w-[10rem]" title={mediaType}>
                {mediaType}
              </span>
            )}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              size="icon"
              variant="ghost"
              className={cn(
                "size-9 flex-shrink-0 hover:text-foreground",
                isUserMessage
                  ? "text-accent-foreground/70 hover:text-accent-foreground"
                  : "text-muted-foreground",
              )}
            >
              <a href={href} target="_blank" rel="noopener noreferrer">
                <Download className="size-4" />
                <span className="sr-only">Open attachment</span>
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open attachment</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
