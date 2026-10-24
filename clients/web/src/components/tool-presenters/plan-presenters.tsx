"use client";

import { cn } from "lib/utils";
import { ClipboardListIcon, FileTextIcon } from "lucide-react";
import type { PresenterProps, ToolPresenter } from "./types";

/* ------------------------------------------------------------------ */
/* propose_plan                                                        */
/* ------------------------------------------------------------------ */

/**
 * Count the plan's top-level sections, for the glance line.
 *
 * Headings rather than characters: "4 sections" tells a reader how much
 * decision is in the document, where "2,300 characters" tells them nothing
 * they can act on. Falls back to a line count for a plan written as flat
 * prose, which is rarer but legitimate for a small change.
 */
function planShape(markdown: string): string {
  if (!markdown) return "";
  const headings = markdown
    .split("\n")
    .filter((line) => /^#{1,6}\s+\S/.test(line)).length;
  if (headings > 0) return `${headings} ${headings === 1 ? "section" : "sections"}`;
  const lines = markdown.split("\n").filter((l) => l.trim()).length;
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

function decisionOf(output: any): "proceed" | "revise" | undefined {
  if (output?.decision === "proceed" || output?.decision === "revise") {
    return output.decision;
  }
  return undefined;
}

const proposePlan: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const title = (input?.title as string) || "Implementation plan";
    if (status === "error") return `⚠ ${title} failed`;

    const decision = decisionOf(output);
    if (decision === "proceed") return `${title} · approved`;
    if (decision === "revise") {
      const n = output?.comments?.length ?? 0;
      return n > 0
        ? `${title} · ${n} ${n === 1 ? "comment" : "comments"} returned`
        : `${title} · returned for revision`;
    }
    // Pending is the state that matters most and is easiest to render
    // wrongly: the call is not "running", it is stopped and waiting for a
    // person. The glance line has to say so, because in a collapsed work log
    // it is the only thing the user sees.
    const shape = planShape((input?.plan as string) ?? "");
    return shape ? `${title} · ${shape} · awaiting review` : `${title} · awaiting review`;
  },

  Compact: ({ input, output, status }: PresenterProps) => {
    const decision = decisionOf(output);
    const title = (input?.title as string) || "Implementation plan";
    return (
      <div
        className={cn(
          "w-full overflow-hidden rounded-lg border bg-card",
          status === "error" && "border-destructive/50",
          !decision && status !== "error" && "border-amber-500/40",
        )}
      >
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs font-medium">{title}</span>
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
            {decision === "proceed"
              ? "approved"
              : decision === "revise"
                ? "returned"
                : "awaiting review"}
          </span>
        </div>
        <div className="px-3 py-2 text-[11px] text-muted-foreground">
          {planShape((input?.plan as string) ?? "") || "…"}
        </div>
      </div>
    );
  },
};

// The full document lives in the artifact pane, which has the width for it
// and the commenting the pane exists to provide. Repeating it inside a chat
// message would give the user a second, non-interactive copy of the same
// markdown -- and one they might comment on in their head and then wonder
// why the agent never saw it.
proposePlan.Expanded = proposePlan.Compact;

/* ------------------------------------------------------------------ */
/* walkthrough                                                         */
/* ------------------------------------------------------------------ */

const walkthrough: ToolPresenter = {
  glance: ({ input, output, status }) => {
    if (status === "error") return "walkthrough failed";
    const changes = output?.changes ?? input?.changes ?? [];
    const n = changes.length;
    if (n === 0) return "walkthrough";
    return `walkthrough · ${n} ${n === 1 ? "file" : "files"}`;
  },

  Compact: ({ input, output, status }: PresenterProps) => {
    const summary: string = output?.summary ?? input?.summary ?? "";
    const changes: { path: string }[] = output?.changes ?? input?.changes ?? [];
    return (
      <div
        className={cn(
          "w-full overflow-hidden rounded-lg border bg-card",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <ClipboardListIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium">Walkthrough</span>
          {changes.length > 0 && (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
              {changes.length} {changes.length === 1 ? "file" : "files"}
            </span>
          )}
        </div>
        <div className="px-3 py-2 text-[11px] leading-snug text-muted-foreground line-clamp-3">
          {summary || "…"}
        </div>
      </div>
    );
  },
};

walkthrough.Expanded = ({ input, output, status }: PresenterProps) => {
  const summary: string = output?.summary ?? input?.summary ?? "";
  const changes: { path: string; why: string }[] =
    output?.changes ?? input?.changes ?? [];
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-lg border bg-card",
        status === "error" && "border-destructive/50",
      )}
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <ClipboardListIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">Walkthrough</span>
      </div>
      <div className="space-y-2 px-3 py-2 text-xs">
        <p className="leading-relaxed whitespace-pre-wrap">{summary}</p>
        {changes.length > 0 && (
          <ol className="space-y-1">
            {changes.map((change, i) => (
              <li key={`${change.path}-${i}`} className="flex gap-2">
                <span className="text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0">
                  <span className="font-mono">{change.path}</span>
                  {change.why ? (
                    <span className="text-muted-foreground"> — {change.why}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
};

export const planPresenters = {
  propose_plan: proposePlan,
  walkthrough,
};
