"use client";

import { appStore } from "@/app/store";
import { cn } from "lib/utils";
import {
  ClipboardListIcon,
  FileTextIcon,
  PanelRightOpenIcon,
  PlayIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { Button } from "ui/button";
import type {
  ArtifactTab,
  PlanArtifact,
  WalkthroughArtifact,
} from "./use-artifacts";

/**
 * Open the artifact pane on a given tab, right now.
 *
 * "Right now" is the requirement, not a figure of speech: this runs on the
 * click and the pane is mounted on the same commit. Nothing waits on a
 * timer, a transition end, or a fetch. Anything on that path would be felt
 * as lag on the one interaction whose entire purpose is to get the document
 * in front of the user.
 */
export function useOpenArtifact() {
  const mutate = appStore((state) => state.mutate);
  return useCallback(
    (tab: ArtifactTab) =>
      mutate((state) => ({
        artifactView: { ...state.artifactView, isOpen: true, tab },
      })),
    [mutate],
  );
}

/**
 * The plan, as it appears in the conversation.
 *
 * Rendered outside the work log for the reason the approval cards already
 * are: a suspended call is by construction the last thing the turn did, so
 * it lands inside a section that auto-collapses, and a prompt you have to
 * expand a collapsed section to find reads as a hung turn.
 *
 * It carries Proceed as well as Open, mirroring Antigravity's two Proceed
 * buttons -- one in the conversation, one in the artifact header. A user who
 * has already read the plan should not have to open a panel to agree with it.
 */
export function PlanCard({
  plan,
  grantedModeLabel,
  onProceed,
  busy,
}: {
  plan: PlanArtifact;
  grantedModeLabel: string;
  onProceed: () => void;
  busy?: boolean;
}) {
  const t = useTranslations("Chat.Artifact");
  const open = useOpenArtifact();

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-lg border bg-card",
        (plan.pending || plan.streaming) &&
          "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <button
        type="button"
        onClick={() => open("plan")}
        className="flex w-full items-center gap-2 border-b px-3 py-2 text-left transition-colors duration-[120ms] ease-[var(--ease-out)] hover:bg-muted/50"
      >
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-medium">
          {plan.title || t("planTitle")}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          {plan.streaming ? (
            <>
              <span className="inline-block size-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
              {t("writing")}
            </>
          ) : (
            <>
              <PanelRightOpenIcon className="size-3" />
              {t("openPlan")}
            </>
          )}
        </span>
      </button>

      {/* The plan is worth reading as it grows, not only once it is done --
          this is the same content the pane shows, just at card width. A
          click still opens the full pane for commenting once it settles. */}
      {plan.streaming && plan.markdown && (
        <p className="line-clamp-3 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
          {plan.markdown}
        </p>
      )}

      {plan.pending && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Button
            size="sm"
            className="h-7 rounded-full text-xs active:scale-[0.97] transition-transform duration-[160ms] ease-[var(--ease-out)]"
            data-testid="plan-card-proceed"
            disabled={busy}
            onClick={onProceed}
          >
            <PlayIcon />
            {t("proceedIn", { mode: grantedModeLabel })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-full text-xs"
            onClick={() => open("plan")}
          >
            {t("reviewAndComment")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The walkthrough's conversation card: a summary and a way into the pane. */
export function WalkthroughCard({
  walkthrough,
}: {
  walkthrough: WalkthroughArtifact;
}) {
  const t = useTranslations("Chat.Artifact");
  const open = useOpenArtifact();

  return (
    <button
      type="button"
      onClick={() => open("walkthrough")}
      className={cn(
        "w-full overflow-hidden rounded-lg border bg-card text-left transition-colors duration-[120ms] ease-[var(--ease-out)] hover:bg-muted/50",
        walkthrough.streaming && "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ClipboardListIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">{t("walkthroughTitle")}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          {walkthrough.streaming ? (
            <>
              <span className="inline-block size-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
              {t("writing")}
            </>
          ) : (
            <>
              <PanelRightOpenIcon className="size-3" />
              {t("open")}
            </>
          )}
        </span>
      </div>
      <p className="line-clamp-2 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
        {walkthrough.summary}
      </p>
      {!walkthrough.streaming && walkthrough.unmentioned.length > 0 && (
        <p className="px-3 pb-2 text-[11px] text-amber-600 dark:text-amber-400">
          {t("unmentionedCount", { count: walkthrough.unmentioned.length })}
        </p>
      )}
    </button>
  );
}
