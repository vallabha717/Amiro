"use client";

import { appStore } from "@/app/store";
import { useAgentIdentity } from "@/hooks/queries/use-agent-identity";
import { useMutateSkills, useSkills } from "@/hooks/queries/use-skills";
import { duplicateSkill } from "@/lib/backend/skills-api";
import { cn } from "@/lib/utils";
import type { SkillSummary } from "@/types/skill";
import type { ChatMention } from "app-types/chat";
import {
  ArrowLeft,
  Box,
  Copy,
  Plus,
  Search,
  Sparkles,
  Terminal,
  User,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import { Card } from "ui/card";
import { Input } from "ui/input";
import { Skeleton } from "ui/skeleton";
import {
  CategorySidebar,
  DEFAULT_SKILL_CATEGORIES,
  formatCategoryLabel,
  resolveCategoryIcon,
} from "./category-sidebar";

type SuperpowerFilter = "all" | "builtin" | "custom" | "project";

const TIP_STORAGE_KEY = "amiro:superpowers:tipDismissed";

/** Where a skill comes from, as the user thinks of it. */
function kindOf(skill: SkillSummary): "builtin" | "project" | "custom" {
  if (skill.bundled) return "builtin";
  if (skill.scope === "project") return "project";
  return "custom";
}

const KIND_LABEL = {
  builtin: "Built-in",
  project: "Project",
  custom: "My skill",
} as const;

const KIND_ICON = {
  builtin: Box,
  project: Terminal,
  custom: User,
} as const;

/** "mcp-setup" -> "Mcp setup" when a skill has no display name. */
function titleOf(skill: SkillSummary): string {
  if (skill.displayName) return skill.displayName;
  const words = skill.name.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function SkillsList() {
  const t = useTranslations();
  const router = useRouter();
  const projectDirectory = appStore((state) => state.projectDirectory);
  const { data, isLoading, error } = useSkills({ projectDirectory });
  const mutateSkills = useMutateSkills();
  const { data: identity } = useAgentIdentity();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SuperpowerFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [duplicatingName, setDuplicatingName] = useState<string | null>(null);
  const [tipDismissed, setTipDismissed] = useState(false);

  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        setTipDismissed(window.localStorage.getItem(TIP_STORAGE_KEY) === "true");
      }
    } catch {
      // Ignore local storage errors
    }
  }, []);

  const handleDismissTip = useCallback(() => {
    setTipDismissed(true);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(TIP_STORAGE_KEY, "true");
      }
    } catch {
      // Ignore local storage errors
    }
  }, []);

  const items = data?.items ?? [];
  const agentName = identity?.name || "Amiro";

  // Calculate counts per category
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const skill of items) {
      const cat = (skill.category || "other").toLowerCase();
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((s) => {
      if (filter !== "all" && kindOf(s) !== filter) return false;
      if (category !== "all" && (s.category || "").toLowerCase() !== category) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        titleOf(s).toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q) ||
        (s.category || "").toLowerCase().includes(q)
      );
    });
  }, [items, query, filter, category]);

  const handleUseInChat = useCallback(
    (skill: SkillSummary, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (skill.deliverable === false || skill.disableModelInvocation) return;
      const mention: ChatMention = {
        type: "skill",
        name: skill.name,
        description: skill.description,
      };
      const currentThreadId = appStore.getState().currentThreadId;
      if (currentThreadId) {
        appStore.setState((prev) => ({
          threadMentions: {
            ...prev.threadMentions,
            [currentThreadId]: [
              ...(prev.threadMentions[currentThreadId] || []).filter(
                (v) => !(v.type === "skill" && v.name === skill.name),
              ),
              mention,
            ],
          },
        }));
      } else {
        appStore.setState({ pendingThreadMention: mention });
      }
      router.push(
        currentThreadId ? `/?thread=${encodeURIComponent(currentThreadId)}` : "/",
      );
    },
    [router],
  );

  const handleDuplicate = useCallback(
    async (skill: SkillSummary, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDuplicatingName(skill.name);
      try {
        const res = await duplicateSkill(skill.name, projectDirectory ?? undefined);
        mutateSkills(res.skill);
        toast.success(`Cloned /${skill.name} as /${res.skill.name}`);
        router.push(`/skill?name=${encodeURIComponent(res.skill.name)}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not duplicate skill.");
      } finally {
        setDuplicatingName(null);
      }
    },
    [projectDirectory, mutateSkills, router],
  );

  const showEmptyAll = !isLoading && !error && items.length === 0;
  const showFilteredEmpty = !isLoading && !error && items.length > 0 && filtered.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6 md:p-8">
      {/* Vellum Tip Banner */}
      {!tipDismissed && (
        <div
          data-slot="tip-banner"
          className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/70 px-4 py-3 text-xs text-muted-foreground backdrop-blur-xs transition-colors"
        >
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <p className="flex-1 leading-relaxed">
            Skills shape your agent&apos;s instructions, not its permissions. Actions still depend on the tools enabled in Amiro.
          </p>
          <button
            type="button"
            onClick={handleDismissTip}
            aria-label="Dismiss tip"
            className="cursor-pointer rounded-full p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            href="/agent"
            data-testid="superpowers-back-link"
            className="mt-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Agent Hub
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1
                className="font-brand text-2xl font-bold tracking-tight sm:text-[28px]"
                data-testid="skills-title"
              >
                Superpowers
              </h1>
              <Badge
                variant="secondary"
                className="rounded-full font-mono text-[11px] tabular-nums"
              >
                {items.length} total
              </Badge>
            </div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Skills and capabilities powering {agentName}. Search, reuse, or create your own.
            </p>
          </div>
        </div>

        <Link href="/skill?name=new" className="shrink-0">
          <Button
            size="sm"
            className="gap-1.5 rounded-full px-4 font-medium"
            data-testid="create-skill-button"
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("Skill.newSkill")}
          </Button>
        </Link>
      </div>

      {/* Search & Origin Filters Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-[360px]">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search superpowers"
            placeholder="Search by name or description…"
            data-testid="superpowers-search-input"
            className="h-9 rounded-full bg-card pl-9 pr-9 text-sm placeholder:text-muted-foreground/70"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-1 -translate-y-1/2 cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter superpowers">
          {(
            [
              ["all", "All"],
              ["builtin", "Built-in"],
              ["custom", "My skills"],
              ...(items.some((s) => s.scope === "project") ? [["project", "Project"]] : []),
            ] as [SuperpowerFilter, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-testid={`superpowers-filter-${id}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                "cursor-pointer rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors",
                filter === id
                  ? "border-foreground bg-foreground text-background shadow-xs font-semibold"
                  : "border-border/70 bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Mobile Category Bar (visible only on mobile) */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:hidden" role="group" aria-label="Mobile categories">
        {DEFAULT_SKILL_CATEGORIES.map((cat) => {
          const Icon = resolveCategoryIcon(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                category === cat
                  ? "bg-secondary font-semibold text-foreground"
                  : "bg-card text-muted-foreground hover:bg-muted/70 hover:text-foreground border border-border/60",
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              <span>{formatCategoryLabel(cat)}</span>
            </button>
          );
        })}
      </div>

      {/* Two-Column Layout: Left Category Rail (Desktop) + Right Superpowers Content */}
      <div className="flex min-h-0 flex-1 gap-6 items-start">
        {/* Desktop Category Rail */}
        <aside className="hidden md:block w-52 shrink-0">
          <div className="sticky top-20 rounded-2xl border border-border/60 bg-card/50 p-2 backdrop-blur-xs">
            <CategorySidebar
              selected={category}
              onSelect={setCategory}
              counts={categoryCounts}
              totalCount={items.length}
              showCounts={true}
              categories={DEFAULT_SKILL_CATEGORIES}
            />
          </div>
        </aside>

        {/* Superpowers List / Grid Column */}
        <main className="min-w-0 flex-1">
          {isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} className="rounded-2xl border-border/60 p-4">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="mt-3 h-3 w-full" />
                  <Skeleton className="mt-2 h-3 w-5/6" />
                  <div className="mt-4 flex gap-2">
                    <Skeleton className="h-6 w-16 rounded-full" />
                    <Skeleton className="ml-auto h-7 w-20 rounded-full" />
                  </div>
                </Card>
              ))}
            </div>
          ) : error ? (
            <Card className="rounded-2xl border-destructive/20 bg-destructive/5 p-8 text-center" role="alert">
              <p className="text-sm font-medium text-destructive">Couldn&apos;t load superpowers.</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                {(error as Error)?.message || "Something went wrong while fetching skills. Please try again."}
              </p>
              <Button variant="outline" size="sm" className="mt-4 rounded-full" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </Card>
          ) : showEmptyAll ? (
            <Card className="rounded-2xl border-dashed bg-card/60 px-6 py-14 text-center sm:py-16">
              <div className="mx-auto flex max-w-md flex-col items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                  <Sparkles className="size-5" aria-hidden="true" />
                </div>
                <h2 className="text-base font-semibold">No superpowers yet</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Your workspace has no skills installed. Create your first one to give {agentName} a reusable capability.
                </p>
                <Link href="/skill?name=new" className="mt-2">
                  <Button size="sm" className="rounded-full px-5">
                    <Plus className="size-4" aria-hidden="true" />
                    Create skill
                  </Button>
                </Link>
                <p className="text-[11px] text-muted-foreground/70">You can also add skills from your project&apos;s agent directory.</p>
              </div>
            </Card>
          ) : showFilteredEmpty ? (
            <Card className="rounded-2xl border-border/60 bg-card/50 px-6 py-10 text-center">
              <p className="text-sm font-medium">No matches</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                No superpowers match &quot;{query.trim()}&quot;
                {filter !== "all" ? ` in ${filter === "builtin" ? "Built-in" : filter === "custom" ? "My skills" : "Project"}` : ""}
                {category !== "all" ? ` under ${formatCategoryLabel(category)}` : ""}. Try a different search or filter.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4 rounded-full"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                  setCategory("all");
                }}
              >
                Clear search & filters
              </Button>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="superpowers-grid">
              {filtered.map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  onUseInChat={handleUseInChat}
                  onDuplicate={handleDuplicate}
                  duplicating={duplicatingName === skill.name}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function SkillCard({
  skill,
  onUseInChat,
  onDuplicate,
  duplicating,
}: {
  skill: SkillSummary;
  onUseInChat: (skill: SkillSummary, e: React.MouseEvent) => void;
  onDuplicate: (skill: SkillSummary, e: React.MouseEvent) => void;
  duplicating: boolean;
}) {
  const t = useTranslations();
  const kind = kindOf(skill);
  const KindIcon = KIND_ICON[kind];
  const canUse = skill.deliverable !== false && !skill.disableModelInvocation;
  const href = `/skill?name=${encodeURIComponent(skill.name)}`;

  return (
    <Card
      data-testid="skill-card"
      data-item-name={skill.name}
      data-kind={kind}
      className="group relative flex flex-col gap-3 rounded-2xl border-border/60 bg-card/70 p-4 transition-all duration-150 hover:border-foreground/20 hover:bg-card hover:shadow-xs"
    >
      <div className="flex items-start gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-secondary/60 text-lg shadow-2xs"
          aria-hidden="true"
        >
          {skill.emoji ? <span>{skill.emoji}</span> : <Sparkles className="size-4 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Link
              href={href}
              className="truncate text-sm font-semibold leading-tight hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xs"
            >
              {titleOf(skill)}
            </Link>
            <Badge
              variant="secondary"
              data-testid={`skill-card-kind-${kind}`}
              className="shrink-0 gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
            >
              <KindIcon className="size-2.5 opacity-70" aria-hidden="true" />
              {KIND_LABEL[kind]}
            </Badge>
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            /{skill.name}
            {skill.category ? <span className="font-sans"> · {skill.category}</span> : null}
          </p>
        </div>
      </div>

      <p className="line-clamp-3 min-h-[3.75rem] text-xs leading-relaxed text-muted-foreground">
        {skill.description || t("Skill.noDescription")}
      </p>

      <div className="mt-auto flex items-center gap-1.5 pt-1">
        {!skill.writable && (
          <button
            type="button"
            disabled={duplicating}
            onClick={(e) => onDuplicate(skill, e)}
            title="Make an editable copy"
            aria-label={`Duplicate ${skill.name}`}
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <Copy className="size-3.5" aria-hidden="true" />
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            href={href}
            aria-label={`Open ${skill.name}`}
            className="inline-flex h-7 items-center rounded-full border border-border/60 bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            Open
          </Link>
          <button
            type="button"
            disabled={!canUse}
            onClick={(e) => onUseInChat(skill, e)}
            title={canUse ? `Use /${skill.name} in your next message` : skill.invokableReason || "Not available for chat"}
            className="inline-flex h-7 cursor-pointer items-center rounded-full bg-foreground px-3 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Use
          </button>
        </div>
      </div>
    </Card>
  );
}
