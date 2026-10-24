"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, SquareTerminal } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "ui/badge";
import { cn } from "lib/utils";
import { useSkills } from "@/hooks/queries/use-skills";
import { matchCommands, type ComposerCommand } from "@/lib/backend/composer-api";
import type { SkillSummary } from "@/types/skill";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";

export interface SkillPaletteProps {
  top: number;
  left: number;
  width?: number;
  query: string;
  projectDirectory?: string;
  onSelect: (skill: { name: string; description?: string }) => void;
  /** Run one of the runtime's commands. Without it, only skills are listed. */
  onCommand?: (command: ComposerCommand) => void;
  onClose: () => void;
  bindKeyDown?: (handler: ((props: SuggestionKeyDownProps) => boolean) | null) => void;
  className?: string;
  style?: React.CSSProperties;
}

const MAX_DISPLAY_COUNT = 50;

/**
 * Skills matching the palette query, searched the way Agent → Superpowers
 * searches (name, display name, description), name-prefix matches first.
 */
export function matchSkills<T extends Pick<SkillSummary, "name" | "description" | "displayName">>(
  list: T[],
  query: string,
): T[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return list;
  const rank = (item: T) => {
    const name = item.name.toLowerCase();
    if (name.startsWith(lower)) return 0;
    if (name.includes(lower)) return 1;
    if ((item.displayName ?? "").toLowerCase().includes(lower)) return 2;
    if ((item.description ?? "").toLowerCase().includes(lower)) return 3;
    return -1;
  };
  return list
    .map((item) => ({ item, score: rank(item) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score)
    .map(({ item }) => item);
}

type Entry =
  | { kind: "command"; key: string; command: ComposerCommand }
  | { kind: "skill"; key: string; skill: SkillSummary; group: "project" | "user" };

/**
 * The composer's `/` menu: the embedded runtime's own commands (jcode's
 * `/compact`, `/context`, …), then skills, project ones first. One list for
 * the keyboard; a command runs at once, a skill becomes a chip.
 */
export function SkillPalette({
  top,
  left,
  width,
  query,
  projectDirectory,
  onSelect,
  onCommand,
  onClose,
  bindKeyDown,
  className,
  style,
}: SkillPaletteProps) {
  const t = useTranslations("Chat.SkillPalette");
  const { data, error, isLoading } = useSkills({ open: true, projectDirectory });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  const entries = useMemo<Entry[]>(() => {
    const commands: Entry[] = onCommand
      ? matchCommands(query).map((command) => ({ kind: "command", key: `command-${command}`, command }))
      : [];
    const all = data?.items ?? [];
    const skills = (group: "project" | "user"): Entry[] =>
      matchSkills(all.filter((item) => item.scope === group), query).map((skill) => ({
        kind: "skill",
        key: `${group}-${skill.name}`,
        skill,
        group,
      }));
    return [...commands, ...skills("project"), ...skills("user")].slice(0, MAX_DISPLAY_COUNT);
  }, [data, query, onCommand]);

  const totalSkills = useMemo(() => {
    const all = data?.items ?? [];
    return matchSkills(all, query).length;
  }, [data, query]);
  const shownSkills = entries.filter((e) => e.kind === "skill").length;
  const moreCount = Math.max(0, totalSkills - shownSkills);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, entries.length]);

  useEffect(() => {
    const active = entries[selectedIndex];
    if (active) itemRefs.current[active.key]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedIndex, entries]);

  const choose = useCallback(
    (entry: Entry) => {
      if (entry.kind === "command") onCommand?.(entry.command);
      else onSelect({ name: entry.skill.name, description: entry.skill.description });
    },
    [onCommand, onSelect],
  );

  const handleKeyDown = useCallback(
    ({ event }: SuggestionKeyDownProps): boolean => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) => (prev < entries.length - 1 ? prev + 1 : 0));
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(0, entries.length - 1)));
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && entries[selectedIndex]) {
        event.preventDefault();
        choose(entries[selectedIndex]);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return true;
      }
      return false;
    },
    [entries, selectedIndex, choose, onClose],
  );

  useEffect(() => {
    bindKeyDown?.(handleKeyDown);
    return () => bindKeyDown?.(null);
  }, [bindKeyDown, handleKeyDown]);

  const commandEntries = entries.filter((e) => e.kind === "command");
  const projectEntries = entries.filter((e) => e.kind === "skill" && e.group === "project");
  const userEntries = entries.filter((e) => e.kind === "skill" && e.group === "user");
  const row = (entry: Entry) => {
    const index = entries.indexOf(entry);
    const ref = (el: HTMLDivElement | null) => {
      itemRefs.current[entry.key] = el;
    };
    return entry.kind === "command" ? (
      <CommandRow key={entry.key} ref={ref} command={entry.command}
        description={t(`commands.${entry.command}`)} isSelected={index === selectedIndex}
        onSelect={() => choose(entry)} />
    ) : (
      <SkillRow key={entry.key} ref={ref} item={entry.skill} isSelected={index === selectedIndex}
        onSelect={() => choose(entry)} />
    );
  };
  const heading = (testId: string, label: string) => (
    <div data-testid={testId}
      className="px-2 py-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
      {label}
    </div>
  );
  const skillsLoading = isLoading && !data;

  return (
    <div
      data-testid="skill-palette"
      className={cn(
        "fixed z-50 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95",
        className,
      )}
      style={{
        top: Math.max(8, top - 320),
        left,
        width: width ? Math.max(320, width) : 480,
        maxHeight: "300px",
        ...style,
      }}
    >
      <div className="flex max-h-[300px] flex-col overflow-y-auto p-1">
        {commandEntries.length > 0 && (
          <div className="mb-1">
            {heading("skill-palette-group-commands", t("commandsTitle"))}
            {commandEntries.map(row)}
          </div>
        )}
        {skillsLoading ? (
          <div data-testid="skill-palette-loading"
            className="flex items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            {t("loading")}
          </div>
        ) : error ? (
          <div data-testid="skill-palette-error"
            className="flex flex-col items-center justify-center gap-1 p-4 text-center text-sm text-destructive">
            <div className="font-medium">{t("errorLoading")}</div>
            <div className="text-xs text-muted-foreground">{error.message || t("errorLoading")}</div>
          </div>
        ) : entries.length === 0 ? (
          <div data-testid="skill-palette-empty"
            className="flex flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
            <Sparkles className="mb-1 size-5 opacity-40" />
            <div className="font-medium text-foreground">{t("noSkillsFound")}</div>
            <Link href="/skill?name=new" className="mt-1 cursor-pointer text-xs text-primary underline"
              data-testid="skill-palette-create-link">
              {t("createOne")}
            </Link>
          </div>
        ) : (
          <>
            {projectEntries.length > 0 && (
              <div className="mb-1">
                {heading("skill-palette-group-project", t("projectSkills"))}
                {projectEntries.map(row)}
              </div>
            )}
            {userEntries.length > 0 && (
              <div>
                {heading("skill-palette-group-user", t("userSkills"))}
                {userEntries.map(row)}
              </div>
            )}
            {moreCount > 0 && (
              <div className="border-t border-border/50 px-3 py-1.5 text-center text-xs text-muted-foreground">
                {t("moreCount", { count: moreCount })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const rowClass = (isSelected: boolean) =>
  cn(
    "relative flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors select-none",
    isSelected ? "bg-accent font-medium text-accent-foreground" : "text-foreground hover:bg-muted/50",
  );

const CommandRow = React.forwardRef<
  HTMLDivElement,
  { command: ComposerCommand; description: string; isSelected: boolean; onSelect: () => void }
>(({ command, description, isSelected, onSelect }, ref) => (
  <div ref={ref} data-testid={`skill-palette-command-${command}`} onClick={onSelect} className={rowClass(isSelected)}>
    <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <SquareTerminal className="size-3.5" />
    </div>
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-mono font-semibold">/{command}</span>
      <span className="truncate text-xs text-muted-foreground">{description}</span>
    </div>
  </div>
));
CommandRow.displayName = "CommandRow";

interface SkillRowProps {
  item: SkillSummary;
  isSelected: boolean;
  onSelect: () => void;
}

const SkillRow = React.forwardRef<HTMLDivElement, SkillRowProps>(({ item, isSelected, onSelect }, ref) => (
  <div ref={ref} data-testid={`skill-palette-item-${item.name}`} onClick={onSelect} className={rowClass(isSelected)}>
    <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
      <Sparkles className="size-3.5" />
    </div>
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-semibold">{item.name}</span>
      {item.description ? <span className="truncate text-xs text-muted-foreground">{item.description}</span> : null}
    </div>
    <Badge variant="outline" data-testid={`skill-palette-source-${item.source}`}
      className="h-4 shrink-0 border-muted-foreground/30 px-1.5 py-0 font-mono text-[10px] text-muted-foreground uppercase">
      {item.source}
    </Badge>
  </div>
));
SkillRow.displayName = "SkillRow";
