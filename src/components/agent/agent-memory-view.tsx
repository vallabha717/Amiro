"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Brain,
  Check,
  ChevronRight,
  CircleDot,
  Compass,
  Gauge,
  LayoutGrid,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Input } from "ui/input";
import { ScrollArea } from "ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "ui/select";
import { Separator } from "ui/separator";
import { Skeleton } from "ui/skeleton";
import { Textarea } from "ui/textarea";
import { apiJson } from "lib/backend/client";
import { cn, fetcher } from "lib/utils";
import { MemoryMap } from "./memory-map";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export interface AgentMemoryStats {
  total: number;
  active: number;
  superseded: number;
  projectCount: number;
  globalCount: number;
  uniqueTags: number;
  byCategory: Record<string, number>;
}

export interface AgentMemoryScope {
  id: string;
  label: string;
  kind: "global" | "project";
  file: string;
  count: number;
  updatedAt: string | null;
}

export interface AgentMemoryNode {
  id: string;
  content: string;
  category: "fact" | "preference" | "correction" | "entity" | string;
  scope: string;
  scopeLabel: string;
  tags: string[];
  source: string;
  trust: string;
  strength: number;
  confidence: number;
  accessCount: number;
  reinforcements: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMemoryEdge {
  id: string;
  source: string;
  target: string;
  kind: "explicit" | "tag" | "category";
  label?: string;
}

export interface AgentMemoryResponse {
  stats: AgentMemoryStats;
  scopes: AgentMemoryScope[];
  memories: AgentMemoryNode[];
  edges: AgentMemoryEdge[];
  readOnly?: boolean;
}

interface CreateMemoryResponse {
  memory: AgentMemoryNode;
  reinforced: boolean;
}

/**
 * The map is the default: it shows how memories group by category and link by
 * shared tag. The card grid remains one click away for reading at length.
 */
type ViewMode = "cards" | "map";
type RecencyLens = "all" | "7d" | "24h";

/** How many memories the list shows before the reader asks for more. */
export const LIST_PAGE_SIZE = 24;

/* -------------------------------------------------------------------------- */
/*                                  Design                                    */
/* -------------------------------------------------------------------------- */

const CATEGORY_META: Record<string, { label: string; color: string }> = {
  fact: { label: "Fact", color: "#007AFF" },
  preference: { label: "Preference", color: "#A665C9" },
  correction: { label: "Correction", color: "#E9642F" },
  entity: { label: "Entity", color: "#0E9B8B" },
  other: { label: "Other", color: "#8A8F98" },
};

const CLUSTER_ORDER = ["fact", "preference", "entity", "correction", "other"];
// On-disk source: the runtime memory directory (runtime_home/memory, which
// is ~/.jcode/memory on an unconfigured install) served by /api/agent/memory.
const LOCAL_MEMORY_DIR = "~/.jcode/memory";

const RECENCY_LENSES: Array<{ value: RecencyLens; label: string }> = [
  { value: "all", label: "Any time" },
  { value: "7d", label: "Last 7 days" },
  { value: "24h", label: "Last 24 hours" },
];

export function categoryMeta(category: string) {
  return CATEGORY_META[category] ?? CATEGORY_META.other;
}

export function normalizeCategory(category: string): string {
  return CATEGORY_META[category] ? category : "other";
}

function hexToRgba(hex: string, alpha: number) {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const int = Number.parseInt(full, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* -------------------------------------------------------------------------- */
/*                              Small utilities                               */
/* -------------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

function relativeTime(value: string | null | undefined): string {
  const t = parseTime(value);
  if (!t) return "unknown";
  const diff = Date.now() - t;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

function absoluteTime(value: string | null | undefined): string {
  const t = parseTime(value);
  if (!t) return "unknown";
  return new Date(t).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function normalizeConfidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return clamp(value > 1 ? value / 100 : value, 0, 1);
}

/**
 * Show at most `visibleCount` memories so a large graph (hundreds of rows)
 * loads as a short readable page instead of a wall of text. The caller grows
 * `visibleCount` when the reader asks for more.
 */
export function paginateMemories<T>(memories: T[], visibleCount: number): T[] {
  if (!Number.isFinite(visibleCount)) return memories;
  const limit = Math.max(0, Math.floor(visibleCount));
  return memories.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/*                              Filtering helpers                             */
/* -------------------------------------------------------------------------- */

export function withinRecency(memory: AgentMemoryNode, lens: RecencyLens) {
  if (lens === "all") return true;
  const window = lens === "24h" ? 24 * 3600_000 : 7 * 24 * 3600_000;
  const stamp = parseTime(memory.updatedAt) || parseTime(memory.createdAt);
  return Date.now() - stamp <= window;
}

export function matchesSearch(memory: AgentMemoryNode, query: string) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    memory.content.toLowerCase().includes(needle) ||
    memory.category.toLowerCase().includes(needle) ||
    memory.scopeLabel.toLowerCase().includes(needle) ||
    memory.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

/* -------------------------------------------------------------------------- */
/*                             Presentational bits                            */
/* -------------------------------------------------------------------------- */

function FilterPill({
  active,
  onClick,
  children,
  color,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  color?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
        active
          ? "border-transparent text-white shadow-xs"
          : "border-border/70 bg-card/50 text-muted-foreground hover:border-border hover:text-foreground",
      )}
      style={
        active ? { backgroundColor: color ?? "var(--primary)" } : undefined
      }
    >
      {color ? (
        <span
          className="size-1.5 rounded-full"
          style={{ backgroundColor: active ? "rgba(255,255,255,0.9)" : color }}
        />
      ) : null}
      {children}
    </button>
  );
}

function Meter({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: number;
  hint?: string;
  color: string;
}) {
  const pct = Math.round(clamp(value, 0, 1) * 100);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {hint ?? `${pct}%`}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function PanelShell({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card/40 shadow-sm backdrop-blur-sm",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function CategoryTag({ category }: { category: string }) {
  const meta = categoryMeta(category);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        color: meta.color,
        backgroundColor: hexToRgba(meta.color, 0.12),
      }}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*                               Main component                               */
/* -------------------------------------------------------------------------- */

export function AgentMemoryView({ className }: { className?: string }) {
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<AgentMemoryResponse>("/api/agent/memory", fetcher, {
      revalidateOnFocus: false,
      errorRetryCount: 1,
      keepPreviousData: true,
    });

  const scopes = data?.scopes ?? [];
  const allMemories = data?.memories ?? [];
  // Native Amiro memory is retained by the Amiro engine; direct creation/deletion/reinforcement is read-only
  const isReadOnly = data?.readOnly !== false;

  // The map is the default lens; the card grid is a single click away.
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [recency, setRecency] = useState<RecencyLens>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The map keeps its own selection so closing the detail drawer does not
  // clear the node the reader focused there ("Focus selected" stays usable).
  const [mapSelectionId, setMapSelectionId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(LIST_PAGE_SIZE);

  /* --------------------------- detail focus -------------------------------- */

  // The detail panel behaves like a dialog: focus moves into it when a memory
  // is chosen, returns to the element that opened it on close, and Escape
  // (handled globally below) closes it.
  const reduceMotion = useReducedMotion();
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const drawerOpenRef = useRef(false);

  /* ------------------------------ derived data ----------------------------- */

  const filteredMemories = useMemo(
    () =>
      allMemories.filter(
        (memory) =>
          (scopeFilter === "all" || memory.scope === scopeFilter) &&
          (categoryFilter === "all" ||
            normalizeCategory(memory.category) === categoryFilter) &&
          withinRecency(memory, recency) &&
          matchesSearch(memory, search),
      ),
    [allMemories, scopeFilter, categoryFilter, recency, search],
  );

  const visibleMemories = useMemo(
    () => paginateMemories(filteredMemories, visibleCount),
    [filteredMemories, visibleCount],
  );

  // A new lens starts a fresh, short page rather than staying scrolled deep.
  useEffect(() => {
    setVisibleCount(LIST_PAGE_SIZE);
  }, [scopeFilter, categoryFilter, recency, search]);

  const maxStrength = useMemo(
    () => filteredMemories.reduce((max, m) => Math.max(max, m.strength), 1),
    [filteredMemories],
  );

  const edges = useMemo(() => {
    const visible = new Set(filteredMemories.map((m) => m.id));
    const byKey = new Map<string, AgentMemoryEdge>();

    for (const edge of data?.edges ?? []) {
      if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
      const key = `${edge.source}::${edge.target}::${edge.kind}`;
      if (byKey.has(key)) continue;
      byKey.set(key, edge);
    }

    const byTag = new Map<string, string[]>();
    for (const memory of filteredMemories) {
      for (const tag of memory.tags ?? []) {
        const key = tag.toLowerCase();
        const bucket = byTag.get(key);
        if (bucket) bucket.push(memory.id);
        else byTag.set(key, [memory.id]);
      }
    }

    let derived = 0;
    for (const [tag, ids] of byTag) {
      if (ids.length < 2 || derived > 420) continue;
      const anchor = ids[0];
      for (let i = 1; i < ids.length && derived <= 420; i++) {
        const key = `${anchor}::${ids[i]}::tag`;
        const reverse = `${ids[i]}::${anchor}::tag`;
        if (byKey.has(key) || byKey.has(reverse)) continue;
        byKey.set(key, {
          id: `tag:${tag}:${anchor}:${ids[i]}`,
          source: anchor,
          target: ids[i],
          kind: "tag",
          label: tag,
        });
        derived += 1;
      }
    }

    return [...byKey.values()];
  }, [data?.edges, filteredMemories]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const id of filteredMemories.map((m) => m.id)) map.set(id, new Set());
    for (const edge of edges) {
      map.get(edge.source)?.add(edge.target);
      map.get(edge.target)?.add(edge.source);
    }
    return map;
  }, [edges, filteredMemories]);

  // Connection totals come from the same edge list the map draws, so a card
  // never claims a link the map does not show.
  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [edges]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const memory of filteredMemories) {
      const key = normalizeCategory(memory.category);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return CLUSTER_ORDER.filter((key) => counts.has(key)).map((key) => ({
      key,
      count: counts.get(key) ?? 0,
    }));
  }, [filteredMemories]);

