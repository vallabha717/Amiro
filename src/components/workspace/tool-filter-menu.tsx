"use client";

import { chatUxStore, toggleIn } from "@/app/store/chat-ux-store";
import { TOOL_CATEGORIES, type ToolCategory } from "lib/chat-ux/tool-categories";
import { cn } from "lib/utils";
import {
  BotIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  ListFilterIcon,
  PlugIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";

export const CATEGORY_ICON: Record<ToolCategory, typeof TerminalIcon> = {
  terminal: TerminalIcon,
  files: FileTextIcon,
  web: GlobeIcon,
  connectors: PlugIcon,
  agents: BotIcon,
  planning: ListChecksIcon,
  other: WrenchIcon,
};

/**
 * Which tool rows the transcript shows. Hiding a category removes its rows
 * from the work log (the count in the header stays honest and says how many
 * are hidden); "Answers only" hides the work log entirely.
 */
export function ToolFilterMenu({
  counts,
  className,
}: {
  counts?: Partial<Record<ToolCategory, number>>;
  className?: string;
}) {
  const [hidden, hideAll, mutate] = chatUxStore(
    useShallow((s) => [s.hiddenToolCategories, s.hideAllTools, s.mutate]),
  );
  const activeFilters = hideAll ? 1 : hidden.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground",
            activeFilters > 0 && "text-foreground bg-accent",
            className,
          )}
          data-testid="tool-filter-trigger"
        >
          <ListFilterIcon className="size-3.5" />
          Tools
          {activeFilters > 0 && (
            <span className="rounded-full bg-primary/15 text-primary px-1.5 text-[10px] tabular-nums">
              {hideAll ? "off" : `−${activeFilters}`}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Show in transcript
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={hideAll}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => mutate({ hideAllTools: Boolean(v) })}
        >
          <span className="flex flex-col">
            <span>Answers only</span>
            <span className="text-[11px] text-muted-foreground">
              Hide every tool call and work log
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {TOOL_CATEGORIES.map((c) => {
          const Icon = CATEGORY_ICON[c.id];
          const n = counts?.[c.id] ?? 0;
          return (
            <DropdownMenuCheckboxItem
              key={c.id}
              disabled={hideAll}
              checked={!hidden.includes(c.id)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() =>
                mutate((s) => ({
                  hiddenToolCategories: toggleIn(s.hiddenToolCategories, c.id),
                }))
              }
            >
              <Icon className="size-3.5 text-muted-foreground" />
              <span className="flex-1">{c.label}</span>
              {n > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums">{n}</span>
              )}
            </DropdownMenuCheckboxItem>
          );
        })}
        {(hidden.length > 0 || hideAll) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => mutate({ hiddenToolCategories: [], hideAllTools: false })}
              className="text-xs"
            >
              Show everything
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
