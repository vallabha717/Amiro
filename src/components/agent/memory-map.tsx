"use client";

import {
  Crosshair,
  ListOrdered,
  Maximize2,
  Network,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Button } from "ui/button";
import type { AgentMemoryEdge, AgentMemoryNode } from "./agent-memory-view";
import {
  MAP_CLUSTER_ORDER,
  MAP_COLUMNS,
  MAP_PAGE_MAX,
  MAP_PAGE_SIZE,
  balanceMemories,
  buildAdjacency,
  countEdgesByKind,
  edgesBetweenVisible,
  focusSubset,
  hiddenByCluster,
  layoutMemoryMap,
  normalizeMapCategory,
  previewLines,
  type PositionedMemoryNode,
} from "./memory-map-layout";
import { cn } from "lib/utils";

/* -------------------------------------------------------------------------- */
/* MemoryMap: readable 2D SVG atlas over caller-supplied memories and edges.   */
/*                                                                            */
/* - Category columns are stable slots, never invented clusters.              */
/* - Nodes are content-preview cards, never anonymous dots.                   */
/* - Only supplied edges are drawn: solid = explicit, dashed = shared tag,    */
/*   dotted = category. Category edges are never labelled as tag.             */
/* - Initial view is bounded (~20 balanced across categories) in a 3x2     */
/*   region grid at 1:1 legible text with explicit hidden counts and Show   */
/*   more. A category rail pans to any region; a minimap shows the full     */
/*   overview plus the visible window. Fit view resets to readable 1:1,      */
/*   never scale-to-fit-all. Mobile pans a readable slice.                   */
/* - No animation loops, no new dependencies.                                  */
/* -------------------------------------------------------------------------- */