  const selectedMemory = useMemo(
    () => allMemories.find((m) => m.id === selectedId) ?? null,
    [allMemories, selectedId],
  );

  const scopePath = useCallback(
    (memory: AgentMemoryNode) => {
      const scope = scopes.find((s) => s.id === memory.scope);
      const file = scope?.file;
      if (file && (file.startsWith("~") || file.startsWith("/"))) return file;
      if (file) return `${LOCAL_MEMORY_DIR}/${file}`;
      return memory.scope === "global"
        ? `${LOCAL_MEMORY_DIR}/global.json`
        : `${LOCAL_MEMORY_DIR}/${memory.scope}.json`;
    },
    [scopes],
  );

  const hasActiveFilters =
    scopeFilter !== "all" ||
    categoryFilter !== "all" ||
    recency !== "all" ||
    search.length > 0;

  const resetFilters = useCallback(() => {
    setScopeFilter("all");
    setCategoryFilter("all");
    setRecency("all");
    setSearch("");
  }, []);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setMapSelectionId(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const open = Boolean(selectedMemory);
    if (open === drawerOpenRef.current) return;
    drawerOpenRef.current = open;
    if (open) {
      previouslyFocusedRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const raf = requestAnimationFrame(() => drawerRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    previouslyFocusedRef.current?.focus?.();
    previouslyFocusedRef.current = null;
  }, [selectedMemory]);

  /* -------------------------------- mutations ------------------------------- */

  const reinforcingRef = useRef<Set<string>>(new Set());
  const [reinforcing, setReinforcing] = useState<string | null>(null);

  const handleReinforce = useCallback(
    async (memory: AgentMemoryNode) => {
      if (isReadOnly) {
        toast.info("Native Amiro memory is read-only.");
        return;
      }
      if (reinforcingRef.current.has(memory.id)) return;
      reinforcingRef.current.add(memory.id);
      setReinforcing(memory.id);
      try {
        await apiJson(
          `/api/agent/memory/${encodeURIComponent(memory.id)}/reinforce`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scope: memory.scope }),
          },
        );
        toast.success("Memory reinforced", {
          description: truncate(memory.content, 72),
        });
        await mutate();
      } catch (err) {
        const isForbidden =
          err instanceof Error && /admin|403|forbidden/i.test(err.message);
        toast.error("Could not reinforce memory", {
          description: isForbidden
            ? "Administrator access required to modify machine memory."
            : err instanceof Error
              ? err.message
              : undefined,
        });
      } finally {
        reinforcingRef.current.delete(memory.id);
        setReinforcing((current) => (current === memory.id ? null : current));
      }
    },
    [isReadOnly, mutate],
  );

  const handleForget = useCallback(
    async (memory: AgentMemoryNode) => {
      if (isReadOnly) {
        toast.info("Native Amiro memory is read-only.");
        return;
      }
      try {
        await apiJson(
          `/api/agent/memory/${encodeURIComponent(memory.id)}?scope=${encodeURIComponent(memory.scope)}`,
          { method: "DELETE" },
        );
        toast.success("Memory forgotten", {
          description: truncate(memory.content, 72),
        });
        setSelectedId((current) => (current === memory.id ? null : current));
        setMapSelectionId((current) =>
          current === memory.id ? null : current,
        );
        await mutate();
      } catch (err) {
        const isForbidden =
          err instanceof Error && /admin|403|forbidden/i.test(err.message);
        toast.error("Could not forget memory", {
          description: isForbidden
            ? "Administrator access required to modify machine memory."
            : err instanceof Error
              ? err.message
              : undefined,
        });
      }
    },
    [isReadOnly, mutate],
  );

  /* ------------------------------- inspector -------------------------------- */

  const inspector = (
    <MemoryInspector
      memory={selectedMemory}
      scopePath={selectedMemory ? scopePath(selectedMemory) : ""}
      reinforcing={reinforcing}
      onReinforce={handleReinforce}
      onForget={handleForget}
      onClose={() => setSelectedId(null)}
      maxStrength={maxStrength}
      isReadOnly={isReadOnly}
      onFocus={handleSelect}
      neighbors={selectedId ? [...(adjacency.get(selectedId) ?? [])] : []}
      memories={allMemories}
    />
  );

  // Derive honest error messages for unauthorized / non-admin users
  const isForbiddenError =
    error &&
    ((error as { status?: number })?.status === 403 ||
      /forbidden|admin/i.test(
        error instanceof Error ? error.message : String(error),
      ));

  const isUnauthorizedError =
    error &&
    ((error as { status?: number })?.status === 401 ||
      /unauthorized|auth/i.test(
        error instanceof Error ? error.message : String(error),
      ));

  const remaining = filteredMemories.length - visibleMemories.length;

  return (
    <div className={cn("min-h-screen w-full bg-background", className)}>
      <div className="pointer-events-none fixed inset-0 -z-10 opacity-[0.55]">
        <div className="absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,color-mix(in_oklab,var(--primary)_14%,transparent),transparent_70%)]" />
      </div>

      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-3.5 md:px-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="-ml-2 gap-1.5 text-muted-foreground"
              >
                <Link href="/agent">
                  <ArrowLeft className="size-4" />
                  Back to Agent
                </Link>
              </Button>
              <Separator orientation="vertical" className="h-6" />
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 items-center justify-center rounded-xl border border-border/70 bg-card/60 shadow-xs">
                  <Brain className="size-4.5 text-primary" />
                </span>
                <div className="leading-tight">
                  <h1 className="font-brand text-xl font-semibold tracking-tight">
                    Memory
                  </h1>
                  <p className="text-[11px] text-muted-foreground">
                    What Amiro remembers · From runtime memory
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <ViewSwitcher value={viewMode} onChange={setViewMode} />
              {!isReadOnly ? (
                <Button
                  data-testid="memory-create-button"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setCreateOpen(true)}
                  aria-label="Remember new fact"
                >
                  <Plus className="size-4" />
                  Remember new fact
                </Button>
              ) : (
                <Badge
                  variant="outline"
                  className="hidden gap-1.5 border-border/70 bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground sm:inline-flex"
                >
                  <ShieldCheck className="size-3.5 text-primary" />
                  Read-only native memory
                </Badge>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                data-testid="memory-search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search memories, tags, sessions"
                aria-label="Search memories"
                className="h-9 w-full rounded-full pl-8 text-sm"
              />
              {search ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>

            <Select value={scopeFilter} onValueChange={setScopeFilter}>
              <SelectTrigger
                size="sm"
                aria-label="Filter by scope"
                className="min-w-[150px] rounded-full"
              >
                <Compass className="size-3.5 text-muted-foreground" />
                <SelectValue placeholder="All scopes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All scopes</SelectItem>
                <SelectItem value="global">Global</SelectItem>
                {scopes
                  .filter((scope) => scope.kind !== "global")
                  .map((scope) => (
                    <SelectItem key={scope.id} value={scope.id}>
                      {scope.label || scope.id}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>

            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger
                size="sm"
                aria-label="Filter by category"
                className="min-w-[140px] rounded-full"
              >
                <Tag className="size-3.5 text-muted-foreground" />
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {CLUSTER_ORDER.map((category) => (
                  <SelectItem key={category} value={category}>
                    {categoryMeta(category).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={recency}
              onValueChange={(value) => setRecency(value as RecencyLens)}
            >
              <SelectTrigger
                size="sm"
                aria-label="Filter by recency"
                className="min-w-[140px] rounded-full"
              >
                <SelectValue placeholder="Any time" />
              </SelectTrigger>
              <SelectContent>
                {RECENCY_LENSES.map((lens) => (
                  <SelectItem key={lens.value} value={lens.value}>
                    {lens.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {hasActiveFilters ? (
              <button
                type="button"
                aria-label="Reset all search and filter options"
                onClick={resetFilters}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
              >
                <RefreshCw className="size-3" />
                Reset
              </button>
            ) : null}

            <span
              className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              {isValidating && !isLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : null}
              {filteredMemories.length} of {allMemories.length} memories
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1200px] px-4 py-5 md:px-7">
        {error ? (
          <EmptyState
            icon={<Brain className="size-5" />}
            title={
              isForbiddenError
                ? "Administrator Access Required"
                : isUnauthorizedError
                  ? "Authentication Required"
                  : "Memory graph unavailable"
            }
            detail={
              isForbiddenError
                ? "Machine memory graph inspection is restricted to administrators. Non-admin users cannot access native memory."
                : isUnauthorizedError
                  ? "Please sign in to view the agent memory graph."
                  : error instanceof Error
                    ? error.message
                    : "The adapter did not return a memory graph."
            }
            action={
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => mutate()}
                aria-label="Try loading memory graph again"
              >
                <RefreshCw className="size-4" />
                Try again
              </Button>
            }
          />
        ) : isLoading && !data ? (
          <MemoryListSkeleton />
        ) : viewMode === "map" ? (
          filteredMemories.length === 0 ? (
            <EmptyState
              icon={<Compass className="size-5" />}
              title={
                hasActiveFilters
                  ? "No memories match this map"
                  : "No memories to map yet"
              }
              detail={
                hasActiveFilters
                  ? "Try clearing the search or filters to bring memories back into view."
                  : "Memories appear here grouped by category as Amiro remembers them."
              }
              action={
                hasActiveFilters ? (
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={resetFilters}
                  >
                    <RefreshCw className="size-4" />
                    Clear search and filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-3">
              <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="max-w-xl">
                  <h2 className="font-brand text-lg tracking-tight">
                    Memory map
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Explore what Amiro remembers. Pick a memory to read it, or a
                    category to explore that part of the map.
                  </p>
                </div>
                <div className="hidden flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[11px] text-muted-foreground sm:flex sm:justify-end">
                  {categoryCounts.map(({ key, count }) => (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1.5"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: categoryMeta(key).color }}
                      />
                      {categoryMeta(key).label}
                      <span className="tabular-nums">{count}</span>
                    </span>
                  ))}
                </div>
              </header>
              <MemoryMap
                memories={filteredMemories}
                edges={edges}
                selectedId={mapSelectionId}
                onSelect={handleSelect}
              />
            </div>
          )
        ) : (
          <MemoryList
            memories={visibleMemories}
            selectedId={selectedId}
            onSelect={handleSelect}
            remaining={remaining}
            connectionCounts={connectionCounts}
            onLoadMore={() =>
              setVisibleCount((count) => count + LIST_PAGE_SIZE)
            }
          />
        )}
      </main>

      <AnimatePresence>
        {selectedMemory ? (
          <motion.aside
            key="memory-drawer"
            initial={reduceMotion ? { opacity: 0 } : { x: 40, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { x: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { x: 40, opacity: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : { duration: 0.22, ease: [0.23, 1, 0.32, 1] }
            }
            className="fixed inset-y-0 right-0 z-40 w-full max-w-[440px] p-3"
            role="dialog"
            aria-label="Memory detail"
          >
            <div
              ref={drawerRef}
              tabIndex={-1}
              className="h-full overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-2xl backdrop-blur-xl outline-none"
            >
              {inspector}
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>

      {!isReadOnly && (
        <CreateMemoryDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          scopes={scopes}
          onCreated={async (memory, reinforced) => {
            toast.success(reinforced ? "Memory reinforced" : "Memory saved", {
              description: truncate(memory.content, 72),
            });
            setScopeFilter("all");
            setCategoryFilter("all");
            setRecency("all");
            setSearch("");
            await mutate();
            handleSelect(memory.id);
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              View switcher                                 */
/* -------------------------------------------------------------------------- */

function ViewSwitcher({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  const options: Array<{
    id: ViewMode;
    label: string;
    icon: ReactNode;
  }> = [
    { id: "cards", label: "Cards", icon: <LayoutGrid className="size-3.5" /> },
    { id: "map", label: "Map", icon: <Compass className="size-3.5" /> },
  ];
  return (
    <div
      role="group"
      aria-label="View mode"
      className="flex items-center gap-0.5 rounded-full border border-border/70 bg-card/60 p-0.5 shadow-xs"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium transition duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 sm:px-3",
            value === option.id
              ? "bg-primary text-primary-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                               Memory list                                  */
/* -------------------------------------------------------------------------- */

function MemoryListSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      aria-hidden="true"
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-[196px] w-full rounded-2xl" />
      ))}
    </div>
  );
}

function MemoryList({
  memories,
  selectedId,
  onSelect,
  remaining,
  connectionCounts,
  onLoadMore,
}: {
  memories: AgentMemoryNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  remaining: number;
  connectionCounts: Map<string, number>;
  onLoadMore: () => void;
}) {
  if (memories.length === 0) {
    return (
      <EmptyState
        icon={<Brain className="size-5" />}
        title="No memories match this view"
        detail="Try clearing the search or filters to bring memories back."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ul
        data-testid="memory-list"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {memories.map((memory) => {
          const meta = categoryMeta(memory.category);
          const selected = selectedId === memory.id;
          const connections = connectionCounts.get(memory.id) ?? 0;
          const scopeLabel = memory.scopeLabel || memory.scope;
          return (
            <li key={memory.id} className="min-w-0">
              <button
                type="button"
                data-testid="memory-card"
                aria-label={`${meta.label} memory in ${scopeLabel}: ${memory.content}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(memory.id)}
                className={cn(
                  "group flex h-full w-full flex-col rounded-2xl border border-border/70 bg-card/50 p-4 text-left shadow-xs transition-colors duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none hover:border-border hover:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/40 sm:p-5",
                  selected && "border-primary/50 ring-2 ring-ring/40",
                  !memory.active && "border-dashed bg-muted/20",
                )}
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: meta.color }}
                    />
                    {meta.label}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {connections > 0 ? (
                      <span
                        title={`${connections} connection${connections === 1 ? "" : "s"} from runtime links, shared tags, or category grouping`}
                        className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground"
                      >
                        <Link2 aria-hidden="true" className="size-3" />
                        <span className="tabular-nums">{connections}</span>
                        <span className="sr-only"> connections</span>
                      </span>
                    ) : null}
                    {!memory.active ? (
                      <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
                        Superseded
                      </span>
                    ) : null}
                  </span>
                </span>

                <span className="mt-2.5 mb-3 line-clamp-5 block text-[15px] leading-[1.55] text-foreground">
                  {memory.content}
                </span>

                {memory.tags.length ? (
                  <span className="mb-4 flex flex-wrap gap-1.5">
                    {memory.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="max-w-full truncate rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                    {memory.tags.length > 3 ? (
                      <span
                        title={memory.tags.slice(3).join(", ")}
                        className="inline-flex items-center rounded-md px-1 py-0.5 text-[11px] text-muted-foreground"
                      >
                        +{memory.tags.length - 3}
                      </span>
                    ) : null}
                  </span>
                ) : null}

                <span className="mt-auto flex items-baseline justify-between gap-3 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
                  <span className="truncate">{scopeLabel}</span>
                  <span className="shrink-0">
                    {relativeTime(memory.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {remaining > 0 ? (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="memory-load-more"
            onClick={onLoadMore}
          >
            Show {Math.min(remaining, LIST_PAGE_SIZE)} more
            <span className="text-muted-foreground">({remaining} left)</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Detail inspector                              */
/* -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- */

function MemoryInspector({
  memory,
  scopePath,
  reinforcing,
  onReinforce,
  onForget,
  onClose,
  onFocus,
  neighbors,
  memories,
  maxStrength,
  isReadOnly,
}: {
  memory: AgentMemoryNode | null;
  scopePath: string;
  reinforcing: string | null;
  onReinforce: (memory: AgentMemoryNode) => void;
  onForget: (memory: AgentMemoryNode) => void;
  onClose: () => void;
  onFocus: (id: string) => void;
  neighbors: string[];
  memories: AgentMemoryNode[];
  maxStrength: number;
  isReadOnly: boolean;
}) {
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(() => {
    setConfirmForget(false);
  }, [memory?.id]);

  if (!memory) {
    return (
      <PanelShell title="Memory details" className="h-full">
        <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-card/50">
            <CircleDot className="size-5 text-muted-foreground" />
          </span>
          <p className="font-brand text-base">Nothing selected</p>
          <p className="max-w-[240px] text-sm text-muted-foreground">
            Choose any memory to inspect its content, provenance, and links.
          </p>
        </div>
      </PanelShell>
    );
  }

  const meta = categoryMeta(memory.category);
  const confidence = normalizeConfidence(memory.confidence);
  const trustNumeric = /^\d+(\.\d+)?$/.test(memory.trust);
  const trustValue = trustNumeric
    ? normalizeConfidence(Number(memory.trust))
    : 0;
  const neighborMemories = neighbors
    .map((id) => memories.find((m) => m.id === id))
    .filter((m): m is AgentMemoryNode => Boolean(m))
    .slice(0, 6);

  return (
    <PanelShell
      title="Memory details"
      className="h-full"
      action={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Close details"
        >
          <X className="size-4" />
        </Button>
      }
    >
      <ScrollArea className="max-h-[calc(100vh-190px)]">
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <CategoryTag category={memory.category} />
            <Badge variant="outline" className="rounded-full font-normal">
              {memory.scopeLabel || memory.scope}
            </Badge>
            {!memory.active ? (
              <Badge variant="secondary" className="rounded-full font-normal">
                superseded
              </Badge>
            ) : null}
          </div>

          <p className="text-[15px] leading-relaxed text-foreground">
            {memory.content}
          </p>

          {memory.tags.length ? (
            <div className="flex flex-wrap gap-1.5">
              {memory.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card/50 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  <Tag className="size-3" />
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          <dl className="grid grid-cols-1 gap-2.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Created</dt>
              <dd className="font-mono text-foreground">
                {absoluteTime(memory.createdAt)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Updated</dt>
              <dd className="font-mono text-foreground">
                {relativeTime(memory.updatedAt)}
              </dd>
            </div>
          </dl>

          {neighborMemories.length ? (
            <div className="space-y-2">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                Linked memories
              </span>
              <div className="space-y-1.5">
                {neighborMemories.map((neighbor) => (
                  <button
                    key={neighbor.id}
                    type="button"
                    aria-label={`Focus linked memory: ${truncate(neighbor.content, 48)}`}
                    onClick={() => onFocus(neighbor.id)}
                    className="flex w-full items-center gap-2 rounded-lg border border-border/50 bg-card/30 px-2.5 py-2 text-left text-xs text-muted-foreground transition hover:border-border hover:text-foreground"
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: categoryMeta(neighbor.category).color,
                      }}
                    />
                    <span className="truncate">
                      {truncate(neighbor.content.replace(/\s+/g, " "), 64)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <details
            data-testid="memory-technical-details"
            className="group rounded-xl border border-border/60 bg-muted/20"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40">
              <span className="inline-flex items-center gap-1.5">
                <Gauge className="size-3.5" />
                Technical details
              </span>
              <ChevronRight className="size-3.5 transition group-open:rotate-90" />
            </summary>
            <div className="space-y-4 border-t border-border/60 p-3">
              <div className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground">
                <CircleDot className="size-3.5 shrink-0" />
                <span className="sr-only">Stored in </span>
                <span className="truncate">{scopePath}</span>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                {trustNumeric ? (
                  <Meter
                    label="Trust"
                    value={trustValue}
                    color={meta.color}
                    hint={`${Math.round(trustValue * 100)}%`}
                  />
                ) : (
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                      Trust
                    </span>
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <ShieldCheck
                        className="size-3.5"
                        style={{ color: meta.color }}
                      />
                      {memory.trust || "unknown"}
                    </div>
                  </div>
                )}
                <Meter
                  label="Confidence"
                  value={confidence}
                  color="#0E9B8B"
                  hint={`${Math.round(confidence * 100)}%`}
                />
                <Meter
                  label="Strength"
                  value={clamp(
                    memory.strength / Math.max(1, maxStrength),
                    0,
                    1,
                  )}
                  color={meta.color}
                  hint={memory.strength.toFixed(2)}
                />
                <div className="space-y-1.5">
                  <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                    Reinforcements
                  </span>
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Sparkles
                      className="size-3.5"
                      style={{ color: meta.color }}
                    />
                    {memory.reinforcements}
                    <span className="text-xs text-muted-foreground">
                      · {memory.accessCount} recalls
                    </span>
                  </div>
                </div>
              </div>

              <dl className="grid grid-cols-1 gap-2.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Source session</dt>
                  <dd className="max-w-[200px] truncate font-mono text-foreground">
                    {memory.source || "manual"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Memory id</dt>
                  <dd className="max-w-[200px] truncate font-mono text-foreground">
                    {memory.id}
                  </dd>
                </div>
              </dl>
            </div>
          </details>

          <Separator />

          <div className="space-y-2">
            {isReadOnly ? (
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5 text-xs leading-relaxed text-muted-foreground">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <ShieldCheck className="size-3.5 text-primary" />
                  Native Amiro memory retained
                </div>
                <p className="mt-1">
                  Memories are stored directly in Amiro&apos;s native runtime
                  memory graph and updated natively by Amiro during chat
                  sessions. Direct mutation controls are disabled because Amiro
                  retains memories natively without running a secondary engine.
                </p>
              </div>
            ) : (
              <>
                <Button
                  data-testid="memory-reinforce-button"
                  type="button"
                  className="w-full gap-1.5"
                  onClick={() => onReinforce(memory)}
                  disabled={reinforcing === memory.id}
                >
                  {reinforcing === memory.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  Reinforce (+1 strength)
                </Button>

                {confirmForget ? (
                  <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-2">
                    <span className="pl-1 text-xs text-muted-foreground">
                      Forget this memory?
                    </span>
                    <div className="ml-auto flex gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmForget(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        data-testid="memory-forget-button"
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => onForget(memory)}
                      >
                        Forget
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    data-testid="memory-forget-button"
                    type="button"
                    variant="ghost"
                    className="w-full justify-start gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmForget(true)}
                  >
                    <Trash2 className="size-4" />
                    Forget memory
                  </Button>
                )}
              </>
            )}

            <Button
              asChild
              variant="outline"
              className="w-full justify-start gap-1.5"
            >
              <Link
                href={`/?prompt=${encodeURIComponent(`Tell me more about this memory: ${memory.content}`)}`}
              >
                <Send className="size-4" />
                Ask Agent about this
              </Link>
            </Button>
          </div>
        </div>
      </ScrollArea>
    </PanelShell>
  );
}

/* -------------------------------------------------------------------------- */
/*                             Create memory modal                            */
/* -------------------------------------------------------------------------- */

function CreateMemoryDialog({
  open,
  onOpenChange,
  scopes,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopes: AgentMemoryScope[];
  onCreated: (
    memory: AgentMemoryNode,
    reinforced: boolean,
  ) => void | Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("fact");
  const [scopeId, setScopeId] = useState("global");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  const projectScopes = scopes.filter((scope) => scope.kind !== "global");

  useEffect(() => {
    if (!open) return;
    const preferred = projectScopes[0]?.id ?? "global";
    setScopeId(preferred);
  }, [open, projectScopes]);

  useEffect(() => {
    if (!open) {
      setContent("");
      setCategory("fact");
      setTags("");
      setSaving(false);
    }
  }, [open]);

  const parsedTags = useMemo(
    () =>
      tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12),
    [tags],
  );

  const submit = async () => {
    const trimmed = content.trim();
    if (!trimmed) {
      toast.error("Add something to remember first");
      return;
    }
    setSaving(true);
    try {
      const result = await apiJson<CreateMemoryResponse>("/api/agent/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: trimmed,
          category,
          scope: scopeId,
          tags: parsedTags,
        }),
      });
      await onCreated(result.memory, result.reinforced);
      onOpenChange(false);
    } catch (err) {
      toast.error("Could not save memory", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="memory-create-modal"
        className="max-w-xl gap-5"
      >
        <DialogHeader>
          <DialogTitle className="font-brand text-xl tracking-tight">
            Remember a new fact
          </DialogTitle>
          <DialogDescription>
            Writes into Amiro&apos;s memory graph. Matching content reinforces
            an existing memory instead of duplicating it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="memory-content"
              className="text-xs font-medium text-muted-foreground"
            >
              What should the agent remember?
            </label>
            <Textarea
              id="memory-content"
              data-testid="memory-content-input"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="This project deploys through the Go sidecar on port 8080."
              rows={4}
              className="min-h-28 resize-y"
            />
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground">
              Category
            </span>
            <div className="flex flex-wrap gap-1.5">
              {CLUSTER_ORDER.filter((c) => c !== "other").map((option) => (
                <FilterPill
                  key={option}
                  active={category === option}
                  onClick={() => setCategory(option)}
                  color={categoryMeta(option).color}
                >
                  {categoryMeta(option).label}
                </FilterPill>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground">
              Scope
            </span>
            <div className="flex flex-wrap gap-1.5">
              {projectScopes.map((scope) => (
                <FilterPill
                  key={scope.id}
                  active={scopeId === scope.id}
                  onClick={() => setScopeId(scope.id)}
                  color="#007AFF"
                >
                  {scope.label || "This project"} (project)
                </FilterPill>
              ))}
              <FilterPill
                active={scopeId === "global"}
                onClick={() => setScopeId("global")}
                color="#A665C9"
              >
                Global
              </FilterPill>
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="memory-tags"
              className="text-xs font-medium text-muted-foreground"
            >
              Tags (comma separated)
            </label>
            <Input
              id="memory-tags"
              data-testid="memory-tags-input"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="deploy, sidecar, ports"
            />
            {parsedTags.length ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {parsedTags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="rounded-full font-normal text-muted-foreground"
                  >
                    <Check className="size-3" />
                    {tag}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="memory-submit-button"
            onClick={submit}
            disabled={saving}
            className="gap-1.5"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Brain className="size-4" />
            )}
            Save memory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Empty state                                 */
/* -------------------------------------------------------------------------- */

function EmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border/60 bg-card/40 px-6 py-20 text-center"
    >
      <span className="flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-card/60">
        {icon}
      </span>
      <h2 className="font-brand text-lg tracking-tight">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>
      {action}
    </div>
  );
}

export default AgentMemoryView;
