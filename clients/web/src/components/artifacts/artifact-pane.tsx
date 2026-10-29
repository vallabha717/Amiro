"use client";

import { appStore } from "@/app/store";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { cn } from "lib/utils";
import {
  CheckIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  FileTextIcon,
  FolderOpenIcon,
  ListChecksIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useEffect } from "react";
import { useShallow } from "zustand/shallow";
import type { ChatFile } from "lib/file-preview/chat-files";
import { FilesTabView } from "./files-tab-view";
import { PlanArtifactView } from "./plan-artifact";
import { TodoPanel } from "./todo-panel";
import {
  type ArtifactTab,
  type Artifacts,
  artifactStageKey,
} from "./use-artifacts";
import { usePlanDecision } from "./use-plan-decision";
import { WalkthroughView } from "./walkthrough-artifact";

interface Props {
  artifacts: Artifacts;
  /** Workspace files the conversation names, for the Files tab. */
  chatFiles?: ChatFile[];
  threadId?: string;
  addToolResult?: UseChatHelpers<UIMessage>["addToolResult"];
  sendMessage?: UseChatHelpers<UIMessage>["sendMessage"];
  busy?: boolean;
}

const TABS: { id: ArtifactTab; icon: typeof FileTextIcon }[] = [
  { id: "plan", icon: FileTextIcon },
  { id: "tasks", icon: ListChecksIcon },
  { id: "walkthrough", icon: ClipboardListIcon },
  { id: "files", icon: FolderOpenIcon },
];

/**
 * The artifact pane: plan, tasks, walkthrough.
 *
 * It occupies the chat's wide pane, so the chat column's 380px layout needs
 * no new case. Three tabs rather
 * than three panels because they are three views of one turn, and a user
 * comparing "what was agreed" against "what changed" wants them one click
 * apart, not side by side at a third of the width each.
 */
export function ArtifactPane({
  artifacts,
  chatFiles,
  threadId,
  addToolResult,
  sendMessage,
  busy,
}: Props) {
  const t = useTranslations("Chat.Artifact");
  const [tab, mutate] = appStore(
    useShallow((state) => [state.artifactView.tab, state.mutate]),
  );
  const { grantedMode, decide } = usePlanDecision(addToolResult, sendMessage);

  const { plan, todos, walkthrough } = artifacts;

  // A tab whose artifact does not exist yet would show an empty state the
  // user did not ask for. Falling back to one with content keeps the pane
  // useful when it is opened for a reason other than the current tab.
  useEffect(() => {
    if (tab === "plan" && !plan) {
      if (todos)
        mutate((s) => ({ artifactView: { ...s.artifactView, tab: "tasks" } }));
      else if (walkthrough)
        mutate((s) => ({
          artifactView: { ...s.artifactView, tab: "walkthrough" },
        }));
      else
        mutate((s) => ({ artifactView: { ...s.artifactView, tab: "files" } }));
    }
  }, [tab, plan, todos, walkthrough, mutate]);

  // Streaming counts as "needs attention" alongside pending -- a plan that
  // is still being written is exactly the moment the tab badge should catch
  // the eye, not just once it stops and waits.
  const planNeedsAttention = plan?.streaming || plan?.pending;
  const badge: Record<ArtifactTab, string | undefined> = {
    plan: planNeedsAttention ? "•" : undefined,
    tasks: todos ? `${todos.done}/${todos.items.length}` : undefined,
    walkthrough: walkthrough ? "•" : undefined,
    // File artifacts live in server state (SWR inside the tab), not in the
    // transcript projection, so the pane has no count to badge with here.
    files: undefined,
  };
  // Plan → Tasks → Walkthrough is one piece of work in three stages; a
  // finished stage shows a tick so the tab row reads as progress.
  const stageDone: Record<ArtifactTab, boolean> = {
    plan: plan?.decision?.decision === "proceed",
    tasks:
      !!todos && todos.items.length > 0 && todos.done === todos.items.length,
    walkthrough: !!walkthrough && !walkthrough.streaming,
    files: false,
  };

  return (
    <div className="flex h-full flex-col">
      <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
        {TABS.map(({ id, icon: Icon }, index) => {
          const active = tab === id;
          return (
            <Fragment key={id}>
              {index > 0 && index < 3 && (
                <ChevronRightIcon
                  aria-hidden
                  className="size-3 shrink-0 text-muted-foreground/50"
                />
              )}
              {index === 3 && (
                <span aria-hidden className="mx-1 h-4 w-px bg-border" />
              )}
              <button
                type="button"
                data-testid={`artifact-tab-${id}`}
                data-active={active}
                data-done={stageDone[id]}
                onClick={() =>
                  mutate((s) => ({
                    artifactView: { ...s.artifactView, tab: id },
                  }))
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
                  "transition-colors duration-[120ms] ease-[var(--ease-out)]",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                {stageDone[id] ? (
                  <span className="flex size-3.5 items-center justify-center rounded-full bg-emerald-500 text-white">
                    <CheckIcon className="size-2.5" strokeWidth={3} />
                  </span>
                ) : (
                  <Icon className="size-3.5" />
                )}
                {t(`tab_${id}`)}
                {badge[id] && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[10px]",
                      id === "plan" && planNeedsAttention
                        ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {badge[id]}
                  </span>
                )}
              </button>
            </Fragment>
          );
        })}

        <button
          type="button"
          aria-label={t("close")}
          title={t("close")}
          onClick={() =>
            // Closing marks this turn's message as already surfaced (the same
            // key the auto-open effect uses), so it cannot fire again on the
            // next render. Without this, dismissing a pane that opened itself
            // -- or one the user opened from a card -- would simply reopen,
            // which is the app refusing to be closed.
            mutate((s) => ({
              artifactView: {
                ...s.artifactView,
                isOpen: false,
                openedFor: artifacts.stage
                  ? artifactStageKey(artifacts)
                  : s.artifactView.openedFor,
              },
            }))
          }
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-[120ms] ease-[var(--ease-out)] hover:bg-muted/60 hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {tab === "plan" &&
          (plan ? (
            <PlanArtifactView
              plan={plan}
              threadId={threadId}
              grantedMode={grantedMode}
              busy={busy}
              onDecide={(decision, comments, mode) =>
                decide(plan, decision, comments, mode)
              }
            />
          ) : (
            <EmptyState text={t("noPlanYet")} />
          ))}
        {tab === "tasks" && <TodoPanel todos={todos} />}
        {tab === "walkthrough" && (
          <WalkthroughView
            walkthrough={walkthrough}
            plan={plan}
            todos={todos}
          />
        )}
        {tab === "files" && (
          <FilesTabView
            todos={todos}
            threadId={threadId}
            chatFiles={chatFiles}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="max-w-xs text-center text-xs text-muted-foreground">
        {text}
      </p>
    </div>
  );
}
