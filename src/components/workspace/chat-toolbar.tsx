"use client";

import { chatUxStore } from "@/app/store/chat-ux-store";
import type { SessionSummary } from "lib/chat-ux/session-summary";
import { cn } from "lib/utils";
import { PanelRightOpenIcon } from "lucide-react";
import { Button } from "ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { useShallow } from "zustand/shallow";
import { ToolFilterMenu } from "./tool-filter-menu";

/**
 * The thin control strip floating over the transcript's top-right corner:
 * the tool filter, and the button that brings the session panel back once
 * it has been closed. Floating rather than a header row so a thread does
 * not lose a line of reading space to two buttons.
 */
export function ChatToolbar({
  summary,
  className,
}: {
  summary: SessionSummary;
  className?: string;
}) {
  const [panelOpen, mutate] = chatUxStore(
    useShallow((s) => [s.panelOpen, s.mutate] as const),
  );
  return (
    <div
      className={cn(
        "pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/80 p-0.5 shadow-xs backdrop-blur",
        className,
      )}
    >
      <ToolFilterMenu counts={summary.toolCounts} />
      {!panelOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => mutate({ panelOpen: true })}
              aria-label="Show session panel"
              data-testid="session-panel-open"
            >
              <PanelRightOpenIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Session panel</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
