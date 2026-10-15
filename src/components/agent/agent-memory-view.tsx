"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Brain,
  Check,
  CircleDot,
  Columns2,
  Compass,
  Crosshair,
  Gauge,
  LayoutGrid,
  Loader2,
  Maximize2,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
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
import { Textarea } from "ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { apiJson } from "lib/backend/client";
import { cn, fetcher } from "lib/utils";

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

type ViewMode = "constellation" | "cards" | "split";
type RecencyLens = "all" | "7d" | "24h";

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
const LOCAL_MEMORY_DIR = "~/.jcode/memory";

function categoryMeta(category: string) {
  return CATEGORY_META[category] ?? CATEGORY_META.other;
}

function normalizeCategory(category: string): string {
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

function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rand01(seed: number, salt: number): number {
  let x = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x / 4294967296;
}

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

/* -------------------------------------------------------------------------- */
/*                            Constellation layout                            */
/* -------------------------------------------------------------------------- */

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function goldenPoint(index: number, total: number): Vec3 {
  const y = 1 - ((index + 0.5) * 2) / total;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * index;
  return { x: Math.cos(theta) * radius, y, z: Math.sin(theta) * radius };
}

const CLUSTER_CENTERS: Vec3[] = CLUSTER_ORDER.map((_, index) => {
  const p = goldenPoint(index, CLUSTER_ORDER.length);
  const pull = 0.62;
  return { x: p.x * pull, y: p.y * pull, z: p.z * pull };
});

interface LayoutNode extends AgentMemoryNode {
  pos: Vec3;
  cluster: string;
  color: string;
  /** Strength relative to the strongest memory in view, 0..1. */
  intensity: number;
}

function layoutNode(memory: AgentMemoryNode, maxStrength: number): LayoutNode {
  const cluster = normalizeCategory(memory.category);
  const clusterIndex = Math.max(0, CLUSTER_ORDER.indexOf(cluster));
  const center = CLUSTER_CENTERS[clusterIndex];
  const seed = hashString(memory.id);
  const azimuth = rand01(seed, 1) * Math.PI * 2;
  const cosElevation = rand01(seed, 2) * 2 - 1;
  const shell = 0.16 + rand01(seed, 3) * 0.18;
  const ring = Math.sqrt(Math.max(0, 1 - cosElevation * cosElevation));
  return {
    ...memory,
    cluster,
    color: categoryMeta(memory.category).color,
    intensity: clamp(memory.strength / Math.max(1, maxStrength), 0, 1),
    pos: {
      x: center.x + Math.cos(azimuth) * ring * shell,
      y: center.y + cosElevation * shell,
      z: center.z + Math.sin(azimuth) * ring * shell,
    },
  };
}

interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
}

interface CamTarget {
  yaw: number;
  pitch: number;
  zoom: number;
  at: number;
}

const CAM_DISTANCE = 3.15;
const BASE_SCALE = 0.34;

function rotatePoint(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = p.y * cp - z1 * sp;
  const z2 = p.y * sp + z1 * cp;
  return { x: x1, y: y2, z: z2 };
}

interface ProjectedPoint {
  sx: number;
  sy: number;
  depth: number;
  persp: number;
}

