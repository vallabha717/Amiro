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
  BrainIcon,
  Check,
  ChevronDownIcon,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  EllipsisIcon,
  FileIcon,
  HammerIcon,
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

  // Duration is only known for thinking we watched happen. Reopened threads
  // mount with isThinking=false, so they show a plain "Thought".
  const startedAtRef = useRef<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [durationSec, setDurationSec] = useState<number | null>(null);

  useEffect(() => {
    if (isThinking) {
      const startedAt = startedAtRef.current ?? Date.now();
      startedAtRef.current = startedAt;
      const update = () =>
        setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
      update();
      const id = setInterval(update, 1000);
      return () => clearInterval(id);
    }
    if (startedAtRef.current != null) {
      setDurationSec(
        Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)),
      );
      startedAtRef.current = null;
    }
  }, [isThinking]);

  // Follow the stream, but stop following if the user scrolled up to read.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!isThinking || !el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) {
      el.scrollTop = el.scrollHeight;
    }
  }, [reasoningText, isThinking, isExpanded]);

  const wordCount = useMemo(() => {
    return reasoningText.trim().split(/\s+/).filter(Boolean).length;
  }, [reasoningText]);

  const previewSnippet = useMemo(() => {
    const clean = reasoningText.replace(/[#*`_]/g, "").trim();
    if (!clean) return "";
    const firstLine = clean.split("\n")[0].trim();
    return firstLine.length > 70 ? `${firstLine.slice(0, 69)}…` : firstLine;
  }, [reasoningText]);

  const toggle = () => setUserExpanded(!isExpanded);

  if (isThinking) {
    return (
      <div className="flex flex-col select-none my-1.5 animate-in fade-in duration-200">
        <div
          className="flex items-center gap-2 text-xs cursor-pointer py-1 text-muted-foreground hover:text-foreground transition-colors"
          onClick={toggle}
        >
          <TextShimmer className="font-medium tracking-wide">
            Thinking…
          </TextShimmer>
          <span className="tabular-nums text-muted-foreground/70">
            {elapsedSec}s
          </span>
          <button
            data-testid="message-reasoning-toggle"
            type="button"
            className={cn(
              "ml-auto p-1 text-muted-foreground transition-transform duration-200",
              isExpanded && "rotate-180",
            )}
          >
            <ChevronDownIcon size={14} />
          </button>
        </div>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              data-testid="message-reasoning"
              key="streaming-reasoning"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={reasoningTransition}
              className="overflow-hidden"
            >
              <div
                ref={scrollRef}
                className="max-h-40 overflow-y-auto border-l pl-3 ml-1 text-xs text-muted-foreground/80 space-y-2"
              >
                <Markdown>{reasoningText || "Thinking…"}</Markdown>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  const label = durationSec != null ? `Thought for ${durationSec}s` : "Thought";

  return (
    <div className="flex flex-col select-none my-1">
      <div
        className={cn(
          "flex items-center gap-2 text-xs cursor-pointer py-1 px-2.5 rounded-lg border bg-muted/30 hover:bg-muted/60 transition-colors w-fit max-w-full",
          isExpanded && "bg-muted/50 border-primary/20",
        )}
        onClick={toggle}
      >
        <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-muted-foreground">{label}</span>
        {previewSnippet ? (
          <span className="text-[11px] text-muted-foreground/70 truncate max-w-xs md:max-w-md hidden sm:inline">
            · {previewSnippet}
          </span>
        ) : wordCount > 0 ? (
          <span className="text-[10px] text-muted-foreground/60">
            ({wordCount} words)
          </span>
        ) : null}
        <button
          data-testid="message-reasoning-toggle"
          type="button"
          className={cn(
            "shrink-0 p-0.5 text-muted-foreground transition-transform duration-200 ml-1",
            isExpanded && "rotate-180",
          )}
        >
          <ChevronDownIcon size={13} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            data-testid="message-reasoning"
            key="minimized-reasoning"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={reasoningTransition}
            className="overflow-hidden"
          >
            <div className="pl-5 text-muted-foreground border-l ml-3 mt-2 flex flex-col gap-2 text-xs">
              <Markdown>{reasoningText || "Hmm, let's see...🤔"}</Markdown>
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

    const [expanded, setExpanded] = useState(false);
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

    const CustomToolComponent = useMemo(() => {
      // Registry first: a tool with a presenter renders through a shared
      // component, so the chat and any other surface cannot drift. Tools
      // still living in tool-invocation/ fall through below.
      const presenter = getToolPresenter(toolName);
      if (presenter?.Expanded) {
        const Expanded = presenter.Expanded;
        return (
          <Expanded
            key={`${toolCallId}-${toolName}`}
            {...presenterPropsFromToolPart(part)}
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
      return !isCompleted && isLast;
    }, [isCompleted, isLast]);

    return (
      <div className="group w-full">
        {CustomToolComponent ? (
          // Keyed on state so a card that failed to render a half-streamed
          // input recovers by itself once the complete input lands, rather
          // than staying stuck on the error.
          <ToolRenderBoundary
            key={`${toolCallId}-${state}`}
            toolName={toolName}
            input={input}
          >
            {CustomToolComponent}
          </ToolRenderBoundary>
        ) : (
          <div className="flex flex-col w-full my-1 fade-in duration-200 animate-in">
            <div
              className={cn(
                "group/pill flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-card text-xs cursor-pointer transition-colors hover:bg-muted/40",
                isError &&
                  "border-destructive/40 bg-destructive/5 text-destructive",
              )}
              onClick={() => setExpanded(!expanded)}
            >
              <div className="p-1 text-primary bg-input/40 rounded shrink-0">
                {isExecuting ? (
                  <Loader className="size-3.5 animate-spin text-primary" />
                ) : isError ? (
                  <TriangleAlert className="size-3.5 text-destructive" />
                ) : (
                  <HammerIcon className="size-3.5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex items-center gap-1.5 font-medium truncate flex-1">
                {isExecuting ? (
                  <TextShimmer>{mcpServerName}</TextShimmer>
                ) : (
                  <span>{mcpServerName}</span>
                )}
                {mcpToolName ? (
                  <>
                    <ChevronRight className="size-3 text-muted-foreground shrink-0" />
                    <span className="font-mono text-muted-foreground truncate">
                      {mcpToolName}
                    </span>
                  </>
                ) : null}
                {(input as any)?.intent ? (
                  <span className="text-[11px] font-normal text-muted-foreground truncate hidden sm:inline">
                    · {(input as any).intent}
                  </span>
                ) : null}
              </div>
              {parsedTiming.duration ? (
                <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
                  {parsedTiming.duration}
                </span>
              ) : null}
              <div className="shrink-0 p-1 rounded group-hover/pill:bg-muted text-muted-foreground transition-colors duration-200">
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
                    expanded && "rotate-180",
                  )}
                />
              </div>
            </div>

            <AnimatePresence initial={false}>
              {expanded && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                  className="flex flex-col gap-2 pt-2 px-1 overflow-hidden"
                >
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
        )}
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