export interface MemoryMapProps {
  memories: AgentMemoryNode[];
  edges: AgentMemoryEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface Pan {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
/** Pointer must move this far before a press becomes a pan, not a click. */
const DRAG_THRESHOLD_PX = 5;

function clampZoom(k: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

function accessibleName(memory: AgentMemoryNode): string {
  const single = memory.content.replace(/\s+/g, " ").trim();
  return `Memory ${memory.id}: ${single || "(empty memory)"}`;
}

function MemoryCard({
  placed,
  selected,
  dimmed,
  neighbor,
  onSelect,
  suppressClickRef,
}: {
  placed: PositionedMemoryNode;
  selected: boolean;
  dimmed: boolean;
  neighbor: boolean;
  onSelect: (id: string) => void;
  suppressClickRef: RefObject<boolean>;
}) {
  const { memory, x, y, width, height } = placed;
  const color = placedColor(placed.cluster);
  const lines = previewLines(memory.content, 34, 3);
  const full = memory.content;

  const handleClick = () => {
    if (suppressClickRef.current) return;
    onSelect(memory.id);
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(memory.id);
    }
  };

  return (
    <g
      data-testid="memory-map-node"
      data-memory-id={memory.id}
      transform={`translate(${x},${y})`}
      opacity={dimmed ? 0.32 : 1}
      tabIndex={0}
      role="button"
      aria-label={accessibleName(memory)}
      aria-current={selected ? "true" : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-[var(--ring)]"
    >
      <title>{full}</title>
      <rect
        width={width}
        height={height}
        rx={14}
        fill="var(--card)"
        stroke={selected ? color : "var(--border)"}
        strokeWidth={selected ? 3 : 1.25}
      />
      {selected ? (
        <rect
          x={-4}
          y={-4}
          width={width + 8}
          height={height + 8}
          rx={17}
          fill="none"
          stroke={color}
          strokeOpacity={0.35}
          strokeWidth={2}
          strokeDasharray="5 4"
          pointerEvents="none"
        />
      ) : null}
      {neighbor && !selected ? (
        <rect
          x={-2.5}
          y={-2.5}
          width={width + 5}
          height={height + 5}
          rx={16}
          fill="none"
          stroke={color}
          strokeOpacity={0.6}
          strokeWidth={1.5}
          pointerEvents="none"
        />
      ) : null}
      <circle cx={16} cy={17} r={5} fill={color} aria-hidden="true" />
      <text
        x={27}
        y={21}
        fontSize={11}
        fontWeight={700}
        fill={color}
        aria-hidden="true"
      >
        {categorySingular(placed.cluster)}
      </text>
      {!memory.active ? (
        <text
          x={width - 12}
          y={21}
          fontSize={10}
          textAnchor="end"
          fill="var(--muted-foreground)"
          aria-hidden="true"
        >
          superseded
        </text>
      ) : null}
      {lines.map((line, i) => (
        <text
          key={i}
          x={14}
          y={42 + i * 18}
          fontSize={12.5}
          fill="var(--foreground)"
          aria-hidden="true"
        >
          {line}
        </text>
      ))}
      <text
        x={14}
        y={height - 10}
        fontSize={10}
        fill="var(--muted-foreground)"
        aria-hidden="true"
      >
        {tagLine(memory)}
      </text>
    </g>
  );
}

function placedColor(cluster: string): string {
  switch (cluster) {
    case "fact":
      return "#007AFF";
    case "preference":
      return "#A665C9";
    case "entity":
      return "#0E9B8B";
    case "correction":
      return "#E9642F";
    default:
      return "#8A8F98";
  }
}

function categorySingular(cluster: string): string {
  switch (cluster) {
    case "fact":
      return "Fact";
    case "preference":
      return "Preference";
    case "entity":
      return "Entity";
    case "correction":
      return "Correction";
    default:
      return "Other";
  }
}

/** Region description wrapped to the region width (40 chars x 2 lines). */
function descriptionLines(description: string): string[] {
  return previewLines(description, 40, 2);
}

function tagLine(memory: AgentMemoryNode): string {
  const tags = (memory.tags ?? []).slice(0, 3).join(" · ");
  const scope = memory.scopeLabel || memory.scope || "";
  const base = scope ? `${scope}` : "";
  const full =
    tags && base ? `${base} · ${tags}` : tags || base || memory.id.slice(0, 8);
  // Bound to the card width: SVG text does not wrap, so truncate by length.
  const max = 38;
  if (full.length <= max) return full;
  return `${full.slice(0, max - 1).trimEnd()}…`;
}

function edgeTitle(edge: AgentMemoryEdge): string {
  if (edge.kind === "explicit") {
    return `Explicit link${edge.label ? `: ${edge.label}` : ""}`;
  }
  if (edge.kind === "tag") {
    return `Shared tag${edge.label ? `: ${edge.label}` : ""}`;
  }
  if (edge.kind === "category") {
    return `Category group${edge.label ? `: ${edge.label}` : " (same category)"}`;
  }
  return `Relationship (${edge.kind})${edge.label ? `: ${edge.label}` : ""}`;
}

/**
 * MiniMap: native-SVG-only overview showing every region at relative scale
 * plus the current visible window. Clicking a region jumps the main canvas.
 */
function MiniMap({
  layout,
  pan,
  viewportWidth,
  viewportHeight,
  onJump,
}: {
  layout: {
    clusters: Array<{
      info: { key: string; color: string };
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    width: number;
    height: number;
  };
  pan: Pan;
  viewportWidth: number;
  viewportHeight: number;
  onJump: (x: number, y: number) => void;
}) {
  const W = 132;
  const H = 88;
  const sx = layout.width > 0 ? W / layout.width : 1;
  const sy = layout.height > 0 ? H / layout.height : 1;
  const k = pan.k || 1;
  const vx = -pan.x / k;
  const vy = -pan.y / k;
  const vw = viewportWidth / k;
  const vh = viewportHeight / k;
  return (
    <svg
      data-testid="memory-map-minimap"
      role="img"
      aria-label="Mini overview of all category regions and the visible window. Activate a region to pan there."
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="ml-auto hidden shrink-0 rounded-md border border-border bg-card/60 sm:block"
    >
      {layout.clusters.map((c) => (
        <g
          key={c.info.key}
          data-testid={`memory-map-minimap-${c.info.key}`}
          role="button"
          tabIndex={0}
          aria-label={`Pan to ${c.info.key} region`}
          onClick={() => onJump(Math.min(0, -c.x + 24), Math.min(0, -c.y + 24))}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onJump(Math.min(0, -c.x + 24), Math.min(0, -c.y + 24));
            }
          }}
          className="cursor-pointer outline-none focus-visible:[&>rect]:stroke-[var(--ring)]"
        >
          <rect
            x={c.x * sx}
            y={c.y * sy}
            width={Math.max(6, c.width * sx)}
            height={Math.max(5, c.height * sy)}
            rx={2}
            fill={c.info.color}
            fillOpacity={0.55}
          />
        </g>
      ))}
      <rect
        x={Math.max(0, vx * sx)}
        y={Math.max(0, vy * sy)}
        width={Math.min(W, vw * sx)}
        height={Math.min(H, vh * sy)}
        rx={2}
        fill="none"
        stroke="var(--foreground)"
        strokeOpacity={0.7}
        strokeWidth={1.25}
      />
    </svg>
  );
}

function edgeDash(kind: string): string | undefined {
  if (kind === "explicit") return undefined;
  if (kind === "tag") return "7 5";
  if (kind === "category") return "3 3";
  return "2 4";
}

export function MemoryMap({
  memories,
  edges,
  selectedId,
  onSelect,
}: MemoryMapProps) {
  const [showAll, setShowAll] = useState(false);
  const [focusOn, setFocusOn] = useState(false);
  // Map-owned focus id: survives inspector close so Focus stays usable even
  // when the host clears selectedId on drawer close. Falls back to the
  // current prop selection when set.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    dragging: boolean;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ w: 1100, h: 600 });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setViewportSize({
        w: Math.max(320, Math.round(rect.width)),
        h: Math.max(400, Math.round(rect.height)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Pan the canvas so the chosen region's origin lands at the viewport
  // origin (1:1 readable). Clamped so empty space never dominates.
  const panToCluster = (rx: number, ry: number) => {
    setPan((p) => ({
      ...p,
      x: Math.min(0, -rx + 24),
      y: Math.min(0, -ry + 24),
    }));
  };

  const selectedExists =
    selectedId !== null && memories.some((m) => m.id === selectedId);
  // Prefer the live prop; keep the last map focus id after inspector close.
  const effectiveFocusId =
    selectedExists && selectedId !== null
      ? selectedId
      : focusId !== null && memories.some((m) => m.id === focusId)
        ? focusId
        : null;
  const focusActive = focusOn && effectiveFocusId !== null;

  const focus = useMemo(
    () =>
      effectiveFocusId ? focusSubset(memories, edges, effectiveFocusId) : null,
    [memories, edges, effectiveFocusId],
  );

  // onSelect highlights first. The host owns the inspector via the
  // selectedId prop; the map ALSO records a focus id so Focus selected
  // keeps working after the inspector closes and clears selectedId.
  const handleSelect = (id: string) => {
    setFocusId(id);
    onSelect(id);
  };

  // Per-node focus action: available from the overview list and from the
  // toolbar, positioned left so the right-side inspector never covers it.
  const handleFocusNode = (id: string) => {
    setFocusId(id);
    setFocusOn(true);
    onSelect(id);
  };
  // Bounded initial slice: 20 balanced across categories at legible 1:1 text.
  // Show more grows to 60 balanced; beyond that the reader pans the canvas.
  const initialSlice = useMemo(
    () => balanceMemories(memories, MAP_PAGE_SIZE),
    [memories],
  );
  const expandedSlice = useMemo(
    () => balanceMemories(memories, MAP_PAGE_MAX),
    [memories],
  );

  const baseList: AgentMemoryNode[] = useMemo(() => {
    if (focusActive && focus) return focus.visible;
    return (showAll ? expandedSlice : initialSlice).visible;
  }, [focusActive, focus, showAll, expandedSlice, initialSlice]);

  const activeSlice = showAll ? expandedSlice : initialSlice;

  const layout = useMemo(
    () => layoutMemoryMap(baseList, { columns: MAP_COLUMNS }),
    [baseList],
  );

  const visibleIds = useMemo(
    () => new Set(baseList.map((m) => m.id)),
    [baseList],
  );

  const hiddenCounts = useMemo(
    () => hiddenByCluster(memories, visibleIds),
    [memories, visibleIds],
  );

  const totalsByCluster = useMemo(() => {
    const totals = new Map<string, number>();
    for (const key of MAP_CLUSTER_ORDER) totals.set(key, 0);
    for (const memory of memories) {
      const key = normalizeMapCategory(memory.category);
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    return totals;
  }, [memories]);

  const drawnEdges = useMemo(
    () => edgesBetweenVisible(edges, visibleIds),
    [edges, visibleIds],
  );

  const edgeCounts = useMemo(() => countEdgesByKind(drawnEdges), [drawnEdges]);

  const neighbors = useMemo(() => {
    if (!effectiveFocusId && !selectedId) return new Set<string>();
    const key = selectedId ?? effectiveFocusId;
    if (!key) return new Set<string>();
    return buildAdjacency(drawnEdges).get(key) ?? new Set<string>();
  }, [drawnEdges, selectedId, effectiveFocusId]);

  const zoomBy = (factor: number) =>
    setPan((p) => ({ ...p, k: clampZoom(p.k * factor) }));

  // Fit view resets to readable 1:1 origin. It never scales the whole atlas
  // down to fit, which would shrink every card to microscopic text.
  const fitView = () => {
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
    setPan({ x: 0, y: 0, k: 1 });
  };

  const handleViewportKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(1.2);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(1 / 1.2);
    } else if (event.key === "0") {
      event.preventDefault();
      fitView();
    }
  };

  // Pointer capture ONLY after the drag threshold: capturing on pointer
  // down retargets the click away from the SVG node and breaks node clicks.
  // The original click target is retained for clicks (no capture at all).
  const onPointerDown = (event: ReactPointerEvent) => {
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: pan.x,
      origY: pan.y,
      dragging: true,
      moved: false,
      pointerId: event.pointerId,
    };
    suppressClickRef.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag?.dragging || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      if (!drag.moved) {
        drag.moved = true;
        // Capture late so the in-progress pan keeps events, but the
        // original node click target was already retained for clicks.
        (event.currentTarget as HTMLElement).setPointerCapture?.(
          event.pointerId,
        );
      }
      suppressClickRef.current = true;
      setPan((p) => ({ ...p, x: drag.origX + dx, y: drag.origY + dy }));
    }
  };

  const endPan = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      dragRef.current = null;
      if (
        (event.currentTarget as HTMLElement).hasPointerCapture?.(
          event.pointerId,
        )
      ) {
        try {
          (event.currentTarget as HTMLElement).releasePointerCapture(
            event.pointerId,
          );
        } catch {
          // Already released: clicks must still reach the node.
        }
      }
      // Let the next node click through only when this was a real click.
      if (!drag.moved) suppressClickRef.current = false;
      else {
        // Clear the suppression on the next tick so drags never select.
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    }
  };

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
          No memories match the current filters. When memories are added they
          appear here grouped by category. No groups are invented: an empty
          atlas stays empty and honest.
        </p>
      </section>
    );
  }

  const svgHeight = Math.max(layout.height, 480);

  return (
    <section
      data-testid="memory-map"
      aria-label="Memory map"
      className="overflow-hidden rounded-2xl border border-border bg-card/40 shadow-sm"
    >
      {/* Toolbar: counts are always explicit, never silent. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {focusActive && focus
            ? `${focus.visible.length} memories in focus`
            : `${activeSlice.visible.length} of ${activeSlice.total} memories shown`}
          {activeSlice.hiddenCount > 0 && !focusActive
            ? ` · ${activeSlice.hiddenCount} more`
            : ""}
          <span className="sr-only">
            . Category-balanced previews. {drawnEdges.length} of {edges.length}{" "}
            supplied relationships shown.
          </span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {!focusActive && initialSlice.hiddenCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="memory-map-load-more"
              onClick={() => setShowAll((v) => !v)}
            >
              <ListOrdered className="size-3.5" aria-hidden="true" />
              {showAll
                ? "Show fewer"
                : `Show ${Math.min(MAP_PAGE_MAX, memories.length) - initialSlice.visible.length} more`}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={focusActive ? "secondary" : "outline"}
            size="sm"
            data-testid="memory-map-focus"
            disabled={!effectiveFocusId}
            onClick={() => setFocusOn((v) => !v)}
            aria-pressed={focusActive}
            title={
              effectiveFocusId
                ? "Show only the focused memory and its actual neighbors"
                : "Select a memory first to focus its neighborhood"
            }
          >
            {focusActive ? (
              <X className="size-3.5" aria-hidden="true" />
            ) : (
              <Crosshair className="size-3.5" aria-hidden="true" />
            )}
            {focusActive ? "Clear focus" : "Focus selected"}
          </Button>
          <span
            className="mx-0.5 hidden h-5 w-px bg-border sm:inline-block"
            aria-hidden="true"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={() => zoomBy(1.2)}
            aria-label="Zoom in"
            title="Zoom in (keyboard: plus)"
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={() => zoomBy(1 / 1.2)}
            aria-label="Zoom out"
            title="Zoom out (keyboard: minus)"
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={fitView}
            aria-label="Fit view"
            title="Fit view: reset zoom and pan to readable 1:1 (keyboard: 0)"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Honest legend: explicit vs shared-tag vs category, never conflated. */}
      <div className="hidden flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground sm:flex">
        <span className="inline-flex items-center gap-1.5">
          <Maximize2 className="size-3.5" aria-hidden="true" />
          {layout.nodes.length} {layout.nodes.length === 1 ? "card" : "cards"}{" "}
          drawn
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-6 rounded bg-foreground/60"
            aria-hidden="true"
          />
          explicit link ({edgeCounts.explicit})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0 w-6 border-t-2 border-dashed border-foreground/50"
            aria-hidden="true"
          />
          shared tag ({edgeCounts.tag})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0 w-6 border-t-2 border-dotted border-foreground/50"
            aria-hidden="true"
          />
          category group ({edgeCounts.category})
        </span>
        {edgeCounts.other > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-6 border-t-2 border-dotted border-foreground/40"
              aria-hidden="true"
            />
            other ({edgeCounts.other})
          </span>
        ) : null}
        <span className="ml-auto hidden sm:inline">
          Only supplied relationships are drawn.
        </span>
      </div>

      {drawnEdges.length === 0 ? (
        <p
          role="note"
          className="border-b border-border bg-muted/10 px-4 py-2 text-xs text-muted-foreground"
        >
          No supplied relationships between these memories yet. Cards are
          grouped by category so the atlas stays readable without inventing
          links.
        </p>
      ) : null}

      {/* Category rail: always-visible pills with counts that pan the      */}
      {/* canvas to the chosen region. Works on mobile where regions sit   */}
      {/* side by side, and stays left of the right-side inspector.        */}
      <div
        role="group"
        aria-label="Category regions"
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/20 px-4 py-2"
      >
        {MAP_CLUSTER_ORDER.map((key) => {
          const total = totalsByCluster.get(key) ?? 0;
          const region = layout.clusters.find((c) => c.info.key === key);
          const count = region?.count ?? 0;
          return (
            <button
              key={key}
              type="button"
              data-testid={`memory-map-cluster-${key}`}
              disabled={!region}
              onClick={() => region && panToCluster(region.x, region.y)}
              aria-label={`${region?.info.plural ?? key}: ${count} shown of ${total}. Pan to region.`}
              title={
                region
                  ? `Pan to ${region.info.plural} region (${count} of ${total})`
                  : `${key}: none in view`
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40",
                region
                  ? "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  : "border-border/60 text-muted-foreground/60",
              )}
            >
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{
                  backgroundColor: region?.info.color ?? "var(--border)",
                }}
              />
              {region?.info.plural ?? key} {count}/{total}
            </button>
          );
        })}
        {/* Mini overview: full relative region positions plus the visible window. */}
        <MiniMap
          layout={layout}
          pan={pan}
          viewportWidth={viewportSize.w}
          viewportHeight={viewportSize.h}
          onJump={(x, y) => setPan((p) => ({ ...p, x, y }))}
        />
      </div>

      {/* Map viewport: native SVG keeps its explicit layout size, so a     */}
      {/* single category stays a true card and multi-category keeps the    */}
      {/* full grid. No CSS min-width: that would scale one region giant    */}
      {/* and distort click geometry. Mobile pans the fixed-size canvas.    */}
      <div
        ref={viewportRef}
        data-testid="memory-map-viewport"
        tabIndex={0}
        role="region"
        aria-label="Memory map canvas. Drag to pan, use plus and minus to zoom, zero for fit view. Tab to reach memory cards, Enter to select."
        onKeyDown={handleViewportKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        className="h-[480px] cursor-grab touch-none overflow-auto overscroll-contain bg-[radial-gradient(120%_120%_at_50%_0%,color-mix(in_oklab,var(--foreground)_4%,transparent),transparent_60%)] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing lg:h-[600px]"
      >
        <svg
          data-testid="memory-map-svg"
          role="group"
          aria-label={`${layout.nodes.length} memories across ${layout.clusters.length} categories`}
          width={layout.width}
          height={svgHeight}
          viewBox={`0 0 ${layout.width} ${svgHeight}`}
          className="max-w-none"
        >
          <g transform={`translate(${pan.x},${pan.y}) scale(${pan.k})`}>
            {layout.clusters.map((cluster) => {
              const hidden = hiddenCounts[cluster.info.key] ?? 0;
              const total =
                totalsByCluster.get(cluster.info.key) ?? cluster.count;
              return (
                <g key={cluster.info.key}>
                  <rect
                    x={cluster.x}
                    y={cluster.y}
                    width={cluster.width}
                    height={cluster.height}
                    rx={18}
                    fill="var(--muted)"
                    fillOpacity={0.22}
                    stroke="var(--border)"
                    strokeOpacity={0.8}
                  />
                  <circle
                    cx={cluster.x + 28}
                    cy={cluster.y + 32}
                    r={7}
                    fill={cluster.info.color}
                    aria-hidden="true"
                  />
                  <text
                    x={cluster.x + 42}
                    y={cluster.y + 37}
                    fontSize={15}
                    fontWeight={700}
                    fill="var(--foreground)"
                  >
                    {cluster.info.plural} · {cluster.count}
                  </text>
                  <text
                    x={cluster.x + 42}
                    y={cluster.y + 52}
                    fontSize={11}
                    fill="var(--muted-foreground)"
                  >
                    {cluster.count} of {total}
                    {hidden > 0 ? ` · ${hidden} more` : ""}
                  </text>
                  {descriptionLines(cluster.info.description).map((line, i) => (
                    <text
                      key={i}
                      x={cluster.x + 20}
                      y={cluster.y + 70 + i * 14}
                      fontSize={11}
                      fill="var(--muted-foreground)"
                    >
                      {line}
                    </text>
                  ))}
                </g>
              );
            })}

            {drawnEdges.map((edge) => {
              const a = layout.byId.get(edge.source);
              const b = layout.byId.get(edge.target);
              if (!a || !b) return null;
              const active =
                selectedId !== null &&
                (edge.source === selectedId || edge.target === selectedId);
              const faded =
                selectedId !== null &&
                edge.source !== selectedId &&
                edge.target !== selectedId;
              return (
                <line
                  key={edge.id}
                  x1={a.cx}
                  y1={a.cy}
                  x2={b.cx}
                  y2={b.cy}
                  stroke="var(--foreground)"
                  strokeOpacity={active ? 0.75 : faded ? 0.12 : 0.35}
                  strokeWidth={edge.kind === "explicit" ? 2 : 1.4}
                  strokeDasharray={edgeDash(edge.kind)}
                  pointerEvents="none"
                >
                  <title>{edgeTitle(edge)}</title>
                </line>
              );
            })}

            {layout.nodes.map((placed) => (
              <MemoryCard
                key={placed.memory.id}
                placed={placed}
                selected={selectedId === placed.memory.id}
                neighbor={neighbors.has(placed.memory.id)}
                dimmed={
                  (selectedId !== null ||
                    (focusActive && effectiveFocusId !== null)) &&
                  (selectedId ?? effectiveFocusId) !== placed.memory.id &&
                  !neighbors.has(placed.memory.id)
                }
                onSelect={handleSelect}
                suppressClickRef={suppressClickRef}
              />
            ))}
          </g>
        </svg>
      </div>

      <details className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          How to read this map
        </summary>
        <p className="max-w-prose py-2 leading-relaxed">
          Solid lines are runtime links. Dashed lines are shared tags, not
          inferred meaning. Dotted lines show category grouping. Select a memory
          for its full text. Drag to pan, use the zoom controls, or pick a
          category to jump there. The overview starts with 20 category-balanced
          previews and expands to 60. Search or switch to Cards to reach every
          memory.
        </p>
      </details>
      {/* Accessible overview, collapsed by default so the atlas is the    */}
      {/* overview, not a duplicate full list. Expands to the same buttons. */}
      <div className="border-t border-border px-4 py-3">
        <details data-testid="memory-map-browse">
          <summary className="cursor-pointer text-xs font-semibold tracking-wide text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            Browse visible memories ({baseList.length})
          </summary>
          <ul className="mt-2 grid max-h-56 grid-cols-1 gap-1.5 overflow-auto pr-1 sm:grid-cols-2">
            {baseList.map((memory) => {
              const active = selectedId === memory.id;
              return (
                <li key={memory.id} className="flex items-stretch gap-1.5">
                  <button
                    type="button"
                    data-testid="memory-map-list-item"
                    aria-label={accessibleName(memory)}
                    aria-current={active ? "true" : undefined}
                    title={memory.content}
                    onClick={() => handleSelect(memory.id)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      active
                        ? "border-transparent bg-primary text-primary-foreground"
                        : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: placedColor(memory.category),
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {memory.content}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid={`memory-map-focus-${memory.id}`}
                    aria-label={`Focus ${memory.id} and neighbors`}
                    title="Focus this memory and its actual neighbors"
                    onClick={() => handleFocusNode(memory.id)}
                    className="shrink-0 rounded-lg border border-border bg-card px-2 text-muted-foreground transition outline-none hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <Crosshair className="size-3.5" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      </div>
    </section>
  );
}
