"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "ui/badge";
import { cn } from "lib/utils";
import { useSkills } from "@/hooks/queries/use-skills";
import type { SkillSummary } from "@/types/skill";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";

export interface SkillPaletteProps {
  top: number;
  left: number;
  width?: number;
  query: string;
  projectDirectory?: string;
  onSelect: (skill: { name: string; description?: string }) => void;
  onClose: () => void;
  bindKeyDown?: (handler: ((props: SuggestionKeyDownProps) => boolean) | null) => void;
  className?: string;
  style?: React.CSSProperties;
}

const MAX_DISPLAY_COUNT = 50;

export function SkillPalette({
  top,
  left,
  width,
  query,
  projectDirectory,
  onSelect,
  onClose,
  bindKeyDown,
  className,
  style,
}: SkillPaletteProps) {
  const t = useTranslations("Chat.SkillPalette");
  const { data, error, isLoading } = useSkills({
    open: true,
    projectDirectory,
  });

  const [selectedIndex, setSelectedIndex] = useState(0);
  const itemRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  const allItems = data?.items ?? [];

  // Group items project-first, then user-scope, preserving backend ordering
  const projectItems = useMemo(
    () => allItems.filter((item) => item.scope === "project"),
    [allItems],
  );
  const userItems = useMemo(
    () => allItems.filter((item) => item.scope === "user"),
    [allItems],
  );

  // Apply prefix filtering on skill names
  const filterByPrefix = useCallback(
    (list: SkillSummary[]) => {
      if (!query) return list;
      const lower = query.toLowerCase();
      return list.filter((item) => item.name.toLowerCase().startsWith(lower));
    },
    [query],
  );

  const filteredProjectItems = useMemo(
    () => filterByPrefix(projectItems),
    [filterByPrefix, projectItems],
  );
  const filteredUserItems = useMemo(
    () => filterByPrefix(userItems),
    [filterByPrefix, userItems],
  );

  // Combined flat list for keyboard navigation
  const flatItems = useMemo(
    () => [...filteredProjectItems, ...filteredUserItems],
    [filteredProjectItems, filteredUserItems],
  );

  const visibleItems = useMemo(
    () => flatItems.slice(0, MAX_DISPLAY_COUNT),
    [flatItems],
  );
  const moreCount = Math.max(0, flatItems.length - MAX_DISPLAY_COUNT);

  // Reset selected index when query or items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, flatItems.length]);

  // Scroll active item into view
  useEffect(() => {
    const activeItem = visibleItems[selectedIndex];
    if (activeItem && itemRefs.current[activeItem.name]) {
      itemRefs.current[activeItem.name]?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }, [selectedIndex, visibleItems]);

  const handleKeyDown = useCallback(
    ({ event }: SuggestionKeyDownProps): boolean => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) =>
          prev < visibleItems.length - 1 ? prev + 1 : 0,
        );
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : Math.max(0, visibleItems.length - 1),
        );
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (visibleItems.length > 0 && visibleItems[selectedIndex]) {
          event.preventDefault();
          const selected = visibleItems[selectedIndex];
          onSelect({
            name: selected.name,
            description: selected.description,
          });
          return true;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return true;
      }
      return false;
    },
    [visibleItems, selectedIndex, onSelect, onClose],
  );

  // Bind keydown handler to editor suggestion plugin
  useEffect(() => {
    bindKeyDown?.(handleKeyDown);
    return () => {
      bindKeyDown?.(null);
    };
  }, [bindKeyDown, handleKeyDown]);

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
      <div className="flex flex-col max-h-[300px] overflow-y-auto p-1">
        {isLoading && !data ? (
          <div
            data-testid="skill-palette-loading"
            className="flex flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground gap-1"
          >
            <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent mb-1" />
            <div className="font-medium text-foreground">{t("loading")}</div>
          </div>
        ) : error ? (
          <div
            data-testid="skill-palette-error"
            className="flex flex-col items-center justify-center p-6 text-center text-sm text-destructive gap-1"
          >
            <div className="font-medium">{t("errorLoading")}</div>
            <div className="text-xs text-muted-foreground">
              {error.message || "Failed to load skills"}
            </div>
          </div>
        ) : flatItems.length === 0 ? (
          <div
            data-testid="skill-palette-empty"
            className="flex flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground gap-1"
          >
            <Sparkles className="size-5 opacity-40 mb-1" />
            <div className="font-medium text-foreground">{t("noSkillsFound")}</div>
            <Link
              href="/skill?name=new"
              className="text-xs text-primary underline mt-1 cursor-pointer"
              data-testid="skill-palette-create-link"
            >
              {t("createOne")}
            </Link>
          </div>
        ) : (
          <>
            {filteredProjectItems.length > 0 && (
              <div className="mb-1">
                <div
                  data-testid="skill-palette-group-project"
                  className="px-2 py-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
                >
                  {t("projectSkills")}
                </div>
                {filteredProjectItems
                  .slice(0, MAX_DISPLAY_COUNT)
                  .map((item) => {
                    const idx = flatItems.indexOf(item);
                    const isSelected = idx === selectedIndex;
                    return (
                      <SkillRow
                        key={`project-${item.name}`}
                        item={item}
                        isSelected={isSelected}
                        onSelect={() =>
                          onSelect({
                            name: item.name,
                            description: item.description,
                          })
                        }
                        ref={(el) => {
                          itemRefs.current[item.name] = el;
                        }}
                      />
                    );
                  })}
              </div>
            )}

            {filteredUserItems.length > 0 && (
              <div>
                <div
                  data-testid="skill-palette-group-user"
                  className="px-2 py-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
                >
                  {t("userSkills")}
                </div>
                {filteredUserItems
                  .slice(
                    0,
                    Math.max(0, MAX_DISPLAY_COUNT - filteredProjectItems.length),
                  )
                  .map((item) => {
                    const idx = flatItems.indexOf(item);
                    const isSelected = idx === selectedIndex;
                    return (
                      <SkillRow
                        key={`user-${item.name}`}
                        item={item}
                        isSelected={isSelected}
                        onSelect={() =>
                          onSelect({
                            name: item.name,
                            description: item.description,
                          })
                        }
                        ref={(el) => {
                          itemRefs.current[item.name] = el;
                        }}
                      />
                    );
                  })}
              </div>
            )}

            {moreCount > 0 && (
              <div className="px-3 py-1.5 text-xs text-muted-foreground text-center border-t border-border/50">
                {t("moreCount", { count: moreCount })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface SkillRowProps {
  item: SkillSummary;
  isSelected: boolean;
  onSelect: () => void;
  ref?: React.Ref<HTMLDivElement>;
}

const SkillRow = React.forwardRef<HTMLDivElement, SkillRowProps>(
  ({ item, isSelected, onSelect }, ref) => {
    return (
      <div
        ref={ref}
        data-testid={`skill-palette-item-${item.name}`}
        onClick={onSelect}
        className={cn(
          "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm cursor-pointer select-none outline-none transition-colors",
          isSelected
            ? "bg-accent text-accent-foreground font-medium"
            : "hover:bg-muted/50 text-foreground",
        )}
      >
        <div className="size-6 flex items-center justify-center rounded-md bg-primary/10 text-primary shrink-0">
          <Sparkles className="size-3.5" />
        </div>
        <div className="flex flex-col flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate">{item.name}</span>
          </div>
          {item.description ? (
            <span className="text-xs text-muted-foreground truncate">
              {item.description}
            </span>
          ) : null}
        </div>
        <Badge
          variant="outline"
          data-testid={`skill-palette-source-${item.source}`}
          className="text-[10px] uppercase font-mono shrink-0 px-1.5 py-0 h-4 border-muted-foreground/30 text-muted-foreground"
        >
          {item.source}
        </Badge>
      </div>
    );
  },
);

SkillRow.displayName = "SkillRow";
