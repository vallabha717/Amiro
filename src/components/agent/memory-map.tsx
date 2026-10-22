"use client";

import {
  Crosshair,
  ListOrdered,
  Network,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "ui/button";
import type { AgentMemoryEdge, AgentMemoryNode } from "./agent-memory-view";
import { buildForceLayout } from "./concept-graph/build-force-layout";
import { ConceptGraphIntroBanner } from "./concept-graph/concept-graph-intro-banner";
import { ConceptGraphLegend } from "./concept-graph/concept-graph-legend";
import {
  CLUSTER_PALETTE,
  EDGE_LEARNED_COLOR,
  NODE_KIND_COLORS,
  VIRTUAL_CENTER,
} from "./concept-graph/constants";
import { detectClusters } from "./concept-graph/detect-clusters";
import { RecencyLens, type RecencyWindow } from "./concept-graph/recency-lens";
import type {
  ConceptNodeKind,
  GraphLayoutNode,
  MemoryGraphInput,
} from "./concept-graph/types";

const NODE_KIND_ORDER: ConceptNodeKind[] = [
  "concept",
  "skill",
  "capability",
  "pending",
  "other",
];

// Rotation / projection tuning (from Vellum concept-graph-view.tsx)
const AUTO_YAW_PER_SEC = 0.13;
const IDLE_RESUME_MS = 2600;
const DRAG_SENSITIVITY = 0.006;
const PITCH_CLAMP = 1.15;
const FOCAL_FACTOR = 3.0;
const DEPTH_ALPHA_MIN = 0.32;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 3;
const HUB_LABEL_DEGREE = 4;

// Recency emphasis
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_GLOW_WINDOW_MS = 14 * DAY_MS;
const RECENCY_GLOW_MAX = 12;
const PULSE_WINDOW_MS = 2 * DAY_MS;

// Density fog
const FOG_FULL_BELOW = 80;
const FOG_FLOOR_ABOVE = 340;
const FOG_FLOOR = 0.12;

// Ego-dim
const SELECTION_DIM_NODE = 0.05;
const SELECTION_DIM_EDGE = 0.03;

const SEARCH_MIN_NODES = 6;
const BORN_PULSE_MS = 2600;
const INTRO_STORAGE_KEY = "amiro:conceptGraph:introDismissed";

interface Projected {
  id: string;
  sx: number;
  sy: number;
  sr: number;
  depth: number;
  updatedAtMs?: number;
}

interface ProjectedEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  kind: string;
  description?: string;
  depth: number;
}

interface Colors {
  content: string;
  tertiary: string;
}

function resolveColors(el: HTMLElement): Colors {
  const s = getComputedStyle(el);
  const fg = s.color?.trim() || s.getPropertyValue("--foreground").trim();
  const muted = s.getPropertyValue("--muted-foreground").trim();
  return {
    content: fg || "#18181b",
    tertiary: muted || "#71717a",
  };
}

function labelForEdge(edge: { kind: string; description?: string }): string {
  if (edge.kind === "learned") {
    return edge.description
      ? `Learned association · ${edge.description}`
      : "Learned association";
  }
  return edge.description ?? "Linked concepts";
}

function isStale(
  updatedAtMs: number | undefined,
  windowMs: number | null,
  now: number,
): boolean {
  if (windowMs == null) {
    return false;
  }
  return updatedAtMs == null || now - updatedAtMs > windowMs;
}

function makeEgoTest(
  adjacency: Map<string, Set<string>>,
  selectedId: string | null,
): (id: string) => boolean {
  const neighbors = selectedId ? adjacency.get(selectedId) : undefined;
  return (id) =>
    selectedId != null && (id === selectedId || (neighbors?.has(id) ?? false));
}

function deriveLabel(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled concept";
  const colonIdx = clean.indexOf(":");
  if (colonIdx > 2 && colonIdx <= 28) {
    return clean.slice(0, colonIdx).trim();
  }
  const words = clean.split(" ");
  if (words.length <= 5 && clean.length <= 36) {
    return clean;
  }
  const slice = words.slice(0, 4).join(" ");
  return slice.length > 32 ? `${slice.slice(0, 31)}…` : slice;
}

function parseMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

export interface ConceptGraphViewHandle {
  focusNode(id: string): void;
}

export interface MemoryMapProps {
  memories: AgentMemoryNode[];
  edges: AgentMemoryEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  className?: string;
  headerAction?: React.ReactNode;
  handleRef?: React.Ref<ConceptGraphViewHandle>;
}

/**
 * Vellum's 2.5D "brain" of the assistant's memory concepts: nodes laid out in a 3D
 * volume via deterministic force-directed relaxation, slowly auto-rotating
 * (drag to orbit, scroll to zoom), drawn on canvas with depth cues (near = larger /
 * brighter / glowing) and hover-neighborhood highlighting.
 */
