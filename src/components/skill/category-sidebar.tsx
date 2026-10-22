"use client";

import {
  Calendar,
  Code,
  Globe,
  LayoutGrid,
  Link2,
  type LucideIcon,
  Mail,
  MessageCircle,
  Mic,
  Palette,
  Settings,
  ShoppingCart,
  Sparkles,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const CATEGORY_ICON_MAP: Record<string, LucideIcon> = {
  all: LayoutGrid,
  integrations: Link2,
  voice: Mic,
  email: Mail,
  calendar: Calendar,
  messaging: MessageCircle,
  productivity: Zap,
  development: Code,
  content: Palette,
  system: Settings,
  commerce: ShoppingCart,
  browsing: Globe,
  other: Sparkles,
};

export const DEFAULT_SKILL_CATEGORIES = [
  "all",
  "integrations",
  "voice",
  "email",
  "calendar",
  "messaging",
  "productivity",
  "development",
  "content",
  "system",
  "commerce",
] as const;

export function resolveCategoryIcon(category: string): LucideIcon {
  const normalized = category.toLowerCase().trim();
  return CATEGORY_ICON_MAP[normalized] ?? Sparkles;
}

export function formatCategoryLabel(category: string): string {
  if (category === "all") return "All";
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export interface CategorySidebarProps {
  selected: string;
  onSelect: (category: string) => void;
  counts: Record<string, number>;
  totalCount: number;
  showCounts?: boolean;
  categories?: readonly string[];
  className?: string;
  ariaLabel?: string;
}

export function CategorySidebar({
  selected,
  onSelect,
  counts,
  totalCount,
  showCounts = true,
  categories = DEFAULT_SKILL_CATEGORIES,
  className,
  ariaLabel = "Skill categories",
}: CategorySidebarProps) {
  return (
    <nav
      className={cn("flex flex-col gap-1", className)}
      aria-label={ariaLabel}
    >
      <CategoryRow
        icon={LayoutGrid}
        label="All"
        count={totalCount}
        isActive={selected === "all"}
        showCount={showCounts}
        onClick={() => onSelect("all")}
      />
      {categories
        .filter((cat) => cat !== "all")
        .map((cat) => {
          const Icon = resolveCategoryIcon(cat);
          const count = counts[cat] ?? 0;
          return (
            <CategoryRow
              key={cat}
              icon={Icon}
              label={formatCategoryLabel(cat)}
              count={count}
              isActive={selected === cat}
              showCount={showCounts}
              onClick={() => onSelect(cat)}
            />
          );
        })}
    </nav>
  );
}

interface CategoryRowProps {
  icon: LucideIcon;
  label: string;
  count: number;
  isActive: boolean;
  showCount: boolean;
  onClick: () => void;
}

function CategoryRow({
  icon: Icon,
  label,
  count,
  isActive,
  showCount,
  onClick,
}: CategoryRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-150 cursor-pointer",
        isActive
          ? "bg-secondary text-foreground font-semibold shadow-2xs"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <span className="flex items-center gap-2.5">
        <Icon className={cn("size-4 shrink-0", isActive ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
        <span className="text-xs">{label}</span>
      </span>
      {showCount && (
        <span
          className={cn(
            "font-mono text-[11px] tabular-nums",
            isActive ? "text-foreground font-medium" : "text-muted-foreground/70",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