function projectPoint(
  pos: Vec3,
  cam: Camera,
  width: number,
  height: number,
): ProjectedPoint {
  const r = rotatePoint(pos, cam.yaw, cam.pitch);
  const depth = CAM_DISTANCE - r.z;
  const persp = CAM_DISTANCE / depth;
  const scale = Math.min(width, height) * BASE_SCALE * cam.zoom;
  return {
    sx: width / 2 + r.x * scale * persp,
    sy: height / 2 - r.y * scale * persp,
    depth,
    persp,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Canvas scene type                             */
/* -------------------------------------------------------------------------- */

interface Scene {
  width: number;
  height: number;
  cam: Camera;
  camTarget: CamTarget | null;
  nodes: LayoutNode[];
  edges: AgentMemoryEdge[];
  adjacency: Map<string, Set<string>>;
  clusterCounts: number[];
  selectedId: string | null;
  hoverId: string | null;
  dragging: boolean;
  lastInteract: number;
  isDark: boolean;
  reduceMotion: boolean;
  pulse: { id: string; at: number } | null;
  projected: Array<{
    id: string;
    sx: number;
    sy: number;
    radius: number;
    depth: number;
  }>;
}

/* -------------------------------------------------------------------------- */
/*                              Filtering helpers                             */
/* -------------------------------------------------------------------------- */

function withinRecency(memory: AgentMemoryNode, lens: RecencyLens) {
  if (lens === "all") return true;
  const window = lens === "24h" ? 24 * 3600_000 : 7 * 24 * 3600_000;
  const stamp = parseTime(memory.updatedAt) || parseTime(memory.createdAt);
  return Date.now() - stamp <= window;
}

function matchesSearch(memory: AgentMemoryNode, query: string) {
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

function StatPill({
  icon,
  label,
  tone,
}: {
  icon?: ReactNode;
  label: string;
  tone?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur-sm"
      style={
        tone ? { color: tone, borderColor: hexToRgba(tone, 0.35) } : undefined
      }
    >
      {icon}
      {label}
    </span>
  );
}

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

  const stats = data?.stats;
  const scopes = data?.scopes ?? [];
  const allMemories = data?.memories ?? [];
  // Native Jcode memory is retained by the Jcode engine; direct creation/deletion/reinforcement is read-only
  const isReadOnly = data?.readOnly !== false;

  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [recency, setRecency] = useState<RecencyLens>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      setViewMode("cards");
    }
  }, []);

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

  const maxStrength = useMemo(
    () => filteredMemories.reduce((max, m) => Math.max(max, m.strength), 1),
    [filteredMemories],
  );

  const layoutNodes = useMemo(
    () => filteredMemories.map((memory) => layoutNode(memory, maxStrength)),
    [filteredMemories, maxStrength],
  );

  const clusterCounts = useMemo(() => {
    const counts = CLUSTER_ORDER.map(() => 0);
    for (const node of layoutNodes) {
      const index = CLUSTER_ORDER.indexOf(node.cluster);
      if (index >= 0) counts[index] += 1;
    }
    return counts;
  }, [layoutNodes]);

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

  /* ------------------------------ canvas refs ------------------------------ */

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);

  const sceneRef = useRef<Scene>({
    width: 0,
    height: 0,
    cam: { yaw: 0.6, pitch: 0.32, zoom: 1 },
    camTarget: null,
    nodes: [],
    edges: [],
    adjacency: new Map(),
    clusterCounts: CLUSTER_ORDER.map(() => 0),
    selectedId: null,
    hoverId: null,
    dragging: false,
    lastInteract: 0,
    isDark: false,
    reduceMotion: false,
    pulse: null,
    projected: [],
  });

  const nodesRef = useRef<LayoutNode[]>([]);
  nodesRef.current = layoutNodes;

  useEffect(() => {
    const scene = sceneRef.current;
    scene.nodes = layoutNodes;
    scene.edges = edges;
    scene.adjacency = adjacency;
    scene.clusterCounts = clusterCounts;
    scene.selectedId = selectedId;
  }, [layoutNodes, edges, adjacency, clusterCounts, selectedId]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      sceneRef.current.reduceMotion = media.matches;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      sceneRef.current.isDark = root.classList.contains("dark");
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  /* --------------------------- camera interactions -------------------------- */

  const zoomBy = useCallback((factor: number) => {
    const scene = sceneRef.current;
    scene.camTarget = null;
    scene.cam.zoom = clamp(scene.cam.zoom * factor, 0.45, 3.4);
    scene.lastInteract = performance.now();
  }, []);

  const resetCamera = useCallback(() => {
    const scene = sceneRef.current;
    scene.camTarget = { yaw: 0.6, pitch: 0.32, zoom: 1, at: performance.now() };
    scene.lastInteract = performance.now();
  }, []);

  const flyTo = useCallback((id: string) => {
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node) return;
    const { x, y, z } = node.pos;
    const scene = sceneRef.current;
    scene.camTarget = {
      yaw: Math.atan2(-x, z),
      pitch: Math.atan2(y, Math.hypot(x, z)),
      zoom: Math.max(scene.cam.zoom, 1.35),
      at: performance.now(),
    };
    scene.pulse = { id, at: performance.now() };
    scene.lastInteract = performance.now();
  }, []);

  useEffect(() => {
    if (!pendingFocusId) return;
    if (!layoutNodes.some((n) => n.id === pendingFocusId)) return;
    flyTo(pendingFocusId);
    setPendingFocusId(null);
  }, [pendingFocusId, layoutNodes, flyTo]);

  /* --------------------------------- scene --------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let disposed = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sceneRef.current.width = width;
      sceneRef.current.height = height;
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const hitTest = (mx: number, my: number) => {
      const projected = sceneRef.current.projected;
      let best: { id: string; depth: number } | null = null;
      for (const p of projected) {
        const dist = Math.hypot(p.sx - mx, p.sy - my);
        if (dist > p.radius + 8) continue;
        if (!best || p.depth < best.depth) best = { id: p.id, depth: p.depth };
      }
      return best?.id ?? null;
    };

    const onPointerDown = (event: PointerEvent) => {
      const scene = sceneRef.current;
      canvas.setPointerCapture(event.pointerId);
      dragRef.current = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
        pointerId: event.pointerId,
      };
      scene.dragging = true;
      scene.lastInteract = performance.now();
    };

    const onPointerMove = (event: PointerEvent) => {
      const scene = sceneRef.current;
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      if (scene.dragging && dragRef.current) {
        const dx = event.clientX - dragRef.current.x;
        const dy = event.clientY - dragRef.current.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) dragRef.current.moved = true;
        scene.cam.yaw += dx * 0.0075;
        scene.cam.pitch = clamp(scene.cam.pitch + dy * 0.0075, -1.35, 1.35);
        scene.camTarget = null;
        scene.lastInteract = performance.now();
        dragRef.current.x = event.clientX;
        dragRef.current.y = event.clientY;
      } else {
        scene.hoverId = hitTest(mx, my);
        canvas.style.cursor = scene.hoverId ? "pointer" : "grab";
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const scene = sceneRef.current;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const wasDrag = dragRef.current?.moved ?? false;
      dragRef.current = null;
      scene.dragging = false;
      scene.lastInteract = performance.now();
      canvas.style.cursor = "grab";
      if (!wasDrag) {
        const hit = hitTest(mx, my);
        setSelectedId(hit);
        scene.selectedId = hit;
      }
    };

    const onPointerLeave = () => {
      sceneRef.current.hoverId = null;
      if (!sceneRef.current.dragging) canvas.style.cursor = "grab";
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const scene = sceneRef.current;
      scene.camTarget = null;
      scene.cam.zoom = clamp(
        scene.cam.zoom * Math.exp(-event.deltaY * 0.0012),
        0.45,
        3.4,
      );
      scene.lastInteract = performance.now();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = "grab";

    const drawScene = (now: number) => {
      const scene = sceneRef.current;
      const { width, height, cam } = scene;
      ctx.clearRect(0, 0, width, height);
      if (width < 2 || height < 2) return;

      const dark = scene.isDark;
      const textColor = dark ? "rgba(240,240,246,0.95)" : "rgba(24,22,32,0.95)";
      const labelBg = dark ? "rgba(14,14,18,0.92)" : "rgba(255,255,255,0.96)";
      const labelBorder = dark
        ? "rgba(255,255,255,0.16)"
        : "rgba(20,18,30,0.12)";
      const edgeBase = dark ? "rgba(255,255,255,0.5)" : "rgba(30,26,44,0.45)";

      const egoId = scene.selectedId ?? scene.hoverId ?? null;
      const neighbors = egoId ? scene.adjacency.get(egoId) : undefined;

      const projected = new Map<
        string,
        {
          sx: number;
          sy: number;
          depth: number;
          persp: number;
          node: LayoutNode;
        }
      >();
      for (const node of scene.nodes) {
        const p = projectPoint(node.pos, cam, width, height);
        projected.set(node.id, { ...p, node });
      }

      /* cluster labels, behind everything */
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      for (let i = 0; i < CLUSTER_ORDER.length; i++) {
        if (!scene.clusterCounts[i]) continue;
        const p = projectPoint(CLUSTER_CENTERS[i], cam, width, height);
        ctx.globalAlpha = clamp(0.1 + (p.persp - 0.7) * 0.22, 0.06, 0.32);
        ctx.fillStyle = categoryMeta(CLUSTER_ORDER[i]).color;
        ctx.fillText(
          `${CLUSTER_ORDER[i]} · ${scene.clusterCounts[i]}`,
          p.sx,
          p.sy,
        );
      }
      ctx.globalAlpha = 1;

      /* edges */
      ctx.lineCap = "round";
      for (const edge of scene.edges) {
        const a = projected.get(edge.source);
        const b = projected.get(edge.target);
        if (!a || !b) continue;
        const dimmed = egoId && edge.source !== egoId && edge.target !== egoId;
        const strength =
          (edge.kind === "explicit" ? 0.5 : edge.kind === "tag" ? 0.34 : 0.22) *
          (1 / Math.max(1.6, (a.depth + b.depth) / 2 - 2.05));
        const alpha = dimmed ? strength * 0.16 : strength;
        ctx.strokeStyle = edgeBase.replace(
          /[\d.]+\)$/,
          `${clamp(alpha, 0.02, 0.6)})`,
        );
        ctx.lineWidth = edge.kind === "explicit" ? 1.15 : 0.8;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }

      /* nodes, far to near */
      const ordered = [...projected.values()].sort((x, y) => y.depth - x.depth);
      const hitList: Scene["projected"] = [];

      for (const entry of ordered) {
        const { node } = entry;
        const isEgo = egoId === node.id;
        const isNeighbor = neighbors?.has(node.id) ?? false;
        const dimmed = egoId ? !isEgo && !isNeighbor : false;
        const alpha = dimmed ? 0.18 : 1;
        const base = 3.1 + node.intensity * 2.4;
        const radius = base * entry.persp * (0.9 + 0.12 * cam.zoom);
        const fresh =
          now - parseTime(node.createdAt) < 24 * 3600_000 ||
          now - parseTime(node.updatedAt) < 2 * 3600_000;

        hitList.push({
          id: node.id,
          sx: entry.sx,
          sy: entry.sy,
          radius,
          depth: entry.depth,
        });

        /* halo for fresh / high-strength / active nodes */
        const haloStrength = Math.max(
          node.intensity,
          fresh ? 0.7 : 0,
          isEgo ? 1 : 0,
        );
        if (haloStrength > 0.3) {
          const haloRadius = radius + 6 + haloStrength * 14;
          const gradient = ctx.createRadialGradient(
            entry.sx,
            entry.sy,
            radius * 0.4,
            entry.sx,
            entry.sy,
            haloRadius,
          );
          gradient.addColorStop(
            0,
            hexToRgba(node.color, 0.34 * alpha * haloStrength + 0.05),
          );
          gradient.addColorStop(1, hexToRgba(node.color, 0));
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(entry.sx, entry.sy, haloRadius, 0, Math.PI * 2);
          ctx.fill();
        }

        /* core */
        ctx.globalAlpha = alpha;
        ctx.fillStyle = node.active ? node.color : hexToRgba(node.color, 0.5);
        ctx.beginPath();
        ctx.arc(entry.sx, entry.sy, radius, 0, Math.PI * 2);
        ctx.fill();

        if (node.active) {
          ctx.strokeStyle = dark
            ? "rgba(255,255,255,0.22)"
            : "rgba(255,255,255,0.75)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        /* selection ring */
        if (isEgo) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = textColor;
          ctx.lineWidth = 1.4;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.arc(entry.sx, entry.sy, radius + 5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (isNeighbor) {
          ctx.globalAlpha = 0.75;
          ctx.strokeStyle = hexToRgba(node.color, 0.85);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(entry.sx, entry.sy, radius + 3, 0, Math.PI * 2);
          ctx.stroke();
        }

        /* pulse rings after creation */
        if (scene.pulse && scene.pulse.id === node.id) {
          const age = now - scene.pulse.at;
          if (age < 2600) {
            for (let k = 0; k < 3; k++) {
              const phase = (age - k * 520) / 1400;
              if (phase <= 0 || phase >= 1) continue;
              ctx.globalAlpha = (1 - phase) * 0.7;
              ctx.strokeStyle = node.color;
              ctx.lineWidth = 2 * (1 - phase) + 0.5;
              ctx.beginPath();
              ctx.arc(entry.sx, entry.sy, radius + phase * 46, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }

        ctx.globalAlpha = 1;
      }

      scene.projected = hitList;

      /* floating labels for hover / selection */
      const labelTargets: Array<{
        node: LayoutNode;
        entry: ProjectedPoint & { sx: number; sy: number };
      }> = [];
      const hoverEntry = scene.hoverId ? projected.get(scene.hoverId) : null;
      if (hoverEntry) {
        labelTargets.push({ node: hoverEntry.node, entry: hoverEntry });
      }
      const selectedEntry = scene.selectedId
        ? projected.get(scene.selectedId)
        : null;
      if (selectedEntry && scene.selectedId !== scene.hoverId) {
        labelTargets.push({ node: selectedEntry.node, entry: selectedEntry });
      }

      ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const { node, entry } of labelTargets) {
        const label = truncate(node.content.replace(/\s+/g, " "), 46);
        const meta = categoryMeta(node.category).label;
        const textWidth = ctx.measureText(label).width;
        ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
        const metaWidth = ctx.measureText(meta).width;
        ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
        const padX = 10;
        const boxW = Math.max(textWidth + padX * 2, metaWidth + padX * 2, 120);
        const boxH = 34;
        let bx = entry.sx + entry.persp * 14 + 8;
        let by = entry.sy - boxH / 2;
        if (bx + boxW > width - 8) bx = entry.sx - boxW - entry.persp * 14 - 8;
        by = clamp(by, 8, height - boxH - 8);

        ctx.globalAlpha = 0.98;
        ctx.fillStyle = labelBg;
        ctx.strokeStyle = labelBorder;
        ctx.lineWidth = 1;
        const r = 8;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.arcTo(bx + boxW, by, bx + boxW, by + boxH, r);
        ctx.arcTo(bx + boxW, by + boxH, bx, by + boxH, r);
        ctx.arcTo(bx, by + boxH, bx, by, r);
        ctx.arcTo(bx, by, bx + boxW, by, r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = hexToRgba(node.color, 1);
        ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(meta, bx + padX, by + 11);
        ctx.fillStyle = textColor;
        ctx.font = "500 12px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(label, bx + padX, by + 24);
        ctx.globalAlpha = 1;
      }
    };

    const loop = () => {
      if (disposed) return;
      const scene = sceneRef.current;
      const now = performance.now();

      if (scene.camTarget) {
        const target = scene.camTarget;
        let ty = target.yaw;
        ty += Math.round((scene.cam.yaw - ty) / (Math.PI * 2)) * Math.PI * 2;
        scene.cam.yaw += (ty - scene.cam.yaw) * 0.11;
        scene.cam.pitch += (target.pitch - scene.cam.pitch) * 0.11;
        scene.cam.zoom += (target.zoom - scene.cam.zoom) * 0.11;
        scene.lastInteract = now;
        if (
          Math.abs(ty - scene.cam.yaw) < 0.0015 &&
          Math.abs(target.pitch - scene.cam.pitch) < 0.0015 &&
          Math.abs(target.zoom - scene.cam.zoom) < 0.0015
        ) {
          scene.cam.yaw = ty;
          scene.cam.pitch = target.pitch;
          scene.cam.zoom = target.zoom;
          scene.camTarget = null;
        }
      } else if (
        !scene.reduceMotion &&
        !scene.dragging &&
        !scene.hoverId &&
        now - scene.lastInteract > 3500
      ) {
        scene.cam.yaw += 0.0016;
      }

      if (scene.pulse && now - scene.pulse.at > 3000) scene.pulse = null;

      drawScene(now);
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* -------------------------------- mutations ------------------------------- */

  const reinforcingRef = useRef<Set<string>>(new Set());
  const [reinforcing, setReinforcing] = useState<string | null>(null);

  const handleReinforce = useCallback(
    async (memory: AgentMemoryNode) => {
      if (isReadOnly) {
        toast.info("Native Jcode memory is read-only.");
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
        toast.info("Native Jcode memory is read-only.");
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

  /* ------------------------------- view labels ------------------------------ */

  const categoryPills = useMemo(() => {
    const byCategory = stats?.byCategory ?? {};
    const known = CLUSTER_ORDER.filter((c) => c !== "other").map(
      (category) => ({
        category,
        count: byCategory[category] ?? 0,
      }),
    );
    const extras = Object.keys(byCategory)
      .filter((c) => !CATEGORY_META[c] || c === "other")
      .map((category) => ({ category: "other", count: byCategory[category] }));
    return [...known, ...extras].filter((entry) => entry.count > 0);
  }, [stats?.byCategory]);

  const total = stats?.total ?? allMemories.length;

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
      onFocus={(id) => {
        setSelectedId(id);
        flyTo(id);
      }}
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

  return (
    <div className={cn("min-h-screen w-full bg-background", className)}>
      <div className="pointer-events-none fixed inset-0 -z-10 opacity-[0.55]">
        <div className="absolute inset-0 bg-[radial-gradient(60%_45%_at_50%_0%,color-mix(in_oklab,var(--primary)_14%,transparent),transparent_70%)]" />
      </div>

      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-[1560px] px-4 py-3.5 md:px-7">
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
                    Memory Palace
                  </h1>
                  <p className="text-[11px] text-muted-foreground">
                    Native Jcode memory graph · Retained natively
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
            <StatPill
              icon={<CircleDot className="size-3" />}
              label={`${total} memories`}
            />
            <StatPill
              icon={<Network className="size-3" />}
              label={`${stats?.projectCount ?? 0} project · ${stats?.globalCount ?? 0} global`}
            />
            <StatPill
              icon={<Sparkles className="size-3" />}
              label={`${stats?.active ?? 0} active`}
            />
            <StatPill
              icon={<Tag className="size-3" />}
              label={`${stats?.uniqueTags ?? 0} tags`}
            />
            <Separator orientation="vertical" className="h-5" />
            {categoryPills.map(({ category, count }) => {
              const meta = categoryMeta(category);
              return (
                <StatPill
                  key={category}
                  label={`${meta.label} ${count}`}
                  tone={meta.color}
                />
              );
            })}
            {isValidating ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                data-testid="memory-search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search memories, tags, sessions"
                aria-label="Search memories"
                className="h-8 w-[230px] rounded-full pl-8 text-sm"
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
                className="min-w-[140px] rounded-full"
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

            <div className="flex flex-wrap items-center gap-1.5">
              <FilterPill
                active={categoryFilter === "all"}
                onClick={() => setCategoryFilter("all")}
              >
                All
              </FilterPill>
              {CLUSTER_ORDER.filter((c) => c !== "other").map((category) => (
                <FilterPill
                  key={category}
                  active={categoryFilter === category}
                  onClick={() =>
                    setCategoryFilter((current) =>
                      current === category ? "all" : category,
                    )
                  }
                  color={categoryMeta(category).color}
                >
                  {categoryMeta(category).label}
                </FilterPill>
              ))}
            </div>

            <Separator orientation="vertical" className="h-5" />

            <div className="flex items-center gap-1.5">
              {(
                [
                  ["all", "All time"],
                  ["7d", "7d"],
                  ["24h", "24h"],
                ] as Array<[RecencyLens, string]>
              ).map(([value, label]) => (
                <FilterPill
                  key={value}
                  active={recency === value}
                  onClick={() => setRecency(value)}
                >
                  {label}
                </FilterPill>
              ))}
            </div>

            {scopeFilter !== "all" ||
            categoryFilter !== "all" ||
            recency !== "all" ||
            search ? (
              <button
                type="button"
                aria-label="Reset all search and filter options"
                onClick={() => {
                  setScopeFilter("all");
                  setCategoryFilter("all");
                  setRecency("all");
                  setSearch("");
                }}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition hover:text-foreground"
              >
                <RefreshCw className="size-3" />
                Reset filters
              </button>
            ) : null}

            <span
              className="ml-auto text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              {filteredMemories.length} of {allMemories.length} in view
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1560px] px-4 py-5 md:px-7">
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
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="h-[540px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
            <div className="h-[540px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
          </div>
        ) : viewMode === "split" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_392px]">
            <div className="min-w-0 space-y-3">
              <ConstellationPanel
                containerRef={containerRef}
                canvasRef={canvasRef}
                nodes={layoutNodes}
                clusterCounts={clusterCounts}
                onZoomIn={() => zoomBy(1.18)}
                onZoomOut={() => zoomBy(1 / 1.18)}
                onReset={resetCamera}
              />
              <LegendRow clusterCounts={clusterCounts} />
            </div>
            <div className="min-w-0">{inspector}</div>
          </div>
        ) : viewMode === "constellation" ? (
          <div className="space-y-3">
            <ConstellationPanel
              containerRef={containerRef}
              canvasRef={canvasRef}
              nodes={layoutNodes}
              clusterCounts={clusterCounts}
              onZoomIn={() => zoomBy(1.18)}
              onZoomOut={() => zoomBy(1 / 1.18)}
              onReset={resetCamera}
            />
            <LegendRow clusterCounts={clusterCounts} />
          </div>
        ) : (
          <MemoryCardGrid
            memories={filteredMemories}
            selectedId={selectedId}
            maxStrength={maxStrength}
            onSelect={(id) => {
              setSelectedId(id);
              flyTo(id);
            }}
          />
        )}
      </main>

      <AnimatePresence>
        {viewMode !== "split" && selectedMemory ? (
          <motion.aside
            key="memory-drawer"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            className="fixed inset-y-0 right-0 z-40 w-full max-w-[440px] p-3"
            role="dialog"
            aria-label="Memory detail"
          >
            <div className="h-full overflow-hidden rounded-2xl border border-border/60 bg-background/95 shadow-2xl backdrop-blur-xl">
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
            setSelectedId(memory.id);
            setPendingFocusId(memory.id);
            setViewMode((mode) => (mode === "cards" ? "split" : mode));
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
    {
      id: "constellation",
      label: "Map",
      icon: <Compass className="size-3.5" />,
    },
    { id: "cards", label: "Cards", icon: <LayoutGrid className="size-3.5" /> },
    { id: "split", label: "Split", icon: <Columns2 className="size-3.5" /> },
  ];
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className="hidden items-center gap-0.5 rounded-full border border-border/70 bg-card/60 p-0.5 shadow-xs sm:flex"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
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
/*                          Constellation panel + map                          */
/* -------------------------------------------------------------------------- */

function ConstellationPanel({
  containerRef,
  canvasRef,
  nodes,
  clusterCounts,
  onZoomIn,
  onZoomOut,
  onReset,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  nodes: LayoutNode[];
  clusterCounts: number[];
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-[radial-gradient(120%_120%_at_50%_10%,color-mix(in_oklab,var(--foreground)_5%,transparent),transparent_60%)] shadow-sm">
      <div
        ref={containerRef}
        className="relative h-[420px] w-full sm:h-[520px] lg:h-[600px]"
      >
        <canvas
          ref={canvasRef}
          data-testid="memory-constellation-canvas"
          role="img"
          className="absolute inset-0 size-full touch-none select-none"
          aria-label="Interactive memory constellation. Drag to rotate, scroll to zoom, click a node for details."
        />
        {nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="max-w-xs text-center">
              <p className="font-brand text-lg">No memories in this lens</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Widen the scope, category, or recency filters to bring nodes
                back into orbit.
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
        <Crosshair className="size-3.5" />
        Drag to orbit · scroll to zoom · click a node
      </div>

      <div className="absolute top-3 right-3 flex items-center gap-1 rounded-full border border-border/60 bg-background/70 p-0.5 backdrop-blur-sm">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onZoomIn}
              aria-label="Zoom in"
            >
              <ZoomIn className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onZoomOut}
              aria-label="Zoom out"
            >
              <ZoomOut className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onReset}
              aria-label="Reset camera"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset camera</TooltipContent>
        </Tooltip>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-2">
        {CLUSTER_ORDER.map((cluster, index) =>
          clusterCounts[index] ? (
            <span
              key={cluster}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground backdrop-blur-sm"
            >
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: categoryMeta(cluster).color }}
              />
              {categoryMeta(cluster).label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function LegendRow({ clusterCounts }: { clusterCounts: number[] }) {
  const totalNodes = clusterCounts.reduce((sum, count) => sum + count, 0);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border/60 bg-card/40 px-4 py-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <Maximize2 className="size-3.5" />
        {totalNodes} nodes drawn
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-6 bg-foreground/40" /> explicit link
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-6 border-t border-dashed border-foreground/40" />
        shared tag
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Sparkles className="size-3.5" />
        halo marks fresh or strong memory
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                             Memory card grid                               */
/* -------------------------------------------------------------------------- */

function MemoryCardGrid({
  memories,
  selectedId,
  maxStrength,
  onSelect,
}: {
  memories: AgentMemoryNode[];
  selectedId: string | null;
  maxStrength: number;
  onSelect: (id: string) => void;
}) {
  if (memories.length === 0) {
    return (
      <EmptyState
        icon={<Brain className="size-5" />}
        title="No memories match this view"
        detail="Try clearing filters to bring records into orbit."
      />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {memories.map((memory) => {
        const meta = categoryMeta(memory.category);
        const wide = memory.content.length > 170;
        return (
          <button
            key={memory.id}
            type="button"
            aria-label={`View memory details: ${truncate(memory.content, 48)}`}
            onClick={() => onSelect(memory.id)}
            className={cn(
              "group relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-border/70 bg-card/50 p-4 text-left shadow-xs transition duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:-translate-y-0.5 hover:border-border hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
              wide && "sm:col-span-2",
              selectedId === memory.id && "ring-2 ring-ring/60",
              !memory.active && "opacity-70",
            )}
          >
            <span
              className="absolute inset-x-0 top-0 h-[3px]"
              style={{ backgroundColor: meta.color }}
            />
            <div className="flex items-center justify-between gap-2">
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
              <span className="font-mono text-[11px] text-muted-foreground">
                {relativeTime(memory.updatedAt)}
              </span>
            </div>

            <p className="text-sm leading-relaxed text-foreground">
              {truncate(memory.content, wide ? 320 : 190)}
            </p>

            {memory.tags.length ? (
              <div className="flex flex-wrap gap-1.5">
                {memory.tags.slice(0, 5).map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="rounded-full text-[10px] font-normal text-muted-foreground"
                  >
                    {tag}
                  </Badge>
                ))}
                {memory.tags.length > 5 ? (
                  <span className="text-[10px] text-muted-foreground">
                    +{memory.tags.length - 5}
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="mt-auto flex items-center gap-3 pt-1">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round(clamp(memory.strength / Math.max(1, maxStrength), 0, 1) * 100)}%`,
                    backgroundColor: meta.color,
                  }}
                />
              </div>
              <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                <Gauge className="size-3" />
                {memory.strength.toFixed(2)}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {memory.reinforcements}x
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Detail inspector                              */
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
      <PanelShell title="Memory Inspector" className="h-full">
        <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-card/50">
            <Crosshair className="size-5 text-muted-foreground" />
          </span>
          <p className="font-brand text-base">Nothing selected</p>
          <p className="max-w-[240px] text-sm text-muted-foreground">
            Click any node in the constellation, or a card, to inspect its
            content, provenance, and graph relationships.
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
      title="Memory Inspector"
      className="h-full"
      action={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <X className="size-4" />
        </Button>
      }
    >
      <ScrollArea className="max-h-[calc(100vh-190px)]">
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
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

          <button
            type="button"
            aria-label="Focus memory location in constellation"
            onClick={() => onFocus(memory.id)}
            className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-card/40 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground transition hover:border-border hover:text-foreground"
          >
            <CircleDot className="size-3.5 shrink-0" />
            <span className="truncate">{scopePath}</span>
          </button>

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
              value={clamp(memory.strength / Math.max(1, maxStrength), 0, 1)}
              color={meta.color}
              hint={memory.strength.toFixed(2)}
            />
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                Reinforcements
              </span>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="size-3.5" style={{ color: meta.color }} />
                {memory.reinforcements}
                <span className="text-xs text-muted-foreground">
                  · {memory.accessCount} recalls
                </span>
              </div>
            </div>
          </div>

          {memory.tags.length ? (
            <div className="space-y-2">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                Tags
              </span>
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
            </div>
          ) : null}

          <Separator />

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

          <Separator />

          <div className="space-y-2">
            {isReadOnly ? (
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3.5 text-xs leading-relaxed text-muted-foreground">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <ShieldCheck className="size-3.5 text-primary" />
                  Native Jcode memory retained
                </div>
                <p className="mt-1">
                  Memories are stored directly in Jcode&apos;s native memory graph (
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground">
                    ~/.jcode/memory
                  </code>
                  ) and updated natively by Jcode during chat sessions. Direct mutation
                  controls are disabled because Jcode retains memories natively without
                  running a secondary engine.
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
            Writes into Jcode&apos;s memory graph. Matching content reinforces
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