export function MemoryMap({
  memories,
  edges: rawEdges,
  selectedId,
  onSelect,
  className,
  headerAction,
  handleRef,
}: MemoryMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [focusOnSelected, setFocusOnSelected] = useState(false);
  const [showAllNodes, setShowAllNodes] = useState(true);

  const graphInput = useMemo<MemoryGraphInput>(() => {
    const nodes = memories.map((m) => ({
      id: m.id,
      label: deriveLabel(m.content),
      summary: m.content,
      kind: m.active === false ? "pending" : "concept",
      weight: m.strength,
      updatedAtMs: parseMs(m.updatedAt) ?? parseMs(m.createdAt),
    }));
    const edges = rawEdges.map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind === "explicit" ? "link" : "learned",
      description:
        e.label ??
        (e.kind === "explicit"
          ? "Authored link"
          : e.kind === "tag"
            ? "Shared tag"
            : "Category group"),
      directed: false,
    }));
    return { nodes, edges };
  }, [memories, rawEdges]);

  const layout = useMemo(() => buildForceLayout(graphInput), [graphInput]);
  const ready = layout.nodes.length > 0;

  const clusters = useMemo(
    () => detectClusters(layout.nodes, layout.edges),
    [layout.nodes, layout.edges],
  );

  const themes = useMemo(() => {
    const byCluster = new Map<number, GraphLayoutNode[]>();
    for (const node of layout.nodes) {
      const cluster = clusters.get(node.id);
      if (cluster == null || node.degree === 0) {
        continue;
      }
      const arr = byCluster.get(cluster);
      if (arr) {
        arr.push(node);
      } else {
        byCluster.set(cluster, [node]);
      }
    }
    return [...byCluster.entries()]
      .map(([cluster, nodes]) => {
        const top = [...nodes]
          .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1))
          .slice(0, 3);
        return {
          hubId: top[0].id,
          color: CLUSTER_PALETTE[cluster % CLUSTER_PALETTE.length],
          name: top[0].label,
          concepts: top.map((n) => n.label),
          size: nodes.length,
        };
      })
      .sort((a, b) => b.size - a.size);
  }, [clusters, layout.nodes]);

  const clusterHubs = useMemo(
    () => new Set(themes.map((t) => t.hubId)),
    [themes],
  );

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let set = map.get(a);
      if (!set) {
        set = new Set();
        map.set(a, set);
      }
      set.add(b);
    };
    for (const e of layout.edges) {
      add(e.fromId, e.toId);
      add(e.toId, e.fromId);
    }
    return map;
  }, [layout.edges]);

  const massRadius = useMemo(() => {
    if (layout.nodes.length === 0) {
      return 1;
    }
    const dists = layout.nodes
      .map((n) => {
        const dx = n.x - VIRTUAL_CENTER.x;
        const dy = n.y - VIRTUAL_CENTER.y;
        return Math.sqrt(dx * dx + dy * dy + n.z * n.z) + n.radius;
      })
      .sort((a, b) => a - b);
    const idx = Math.min(dists.length - 1, Math.floor(dists.length * 0.92));
    return Math.max(1, dists[idx]);
  }, [layout.nodes]);

  const view = useRef({
    yaw: 0.5,
    pitch: 0.32,
    zoom: 1,
    hoveredId: null as string | null,
    dragging: false,
    moved: false,
    lastX: 0,
    lastY: 0,
    lastInteractAt: -Infinity,
    dirty: true,
  });
  const projectedRef = useRef<Projected[]>([]);
  const projectedEdgesRef = useRef<ProjectedEdge[]>([]);
  const colorsRef = useRef<Colors>({ content: "#e5e7eb", tertiary: "#8792a0" });
  const focusTargetRef = useRef<string | null>(null);
  const resetViewRef = useRef(false);
  const bornRef = useRef<{ id: string; start: number } | null>(null);
  const pendingFocusRef = useRef<string | null>(null);

  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const [edgeLabel, setEdgeLabel] = useState<string | null>(null);

  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (selectedId) {
      focusTargetRef.current = selectedId;
    } else {
      resetViewRef.current = true;
    }
    view.current.dirty = true;
  }, [selectedId]);

  const [introDismissed, setIntroDismissed] = useState(false);
  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        setIntroDismissed(
          window.localStorage.getItem(INTRO_STORAGE_KEY) === "true",
        );
      }
    } catch {
      // ignore
    }
  }, []);

  const dismissIntro = useCallback(() => {
    setIntroDismissed(true);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(INTRO_STORAGE_KEY, "true");
      }
    } catch {
      // ignore
    }
  }, []);

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const searchLower = search.trim().toLowerCase();
  const matchIds = useMemo(() => {
    if (!searchLower) {
      return null;
    }
    const s = new Set<string>();
    for (const n of layout.nodes) {
      if (
        n.label.toLowerCase().includes(searchLower) ||
        (n.summary && n.summary.toLowerCase().includes(searchLower))
      ) {
        s.add(n.id);
      }
    }
    return s;
  }, [searchLower, layout.nodes]);

  const filterRef = useRef<{ active: boolean; matches: Set<string> | null }>({
    active: false,
    matches: null,
  });
  useEffect(() => {
    filterRef.current = { active: Boolean(matchIds), matches: matchIds };
    view.current.dirty = true;
  }, [matchIds]);

  const searchResults = useMemo(() => {
    if (!matchIds || matchIds.size === 0) {
      return [];
    }
    return layout.nodes
      .filter((n) => matchIds.has(n.id))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 8);
  }, [matchIds, layout.nodes]);

  const [recency, setRecency] = useState<RecencyWindow>("all");
  const recencyRef = useRef<number | null>(null);
  useEffect(() => {
    recencyRef.current =
      recency === "week"
        ? 7 * DAY_MS
        : recency === "month"
          ? 30 * DAY_MS
          : null;
    view.current.dirty = true;
  }, [recency]);

  const hasRecencyData = useMemo(
    () => layout.nodes.some((n) => n.updatedAtMs != null),
    [layout.nodes],
  );

  useEffect(() => {
    if (!hasRecencyData && recency !== "all") {
      setRecency("all");
    }
  }, [hasRecencyData, recency]);

  const [edgeFilter, setEdgeFilter] = useState({ link: true, learned: true });
  const edgeFilterRef = useRef(edgeFilter);
  useEffect(() => {
    edgeFilterRef.current = edgeFilter;
    view.current.dirty = true;
  }, [edgeFilter]);

  const resetView = useCallback(() => {
    const v = view.current;
    v.yaw = 0.5;
    v.pitch = 0.32;
    v.zoom = 1;
    v.lastInteractAt = -Infinity;
    v.dirty = true;
    setFocusLabel(null);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const v = view.current;
    v.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor));
    v.lastInteractAt = performance.now();
    v.dirty = true;
  }, []);

  const focusOn = useCallback((id: string) => {
    focusTargetRef.current = id;
    view.current.lastInteractAt = performance.now();
    view.current.dirty = true;
  }, []);

  const applyBorn = useCallback(
    (id: string) => {
      bornRef.current = { id, start: performance.now() };
      focusOn(id);
      window.setTimeout(() => {
        view.current.dirty = true;
      }, BORN_PULSE_MS + 60);
    },
    [focusOn],
  );

  const focusNode = useCallback(
    (id: string) => {
      if (layout.nodes.some((n) => n.id === id)) {
        applyBorn(id);
      } else {
        pendingFocusRef.current = id;
      }
    },
    [layout.nodes, applyBorn],
  );

  useEffect(() => {
    const id = pendingFocusRef.current;
    if (id && layout.nodes.some((n) => n.id === id)) {
      pendingFocusRef.current = null;
      applyBorn(id);
    }
  }, [layout.nodes, applyBorn]);

  useImperativeHandle(handleRef, () => ({ focusNode }), [focusNode]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const nodes = layout.nodes;
    const edges = layout.edges;
    const nodeClusters = clusters;
    const hubIds = clusterHubs;
    const adj = adjacency;
    const presentNodeIds = new Set(nodes.map((n) => n.id));
    const R = massRadius;

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    colorsRef.current = resolveColors(container);

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cssW = 0;
    let cssH = 0;
    const applySize = () => {
      const rect = container.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      colorsRef.current = resolveColors(container);
      view.current.dirty = true;
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(container);

    const themeObserver = new MutationObserver(() => {
      colorsRef.current = resolveColors(container);
      view.current.dirty = true;
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });

    let raf = 0;
    let last = 0;
    const render = (t: number) => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
      last = t;
      const v = view.current;
      const colors = colorsRef.current;
      const nowMs = Date.now();

      const focusId = focusTargetRef.current;
      const idle = !v.dragging && t - v.lastInteractAt > IDLE_RESUME_MS;
      if (idle && !reduceMotion && !focusId) {
        v.yaw += AUTO_YAW_PER_SEC * dt;
      }

      if (focusId) {
        const target = nodes.find((n) => n.id === focusId);
        if (!target) {
          focusTargetRef.current = null;
        } else {
          const nx = target.x - VIRTUAL_CENTER.x;
          const ny = target.y - VIRTUAL_CENTER.y;
          const nz = target.z;
          const targetYaw = -Math.atan2(nx, nz);
          const r = Math.hypot(nx, nz);
          const targetPitch = Math.max(
            -PITCH_CLAMP,
            Math.min(PITCH_CLAMP, Math.atan2(ny, r)),
          );
          const targetZoom = Math.min(MAX_ZOOM, 1.6);
          const k = reduceMotion ? 1 : 0.15;
          let dY = targetYaw - v.yaw;
          dY = Math.atan2(Math.sin(dY), Math.cos(dY));
          v.yaw += dY * k;
          v.pitch += (targetPitch - v.pitch) * k;
          v.zoom += (targetZoom - v.zoom) * k;
          v.dirty = true;
          if (
            Math.abs(dY) < 0.01 &&
            Math.abs(targetPitch - v.pitch) < 0.01 &&
            Math.abs(targetZoom - v.zoom) < 0.02
          ) {
            focusTargetRef.current = null;
          }
        }
      }

      if (resetViewRef.current && !v.dragging) {
        const k = reduceMotion ? 1 : 0.15;
        v.pitch += (0.32 - v.pitch) * k;
        v.zoom += (1 - v.zoom) * k;
        v.dirty = true;
        if (Math.abs(0.32 - v.pitch) < 0.01 && Math.abs(1 - v.zoom) < 0.02) {
          resetViewRef.current = false;
        }
      }

      if (reduceMotion && !v.dirty) {
        raf = requestAnimationFrame(render);
        return;
      }
      v.dirty = false;

      const cosY = Math.cos(v.yaw);
      const sinY = Math.sin(v.yaw);
      const cosX = Math.cos(v.pitch);
      const sinX = Math.sin(v.pitch);
      const focal = FOCAL_FACTOR * R;
      const baseZoom = (Math.min(cssW, cssH) * 0.88) / (2 * R);
      const zoom = baseZoom * v.zoom;
      const cx = cssW / 2;
      const cy = cssH / 2;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const activeId = v.hoveredId;
      const neighbors = activeId ? adj.get(activeId) : undefined;
      const isLit = (id: string) =>
        !activeId || id === activeId || (neighbors?.has(id) ?? false);

      const filter = filterRef.current;
      const searchActive = filter.active;
      const isMatch = (id: string) =>
        !searchActive || (filter.matches?.has(id) ?? false);

      const recencyWindowMs = recencyRef.current;
      const isRecencyGhost = (n: GraphLayoutNode) =>
        isStale(n.updatedAtMs, recencyWindowMs, nowMs);

      const edgeKinds = edgeFilterRef.current;

      const curSelectedId = selectedIdRef.current;
      const selectionActive =
        curSelectedId != null && presentNodeIds.has(curSelectedId);
      const inSelectedEgo = makeEgoTest(
        adj,
        selectionActive ? curSelectedId : null,
      );

      const learnedFog =
        nodes.length <= FOG_FULL_BELOW
          ? 1
          : Math.max(
              FOG_FLOOR,
              1 -
                ((nodes.length - FOG_FULL_BELOW) /
                  (FOG_FLOOR_ABOVE - FOG_FULL_BELOW)) *
                  (1 - FOG_FLOOR),
            );

      const proj = new Array<{
        node: GraphLayoutNode;
        sx: number;
        sy: number;
        sr: number;
        depth: number;
      }>(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const px = node.x - VIRTUAL_CENTER.x;
        const py = node.y - VIRTUAL_CENTER.y;
        const pz = node.z;
        const x1 = px * cosY + pz * sinY;
        const z1 = -px * sinY + pz * cosY;
        const y2 = py * cosX - z1 * sinX;
        const z2 = py * sinX + z1 * cosX;
        const persp = focal / (focal - z2);
        proj[i] = {
          node,
          sx: cx + x1 * zoom * persp,
          sy: cy + y2 * zoom * persp,
          sr: Math.max(1.2, node.radius * zoom * persp),
          depth: Math.max(0, Math.min(1, (z2 + R) / (2 * R))),
        };
      }

      const order = proj
        .map((_, i) => i)
        .sort((a, b) => proj[a].depth - proj[b].depth);
      const posById = new Map<string, (typeof proj)[number]>();
      for (const p of proj) {
        posById.set(p.node.id, p);
      }

      const projEdges: ProjectedEdge[] = [];
      ctx.lineCap = "round";
      for (const e of edges) {
        const a = posById.get(e.fromId);
        const b = posById.get(e.toId);
        if (!a || !b) {
          continue;
        }
        const learned = e.kind === "learned";
        const egoEdge =
          curSelectedId != null &&
          (e.fromId === curSelectedId || e.toId === curSelectedId);
        if (!egoEdge && (learned ? !edgeKinds.learned : !edgeKinds.link)) {
          continue;
        }
        const ghost =
          (searchActive && (!isMatch(e.fromId) || !isMatch(e.toId))) ||
          (!egoEdge && (isRecencyGhost(a.node) || isRecencyGhost(b.node)));
        const incident =
          activeId != null && (e.fromId === activeId || e.toId === activeId);
        const depth = (a.depth + b.depth) / 2;
        if (!ghost && (!selectionActive || egoEdge)) {
          projEdges.push({
            ax: a.sx,
            ay: a.sy,
            bx: b.sx,
            by: b.sy,
            kind: e.kind,
            description: e.description,
            depth,
          });
        }
        const litAlpha = (learned ? 0.34 : 0.28) * (0.4 + 0.6 * depth);
        const restAlpha = learned ? litAlpha * learnedFog : litAlpha;
        let alpha: number;
        if (ghost) {
          alpha = 0.03;
        } else if (selectionActive) {
          alpha = egoEdge ? 0.9 : SELECTION_DIM_EDGE;
        } else if (activeId != null) {
          alpha = incident
            ? 0.9
            : isLit(e.fromId) && isLit(e.toId)
              ? litAlpha
              : 0.05;
        } else {
          alpha = restAlpha;
        }
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = learned ? EDGE_LEARNED_COLOR : colors.tertiary;
        ctx.lineWidth =
          (incident || (selectionActive && egoEdge) ? 2 : 1) *
          (0.6 + 0.6 * depth);
        ctx.setLineDash(learned ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const idx of order) {
        const p = proj[idx];
        const node = p.node;
        const color =
          node.kind === "concept"
            ? CLUSTER_PALETTE[
                (nodeClusters.get(node.id) ?? 0) % CLUSTER_PALETTE.length
              ]
            : NODE_KIND_COLORS[node.kind];
        const searchGhost = searchActive && !isMatch(node.id);
        const inEgo = inSelectedEgo(node.id);
        const ghost = searchGhost || (isRecencyGhost(node) && !inEgo);
        const lit = selectionActive
          ? inEgo && !ghost
          : !ghost && isLit(node.id);
        const isActive = node.id === activeId;
        const depthA = DEPTH_ALPHA_MIN + (1 - DEPTH_ALPHA_MIN) * p.depth;
        const alpha =
          selectionActive && !inEgo
            ? depthA * SELECTION_DIM_NODE
            : ghost
              ? depthA * 0.08
              : lit
                ? depthA
                : depthA * 0.18;

        let glow =
          (isActive ? 16 : node.degree >= HUB_LABEL_DEGREE ? 8 : 4) * p.depth;
        const updatedAtMs = node.updatedAtMs;
        if (updatedAtMs) {
          const age = nowMs - updatedAtMs;
          const freshness = Math.max(0, 1 - age / RECENCY_GLOW_WINDOW_MS);
          if (freshness > 0) {
            let boost = freshness * RECENCY_GLOW_MAX;
            if (!reduceMotion && age < PULSE_WINDOW_MS) {
              boost *= 0.55 + 0.45 * Math.sin(t / 420 + idx * 1.7);
            }
            glow += boost * p.depth;
          }
        }
        ctx.shadowColor = color;
        ctx.shadowBlur = lit ? glow : 0;

        const isPending = node.kind === "pending";

        ctx.globalAlpha = alpha * (isPending ? 0.3 : 0.55);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, p.sr, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = isActive ? 2.5 : 1.4;
        ctx.strokeStyle = color;
        ctx.setLineDash(isPending ? [3, 3] : []);
        ctx.stroke();
        ctx.setLineDash([]);

        const born = bornRef.current;
        if (born && born.id === node.id) {
          const bornElapsed = t - born.start;
          if (bornElapsed > BORN_PULSE_MS) {
            bornRef.current = null;
          } else if (reduceMotion) {
            ctx.globalAlpha = 0.7;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, p.sr + 7, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            for (let ring = 0; ring < 3; ring++) {
              const prog = (bornElapsed - ring * 320) / 1100;
              if (prog <= 0 || prog >= 1) {
                continue;
              }
              ctx.globalAlpha = (1 - prog) * 0.8;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(p.sx, p.sy, p.sr + prog * 46 * p.depth, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
      }
      ctx.shadowBlur = 0;

      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.font = '11px "DM Sans", ui-sans-serif, system-ui, sans-serif';
      for (const idx of order) {
        const p = proj[idx];
        const node = p.node;
        const inEgo = inSelectedEgo(node.id);
        if (
          (searchActive && !isMatch(node.id)) ||
          (isRecencyGhost(node) && !inEgo)
        ) {
          continue;
        }
        const showLabel = selectionActive
          ? inEgo
          : searchActive
            ? p.depth > 0.3
            : activeId != null
              ? isLit(node.id)
              : hubIds.has(node.id) ||
                (node.degree >= HUB_LABEL_DEGREE && p.depth > 0.55);
        if (!showLabel) {
          continue;
        }
        ctx.globalAlpha =
          (node.id === activeId || node.id === curSelectedId ? 1 : 0.85) *
          (0.4 + 0.6 * p.depth);
        ctx.fillStyle = colors.content;
        const label =
          node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label;
        ctx.fillText(label, p.sx, p.sy + p.sr + 3);
      }
      ctx.globalAlpha = 1;

      projectedRef.current = proj.map((p) => ({
        id: p.node.id,
        sx: p.sx,
        sy: p.sy,
        sr: p.sr,
        depth: p.depth,
        updatedAtMs: p.node.updatedAtMs,
      }));
      projectedEdgesRef.current = projEdges;

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
    };
  }, [ready, layout, adjacency, massRadius, clusters, clusterHubs]);

  const hitTest = useCallback(
    (x: number, y: number): string | null => {
      const filter = filterRef.current;
      const recencyWindowMs = recencyRef.current;
      const inSelectedEgo = makeEgoTest(adjacency, selectedIdRef.current);
      const now = Date.now();
      let best: string | null = null;
      let bestDepth = -1;
      for (const p of projectedRef.current) {
        if (filter.active && !(filter.matches?.has(p.id) ?? false)) {
          continue;
        }
        if (
          !inSelectedEgo(p.id) &&
          isStale(p.updatedAtMs, recencyWindowMs, now)
        ) {
          continue;
        }
        const dx = x - p.sx;
        const dy = y - p.sy;
        if (
          dx * dx + dy * dy <= (p.sr + 5) * (p.sr + 5) &&
          p.depth > bestDepth
        ) {
          best = p.id;
          bestDepth = p.depth;
        }
      }
      return best;
    },
    [adjacency],
  );

  const edgeHitTest = useCallback(
    (x: number, y: number): { kind: string; description?: string } | null => {
      let best: { kind: string; description?: string } | null = null;
      let bestDist = Infinity;
      let bestDepth = -1;
      for (const e of projectedEdgesRef.current) {
        const vx = e.bx - e.ax;
        const vy = e.by - e.ay;
        const len2 = vx * vx + vy * vy;
        let t = 0;
        if (len2 > 0) {
          t = ((x - e.ax) * vx + (y - e.ay) * vy) / len2;
          t = Math.max(0, Math.min(1, t));
        }
        const dx = x - (e.ax + t * vx);
        const dy = y - (e.ay + t * vy);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 5) {
          continue;
        }
        if (dist < bestDist || (dist === bestDist && e.depth > bestDepth)) {
          best = { kind: e.kind, description: e.description };
          bestDist = dist;
          bestDepth = e.depth;
        }
      }
      return best;
    },
    [],
  );

  const localPoint = (e: React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }
    if ((e.target as HTMLElement).closest("[data-graph-control]")) {
      return;
    }
    const v = view.current;
    focusTargetRef.current = null;
    v.dragging = true;
    v.moved = false;
    v.lastX = e.clientX;
    v.lastY = e.clientY;
    v.lastInteractAt = performance.now();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const v = view.current;
      if (v.dragging) {
        const dx = e.clientX - v.lastX;
        const dy = e.clientY - v.lastY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          v.moved = true;
        }
        v.yaw += dx * DRAG_SENSITIVITY;
        v.pitch = Math.max(
          -PITCH_CLAMP,
          Math.min(PITCH_CLAMP, v.pitch + dy * DRAG_SENSITIVITY),
        );
        v.lastX = e.clientX;
        v.lastY = e.clientY;
        v.lastInteractAt = performance.now();
        v.dirty = true;
        return;
      }
      const { x, y } = localPoint(e);
      const hit = hitTest(x, y);
      if (hit !== v.hoveredId) {
        v.hoveredId = hit;
        v.dirty = true;
        if (hit) {
          const n = layout.nodes.find((nn) => nn.id === hit);
          setFocusLabel(n ? n.label : null);
        } else {
          setFocusLabel(null);
        }
      }
      if (hit) {
        setEdgeLabel(null);
      } else {
        const edge = edgeHitTest(x, y);
        setEdgeLabel(edge ? labelForEdge(edge) : null);
      }
    },
    [hitTest, edgeHitTest, layout.nodes],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const v = view.current;
      if (!v.dragging) {
        return;
      }
      v.dragging = false;
      v.lastInteractAt = performance.now();
      v.dirty = true;
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      if (!v.moved) {
        const { x, y } = localPoint(e);
        const hit = hitTest(x, y);
        if (hit) {
          onSelect(hit);
          focusOn(hit);
        } else {
          setFocusLabel(null);
        }
      }
    },
    [hitTest, onSelect, focusOn],
  );

  const onPointerLeave = useCallback(() => {
    const v = view.current;
    setEdgeLabel(null);
    if (v.dragging || v.hoveredId == null) {
      return;
    }
    v.hoveredId = null;
    v.dirty = true;
    setFocusLabel(null);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !ready) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.("[data-graph-panel]")) {
        return;
      }
      e.preventDefault();
      const v = view.current;
      v.zoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, v.zoom * (1 - e.deltaY / 500)),
      );
      v.lastInteractAt = performance.now();
      v.dirty = true;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ready]);

  const presentKinds = useMemo(() => {
    const kinds = new Set(layout.nodes.map((n) => n.kind));
    return NODE_KIND_ORDER.filter((k) => kinds.has(k));
  }, [layout.nodes]);

  const hasLearned = useMemo(
    () => layout.edges.some((e) => e.kind === "learned"),
    [layout.edges],
  );
  const hasLinks = useMemo(
    () => layout.edges.some((e) => e.kind !== "learned"),
    [layout.edges],
  );

  useEffect(() => {
    if (
      !(hasLinks && hasLearned) &&
      (!edgeFilter.link || !edgeFilter.learned)
    ) {
      setEdgeFilter({ link: true, learned: true });
    }
  }, [hasLinks, hasLearned, edgeFilter]);

  const showIntro = ready && !introDismissed;
  const neurons = layout.nodes.length;
  const synapses = layout.edges.length;
  const lobes = new Set(clusters.values()).size;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;

  const hoverLabel = !showIntro ? (focusLabel ?? edgeLabel) : null;
  const showSearch =
    ready && (layout.nodes.length > SEARCH_MIN_NODES || Boolean(search));

  if (memories.length === 0) {
    return (
      <section
        data-testid="memory-map"
        aria-label="Memory map"
        className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-card/40 px-6 py-16 text-center"
      >
        <Network className="size-6 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-semibold">No memories match this view</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          As your assistant learns and links ideas, they&apos;ll appear here as
          a living map of its memory.
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="memory-map"
      aria-label="Memory map"
      className={`@container flex select-none flex-col overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm ${className ?? ""}`}
    >
      {/* Vellum Header Bar */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-card/60 px-4">
        {/* Left slot: Search */}
        <div className="flex min-w-0 items-center gap-2">
          {showSearch ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className={`size-8 ${searchOpen ? "hidden" : "@2xl:hidden"}`}
                onClick={() => setSearchOpen(true)}
                aria-label="Search concepts"
              >
                <Search className="size-4" />
              </Button>
              <div
                className={`relative ${searchOpen ? "" : "hidden @2xl:block"}`}
              >
                <div className="flex items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-2.5 py-1">
                  <Search
                    size={14}
                    aria-hidden
                    className="text-muted-foreground"
                  />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        if (search || searchOpen) {
                          e.preventDefault();
                          e.stopPropagation();
                          setSearch("");
                          setSearchOpen(false);
                        }
                      } else if (e.key === "Enter" && searchResults.length > 0) {
                        e.preventDefault();
                        focusOn(searchResults[0].id);
                        onSelect(searchResults[0].id);
                      }
                    }}
                    placeholder="Search concepts…"
                    aria-label="Search concepts"
                    className="w-40 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  {search ? (
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {matchIds?.size ?? 0}
                    </span>
                  ) : null}
                  {search || searchOpen ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setSearchOpen(false);
                      }}
                      aria-label="Clear search"
                      className="flex cursor-pointer items-center text-muted-foreground hover:text-foreground"
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                </div>

                {search && searchResults.length > 0 ? (
                  <ul className="absolute top-full left-0 z-30 mt-1.5 flex max-h-56 w-56 list-none flex-col overflow-y-auto rounded-xl border border-border/70 bg-card/95 py-1 shadow-lg backdrop-blur-md">
                    {searchResults.map((node) => (
                      <li key={node.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(node.id);
                            focusOn(node.id);
                            setSearch("");
                            setSearchOpen(false);
                          }}
                          className="block w-full cursor-pointer truncate px-3 py-1.5 text-left text-[12px] text-foreground hover:bg-muted/70"
                        >
                          {node.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        {/* Center slot: hover pill or neuron/synapse/lobe stats */}
        <div className="pointer-events-none mx-auto min-w-0">
          {hoverLabel ? (
            <div className="truncate rounded-full border border-border/70 bg-background/90 px-3 py-1 text-[12px] font-medium text-foreground shadow-2xs">
              {hoverLabel}
            </div>
          ) : (
            <div className="rounded-full border border-border/70 bg-background/80 px-3 py-1 text-[11px] tabular-nums text-muted-foreground">
              <span className="@max-md:hidden">
                {plural(neurons, "neuron")} · {plural(synapses, "synapse")} ·{" "}
                {plural(lobes, "lobe")}
              </span>
              <span className="hidden @max-md:inline">
                {neurons} · {synapses} · {lobes}
              </span>
            </div>
          )}
        </div>

        {/* Right slot: Focus button / headerAction */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant={focusOnSelected && selectedId ? "secondary" : "outline"}
            size="sm"
            data-testid="memory-map-focus"
            disabled={!selectedId}
            onClick={() => {
              if (selectedId) {
                setFocusOnSelected((v) => !v);
                focusOn(selectedId);
              }
            }}
            aria-pressed={focusOnSelected && Boolean(selectedId)}
            className="h-7 rounded-full px-2.5 text-xs"
          >
            <Crosshair className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Focus selected</span>
          </Button>
          {memories.length > 20 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="memory-map-load-more"
              onClick={() => setShowAllNodes((v) => !v)}
              className="hidden"
            >
              <ListOrdered className="size-3.5" aria-hidden="true" />
              {showAllNodes ? "Show fewer" : "Show more"}
            </Button>
          ) : null}
          {headerAction ? (
            <div className="flex-none">{headerAction}</div>
          ) : null}
        </div>
      </div>

      {/* 2.5D Rotating Force-Directed Canvas Viewport */}
      <div
        ref={containerRef}
        role="region"
        aria-label="Memory concept graph"
        className="relative h-[560px] w-full shrink-0 overflow-hidden lg:h-[640px]"
        style={{
          backgroundImage:
            "radial-gradient(circle at center, color-mix(in srgb, var(--muted-foreground) 12%, transparent), transparent 64%)",
          touchAction: "none",
          cursor: ready ? "grab" : "default",
        }}
        onPointerDown={ready ? onPointerDown : undefined}
        onPointerMove={ready ? onPointerMove : undefined}
        onPointerUp={ready ? onPointerUp : undefined}
        onPointerCancel={ready ? onPointerUp : undefined}
        onPointerLeave={ready ? onPointerLeave : undefined}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

        {/* Top-left Recency Lens + Intro Banner */}
        <div className="pointer-events-none absolute top-4 right-16 left-4 z-10 flex flex-col items-start gap-3">
          {ready &&
          (layout.nodes.length > SEARCH_MIN_NODES || recency !== "all") &&
          hasRecencyData ? (
            <div data-graph-control className="pointer-events-auto">
              <RecencyLens value={recency} onChange={setRecency} />
            </div>
          ) : null}

          {showIntro ? (
            <ConceptGraphIntroBanner onDismiss={dismissIntro} />
          ) : null}
        </div>

        {/* Bottom-left Theme & Edge Legend */}
        <ConceptGraphLegend
          nodeKinds={presentKinds.filter((k) => k !== "concept")}
          coloredByTheme={presentKinds.includes("concept")}
          themes={themes}
          hasLinks={hasLinks}
          hasLearned={hasLearned}
          {...(hasLinks && hasLearned
            ? {
                onToggleLink: () =>
                  setEdgeFilter((f) => ({ ...f, link: !f.link })),
                onToggleLearned: () =>
                  setEdgeFilter((f) => ({ ...f, learned: !f.learned })),
                linkActive: edgeFilter.link,
                learnedActive: edgeFilter.learned,
              }
            : {})}
        />

        {/* Bottom-right Orbit Hint */}
        <div className="pointer-events-none absolute right-4 bottom-4 text-[11px] text-muted-foreground">
          drag to rotate · scroll to zoom
        </div>

        {/* Top-right Zoom & Reset Controls */}
        <div
          data-graph-control
          className="absolute top-4 right-4 flex flex-col gap-1 rounded-xl border border-border/70 bg-card/80 p-1 backdrop-blur-md"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg"
            onClick={() => zoomBy(1.25)}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg"
            onClick={() => zoomBy(0.8)}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-lg"
            onClick={resetView}
            aria-label="Fit view"
            title="Reset view"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Accessible Browse Disclosure */}
      <details
        data-testid="memory-map-browse"
        className="border-t border-border/60 bg-card/30 px-4 py-2.5 text-xs"
      >
        <summary className="cursor-pointer font-medium text-muted-foreground select-none hover:text-foreground">
          Browse visible memories ({memories.length})
        </summary>
        <ul className="mt-2.5 grid max-h-48 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
          {memories.map((memory) => (
            <li key={memory.id}>
              <button
                type="button"
                data-testid="memory-map-list-item"
                data-memory-id={memory.id}
                onClick={() => {
                  onSelect(memory.id);
                  focusOn(memory.id);
                }}
                title={memory.content}
                aria-label={`Memory ${memory.id}: ${memory.content}`}
                className="flex w-full cursor-pointer items-center gap-2 truncate rounded-lg border border-border/50 bg-card/70 px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:border-border hover:bg-card"
              >
                <span className="truncate">{memory.content}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export default MemoryMap;
