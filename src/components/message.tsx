"use client";

import { type UIMessage, getToolName, isToolUIPart } from "ai";
import equal from "lib/equal";
import { type ReactNode, memo, useMemo, useState } from "react";

import type { UseChatHelpers } from "@ai-sdk/react";
import { ChatMetadata, ManualToolConfirmTag } from "app-types/chat";
import { editRowSummary, stepKindOf } from "lib/ai/tools/step-kind";
import { cn, truncateString } from "lib/utils";
import { ChevronDown, ChevronUp, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "ui/button";
import { PlanCard, WalkthroughCard } from "./artifacts/plan-card";
import { useArtifacts } from "./artifacts/use-artifacts";
import { usePlanDecision } from "./artifacts/use-plan-decision";
import { type CompactionData, CompactionMarker } from "./compaction-marker";
import {
  AssistMessagePart,
  FileMessagePart,
  ReasoningPart,
  SourceUrlMessagePart,
  ToolMessagePart,
  UserMessagePart,
} from "./message-parts";
import {
  type ApprovalScope,
  ToolApprovalCard,
  type ToolApprovalRequest,
  getToolPresenter,
  presenterPropsFromToolPart,
} from "./tool-presenters";
import { WorkLog, type WorkLogRow } from "./work-log";

interface Props {
  message: UIMessage;
  prevMessage?: UIMessage;
  threadId?: string;
  isLoading?: boolean;
  isLastMessage?: boolean;
  setMessages?: UseChatHelpers<UIMessage>["setMessages"];
  sendMessage?: UseChatHelpers<UIMessage>["sendMessage"];
  className?: string;
  addToolResult?: UseChatHelpers<UIMessage>["addToolResult"];
  status?: UseChatHelpers<UIMessage>["status"];
  readonly?: boolean;
}

const PurePreviewMessage = ({
  message,
  prevMessage,
  readonly,
  threadId,
  isLoading,
  isLastMessage,
  status,
  className,
  setMessages,
  addToolResult,
  sendMessage,
}: Props) => {
  const isUserMessage = useMemo(() => message.role === "user", [message.role]);
  const partsForDisplay = useMemo(
    () =>
      (message.parts ?? []).filter(
        (part) => !(part.type === "text" && (part as any).ingestionPreview),
      ),
    [message.parts],
  );

  /**
   * Tool calls this turn stopped on, waiting for the user to say yes.
   *
   * Derived from the parts rather than held in state, so a reload finds it
   * again: the backend persists a `data-tool-approval` part next to the
   * suspended call, and a call is still pending exactly while its tool part
   * has not moved past "input-available". Once the answer round-trips, the
   * tool part gains a real result and this list empties on its own -- there
   * is no separate "dismissed" flag to get out of sync.
   */
  const pendingApprovals = useMemo(() => {
    const requests = partsForDisplay.filter(
      (part) => part.type === "data-tool-approval",
    );
    if (requests.length === 0) return [];

    return requests.flatMap((part) => {
      const request = (part as any).data as ToolApprovalRequest | undefined;
      if (!request?.toolCallId) return [];
      const call = partsForDisplay.find(
        (p) => isToolUIPart(p) && p.toolCallId === request.toolCallId,
      );
      if (!call || (call as any).state !== "input-available") return [];
      return [{ request, input: (call as any).input }];
    });
  }, [partsForDisplay]);

  /**
   * The artifacts this one turn produced.
   *
   * Scoped to the message rather than the thread on purpose: the cards belong
   * in the turn that made them, and the walkthrough's "files you changed but
   * did not mention" check compares against *this* turn's edits. The pane
   * shows the thread-wide latest; these are the entry points to it.
   */
  const justThisMessage = useMemo(() => [message], [message]);
  const { plan, walkthrough } = useArtifacts(justThisMessage, isLoading);
  const { grantedMode, decide } = usePlanDecision(addToolResult);
  const t = useTranslations("Chat.Tool");
  const grantedModeLabel =
    grantedMode === "auto"
      ? t("autoPermissionMode")
      : grantedMode === "edit"
        ? t("editPermissionMode")
        : t("manualPermissionMode");

  if (message.role == "system") {
    return null; // system message is not shown
  }
  if (!partsForDisplay.length) return null;

  return (
    <div
      className="w-full mx-auto max-w-3xl px-6 group/message"
      data-message-id={message.id}
      data-message-role={message.role}
    >
      <div
        className={cn(
          "flex gap-4 w-full group-data-[role=user]/message:ml-auto group-data-[role=user]/message:max-w-2xl",
          className,
        )}
      >
        <div className="flex flex-col gap-4 w-full">
          {(() => {
            const renderPart = (
              part: (typeof partsForDisplay)[number],
              index: number,
            ) => {
              // Keyed by the message's own id, never its position in the list.
              // With a positional key, appending or inserting a message shifts
              // every later key, so React tears down and remounts parts that did
              // not change -- and for a client-executed tool (CodeExecutor) a
              // remount recreates its "already ran" ref, so the user's code runs
              // a second time.
              const key = `${message.id}-part-${part.type}-${index}`;
              const isLastPart = index === partsForDisplay.length - 1;

              if (part.type === "reasoning") {
                return (
                  <ReasoningPart
                    key={key}
                    readonly={readonly}
                    reasoningText={part.text}
                    isThinking={isLastPart && isLastMessage && isLoading}
                  />
                );
              }

              if (isUserMessage && part.type === "text" && part.text) {
                return (
                  <UserMessagePart
                    key={key}
                    status={status}
                    part={part}
                    readonly={readonly}
                    isLast={isLastPart}
                    message={message}
                    setMessages={setMessages}
                    sendMessage={sendMessage}
                  />
                );
              }

              if (part.type === "text" && !isUserMessage) {
                return (
                  <AssistMessagePart
                    threadId={threadId}
                    isLast={isLastMessage && isLastPart}
                    isLoading={isLoading}
                    key={key}
                    readonly={readonly}
                    part={part}
                    prevMessage={prevMessage}
                    showActions={
                      isLastMessage ? isLastPart && !isLoading : isLastPart
                    }
                    message={message}
                    setMessages={setMessages}
                    sendMessage={sendMessage}
                  />
                );
              }

              if (isToolUIPart(part)) {
                const isLast = isLastMessage && isLastPart;
                const isManualToolInvocation =
                  (message.metadata as ChatMetadata)?.toolChoice == "manual" &&
                  isLastMessage &&
                  isLastPart &&
                  part.state == "input-available" &&
                  isLoading &&
                  !readonly;
                return (
                  <ToolMessagePart
                    isLast={isLast}
                    readonly={readonly}
                    messageId={message.id}
                    isManualToolInvocation={isManualToolInvocation}
                    showActions={
                      !readonly &&
                      (isLastMessage ? isLastPart && !isLoading : isLastPart)
                    }
                    addToolResult={addToolResult}
                    key={key}
                    part={part}
                    setMessages={setMessages}
                  />
                );
              } else if (part.type === "step-start") {
                return null;
              } else if (part.type === "file") {
                return (
                  <FileMessagePart
                    key={key}
                    part={part}
                    isUserMessage={isUserMessage}
                  />
                );
              } else if ((part as any).type === "source-url") {
                return (
                  <SourceUrlMessagePart
                    key={key}
                    part={part as any}
                    isUserMessage={isUserMessage}
                  />
                );
              } else if (part.type === "data-context-compacted") {
                // The one data part that *is* rendered where it sits: it
                // marks a moment in the turn, so its position in the feed
                // is the information. A user scrolling back needs to see
                // where the agent stopped being able to remember the
                // beginning.
                return (
                  <CompactionMarker
                    key={key}
                    data={(part as any).data as CompactionData}
                  />
                );
              } else if (part.type.startsWith("data-")) {
                // Other data parts carry state for dedicated UI, not
                // something to render in place -- an approval request is
                // shown by the card below the work log, where it cannot be
                // collapsed out of sight.
                return null;
              } else {
                return <div key={key}> unknown part {part.type}</div>;
              }
            };

            // An assistant turn that used tools is shown as a collapsible work
            // log plus its final answer. The split point is the last tool call:
            // everything up to it is *how* the answer was reached, everything
            // after is the answer. A turn with no tool calls renders exactly as
            // it always did -- a plain reply must not grow a "Worked for 0s"
            // header.
            const lastToolIndex = isUserMessage
              ? -1
              : partsForDisplay.reduce(
                  (acc, part, i) => (isToolUIPart(part) ? i : acc),
                  -1,
                );

            // The approval prompts, rendered outside the work log on
            // purpose. The suspended call is by construction the *last*
            // thing the turn did, so it lands inside the log -- which
            // auto-collapses. A prompt the user has to expand a collapsed
            // section to find is a prompt that reads as a hung turn.
            const approvals =
              readonly ||
              !addToolResult ||
              pendingApprovals.length === 0 ? null : (
                <div className="flex flex-col gap-2">
                  {pendingApprovals.map(({ request, input }) => (
                    <ToolApprovalCard
                      key={request.toolCallId}
                      request={request}
                      input={input}
                      disabled={Boolean(isLoading)}
                      onDecide={(confirm: boolean, scope: ApprovalScope) =>
                        addToolResult({
                          tool: request.toolName,
                          toolCallId: request.toolCallId,
                          output: ManualToolConfirmTag.create({
                            confirm,
                            scope,
                          }),
                        })
                      }
                    />
                  ))}
                </div>
              );

            /**
             * The artifact cards, rendered next to the approval cards and
             * outside the work log, for exactly the same reason: a suspended
             * plan is by construction the last thing the turn did, so it
             * lands in a section that auto-collapses, and a decision the user
             * has to expand a collapsed row to find reads as a hung turn.
             */
            const artifactCards =
              !plan && !walkthrough ? null : (
                <div className="flex flex-col gap-2">
                  {plan && (
                    <PlanCard
                      plan={plan}
                      grantedModeLabel={grantedModeLabel}
                      busy={Boolean(isLoading) || readonly}
                      onProceed={() =>
                        decide(plan, "proceed", [], grantedMode)
                      }
                    />
                  )}
                  {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}
                </div>
              );

            if (lastToolIndex < 0) {
              return (
                <>
                  {partsForDisplay.map(renderPart)}
                  {artifactCards}
                  {approvals}
                </>
              );
            }

            const workParts = partsForDisplay.slice(0, lastToolIndex + 1);
            const tailParts = partsForDisplay.slice(lastToolIndex + 1);

            const rows: WorkLogRow[] = [];
            let toolCount = 0;
            for (let i = 0; i < workParts.length; i++) {
              const part = workParts[i];
              if (part.type === "step-start") continue;

              if (!isToolUIPart(part)) {
                rows.push({
                  type: "prose",
                  children: renderPart(part, i),
                });
                continue;
              }

              const toolName = getToolName(part);
              const kind = stepKindOf(toolName, (part as any).input);
              const presenterProps = presenterPropsFromToolPart(part);
              const status = presenterProps.status;
              const glance =
                getToolPresenter(toolName)?.glance(presenterProps) ?? toolName;
              toolCount++;

              // A write gets its own row, named after the file it touched;
              // reads fold into a count. Folding writes would collapse
              // "Edited client.go +6 −0" and "Edited stream_step.go +32 −5"
              // into "Edited 2 files", which drops the two things anyone
              // scanning a run of edits is actually looking for.
              const file = editRowSummary(toolName, presenterProps);
              const prev = rows[rows.length - 1];
              if (
                !file &&
                prev?.type === "group" &&
                prev.kind === kind &&
                !prev.file
              ) {
                prev.glances.push({ text: glance, failed: status === "error" });
                (prev.children as ReactNode[]).push(renderPart(part, i));
              } else {
                rows.push({
                  type: "group",
                  kind,
                  glances: [{ text: glance, failed: status === "error" }],
                  file: file ?? undefined,
                  children: [renderPart(part, i)] as ReactNode[],
                });
              }
            }

            const isWorkLogRunning = Boolean(
              isLastMessage &&
                isLoading &&
                (tailParts.every((p) => p.type !== "text" || !p.text?.trim()) ||
                  workParts.some(
                    (p) => isToolUIPart(p) && !p.state.startsWith("output"),
                  )),
            );

            return (
              <>
                <WorkLog
                  rows={rows}
                  isRunning={isWorkLogRunning}
                  stepCount={toolCount}
                  durationMs={
                    (message.metadata as ChatMetadata | undefined)?.durationMs
                  }
                />
                {tailParts.map((part, i) =>
                  renderPart(part, lastToolIndex + 1 + i),
                )}
                {artifactCards}
                {approvals}
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
};

export const PreviewMessage = memo(
  PurePreviewMessage,
  function equalMessage(prevProps: Props, nextProps: Props) {
    if (prevProps.message.id !== nextProps.message.id) return false;

    if (prevProps.isLoading !== nextProps.isLoading) return false;

    if (prevProps.isLastMessage !== nextProps.isLastMessage) return false;

    if (prevProps.className !== nextProps.className) return false;

    if (nextProps.isLoading && nextProps.isLastMessage) return false;

    if (!equal(prevProps.message.metadata, nextProps.message.metadata))
      return false;

    if (
      (prevProps.message.parts?.length ?? 0) !==
      (nextProps.message.parts?.length ?? 0)
    ) {
      return false;
    }
    if (!equal(prevProps.message.parts, nextProps.message.parts)) {
      return false;
    }

    return true;
  },
);

export const ErrorMessage = ({
  error,
}: {
  error: Error;
  message?: UIMessage;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const maxLength = 200;
  const t = useTranslations();
  return (
    <div className="w-full mx-auto max-w-3xl px-6 animate-in fade-in mt-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-4 px-2 opacity-70">
          <div className="flex items-start gap-3">
            <div className="p-1.5 bg-muted rounded-sm">
              <TriangleAlertIcon className="h-3.5 w-3.5 text-destructive" />
            </div>
            <div className="flex-1">
              <p className="font-medium text-sm mb-2">{t("Chat.Error")}</p>
              <div className="text-sm text-muted-foreground">
                <div className="whitespace-pre-wrap">
                  {isExpanded
                    ? error.message
                    : truncateString(error.message, maxLength)}
                </div>
                {error.message.length > maxLength && (
                  <Button
                    onClick={() => setIsExpanded(!isExpanded)}
                    variant={"ghost"}
                    className="h-auto p-1 text-xs mt-2"
                    size={"sm"}
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp className="h-3 w-3 mr-1" />
                        {t("Common.showLess")}
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3 mr-1" />
                        {t("Common.showMore")}
                      </>
                    )}
                  </Button>
                )}
                <p className="text-xs text-muted-foreground mt-3 italic">
                  {t("Chat.thisMessageWasNotSavedPleaseTryTheChatAgain")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
