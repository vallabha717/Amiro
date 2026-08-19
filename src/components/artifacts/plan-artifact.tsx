"use client";

import { cn } from "lib/utils";
import { MessagesSquareIcon, PlayIcon, SendIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { Button } from "ui/button";
import { Separator } from "ui/separator";
import { CommentableMarkdown } from "./commentable-markdown";
import { planBlocks } from "./plan-anchors";
import type { PlanArtifact, PlanComment } from "./use-artifacts";
import { usePlanComments } from "./use-plan-comments";

export type GrantedMode = "manual" | "interactive" | "edit" | "auto";

interface Props {
  plan: PlanArtifact;
  threadId?: string;
  /** The mode Proceed will switch to. Named on the button, never implied. */
  grantedMode: GrantedMode;
  onDecide: (
    decision: "proceed" | "revise",
    comments: PlanComment[],
    grantedMode: GrantedMode,
  ) => void;
  busy?: boolean;
}

/**
 * The implementation plan, as a reviewable document.
 *
 * # Feedback is comments, not edits
 *
 * A comment says "this is wrong, and here is why", and leaves the fix to the
 * agent, which knows what else in the plan depends on the part being objected
 * to. Handing the user a text editor instead takes that judgement back from
 * the only party positioned to exercise it -- change one row of a file table
 * and every later phase that assumed the old row is quietly wrong, with
 * nobody checking. The document is therefore read-only, and every objection
 * is anchored prose the agent has to answer.
 *
 * Two actions in the header, which is the whole contract:
 *
 *   - **Proceed** answers the suspended propose_plan call and lets the turn
 *     continue. It carries any comments already written, because a user who
 *     annotated three things and then decided the plan was good enough
 *     anyway still meant those annotations.
 *   - **Review** switches the gutter into a list of every comment, with one
 *     action to send them back. Sending is a *rejection* of this version --
 *     the agent revises and proposes again.
 *
 * Once answered, the document stays readable and the header goes away. The
 * plan is then a record of what was agreed, and offering buttons that would
 * answer an already-answered call is how a UI invites a click that does
 * nothing and looks broken.
 */
export function PlanArtifactView({
  plan,
  threadId,
  grantedMode,
  onDecide,
  busy,
}: Props) {
  const t = useTranslations("Chat");
  const [reviewing, setReviewing] = useState(false);
  const { comments, add, remove, clear } = usePlanComments(
    threadId,
    plan.toolCallId,
  );
  const blocks = useMemo(() => planBlocks(plan.markdown), [plan.markdown]);

  const modeLabel = useMemo(() => {
    switch (grantedMode) {
      case "auto":
        return t("Tool.autoPermissionMode");
      case "edit":
        return t("Tool.editPermissionMode");
      default:
        return t("Tool.manualPermissionMode");
    }
  }, [grantedMode, t]);

  const decide = useCallback(
    (decision: "proceed" | "revise") => {
      // Comments ride along on both answers. Someone who annotated three
      // things and then decided the plan was good enough anyway still meant
      // those annotations.
      onDecide(decision, comments, grantedMode);
      clear();
      setReviewing(false);
    },
    [comments, grantedMode, onDecide, clear],
  );

  // Three states, not two. "Not pending" used to be read as "answered", but
  // a plan that is still being typed is neither -- it has no decision to
  // show and no decision to ask for yet. Commenting is withheld along with
  // it: an anchor made against a paragraph that is still growing goes stale
  // the instant the next sentence lands.
  const answered = !plan.streaming && !plan.pending;
  const actionable = !plan.streaming && plan.pending;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {plan.title || t("Artifact.planTitle")}
          </h2>
          {plan.streaming ? (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-block size-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
              {t("Artifact.planWriting")}
            </p>
          ) : answered ? (
            <p className="text-[11px] text-muted-foreground">
              {plan.decision?.decision === "proceed"
                ? t("Artifact.planApproved")
                : t("Artifact.planReturned")}
            </p>
          ) : null}
        </div>

        {actionable && (
          <>
            <Button
              size="sm"
              variant={reviewing ? "secondary" : "ghost"}
              className="h-7 rounded-full text-xs"
              onClick={() => setReviewing((open) => !open)}
            >
              <MessagesSquareIcon />
              {t("Artifact.review")}
              {comments.length > 0 && (
                <span className="ml-1 rounded-full bg-amber-500/20 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                  {comments.length}
                </span>
              )}
            </Button>
            <Separator orientation="vertical" className="h-4" />
            <Button
              size="sm"
              className="h-7 rounded-full text-xs active:scale-[0.97] transition-transform duration-[160ms] ease-[var(--ease-out)]"
              disabled={busy}
              onClick={() => decide("proceed")}
            >
              <PlayIcon />
              {/* The mode is named, not implied. Proceed grants write access
                  the plan needs, and a permission change the user did not
                  read is a permission change they did not make. */}
              {t("Artifact.proceedIn", { mode: modeLabel })}
            </Button>
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
        {reviewing && actionable ? (
          <ReviewList
            comments={comments}
            onRemove={remove}
            onSend={() => decide("revise")}
            busy={busy}
          />
        ) : null}

        <div className={cn(reviewing && actionable && "mt-4 border-t pt-4")}>
          <CommentableMarkdown
            markdown={plan.markdown}
            comments={comments}
            onAdd={add}
            onRemove={remove}
            readonly={!actionable}
            isStreaming={plan.streaming}
          />
        </div>

        {blocks.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t("Artifact.planStreaming")}
          </p>
        )}
      </div>
    </div>
  );
}

function ReviewList({
  comments,
  onRemove,
  onSend,
  busy,
}: {
  comments: PlanComment[];
  onRemove: (id: string) => void;
  onSend: () => void;
  busy?: boolean;
}) {
  const t = useTranslations("Chat.Artifact");

  // Nothing to send is the only state with no Send button: a revision request
  // carrying no objection tells the agent to rewrite the plan without saying
  // what was wrong with it, which is a turn spent guessing.
  if (comments.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("noCommentsYet")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {comments.map((comment) => (
        <div
          key={comment.id}
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs"
        >
          {comment.section && (
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {comment.section}
            </p>
          )}
          <p className="mt-0.5 border-l-2 border-amber-500/60 pl-2 italic text-muted-foreground line-clamp-2">
            {comment.quote}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words">{comment.note}</p>
          <button
            type="button"
            className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => onRemove(comment.id)}
          >
            {t("removeComment")}
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-7 rounded-full text-xs active:scale-[0.97] transition-transform duration-[160ms] ease-[var(--ease-out)]"
          disabled={busy}
          onClick={onSend}
        >
          <SendIcon />
          {t("sendComments")}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {t("sendCommentsHint")}
        </span>
      </div>
    </div>
  );
}
