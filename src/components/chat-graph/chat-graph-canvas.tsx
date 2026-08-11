"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type NodeChange,
  type NodeMouseHandler,
  type OnMove,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { UIMessage } from "ai";
import { useTranslations } from "next-intl";
import { deriveChatGraph } from "lib/ai/chat-graph/derive-chat-graph";
import { layoutChatGraph } from "lib/ai/chat-graph/layout-chat-graph";
import { useToRef } from "@/hooks/use-latest";
import { ChatGraphNode as ChatGraphNodeType } from "app-types/chat-graph";
import { ChatGraphNode } from "./chat-graph-node";
import { ChatGraphPanel } from "./chat-graph-panel";

const nodeTypes = {
  chatGraphNode: ChatGraphNode,
};

const fitViewOptions = {
  duration: 300,
  padding: 0.25,
  minZoom: 0.1,
  maxZoom: 1.0,
};

/** Fraction of the canvas a followed node may occupy, leaving surrounding context. */
const FOCUS_VIEWPORT_RATIO = 0.8;
/** Never magnify past 1:1 - a small card centred at 3x looks broken. */
const FOCUS_MAX_ZOOM = 1;
const FOCUS_MIN_ZOOM = 0.2;
const FOCUS_DURATION = 400;

function ChatGraphCanvasInner({ messages }: { messages: UIMessage[] }) {
  const t = useTranslations("Chat.WorkflowView");
  const { fitView, setCenter } = useReactFlow();
  const nodesInitialized = useNodesInitialized();

  const derived = useMemo<{
    nodes: ChatGraphNodeType[];
    edges: Edge[];
  }>(() => deriveChatGraph(messages), [messages]);

  const [nodes, setNodes] = useState<ChatGraphNodeType[]>(derived.nodes);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const nodesRef = useToRef(nodes);
  const previousNodeCount = useRef(0);
  const hasSyncedOnceRef = useRef(false);
  const draggedNodeIds = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  /** Node the viewport should move to next, if auto-follow is still on. */
  const pendingFocusRef = useRef<string | null>(null);
  /** Last node we centred on, so a container resize can re-centre on it. */
  const focusedNodeIdRef = useRef<string | null>(null);
  /** Cleared when the user takes over the viewport, restored on the next prompt. */
  const autoFollowRef = useRef(true);

  // Sync derived nodes, keeping positions and measurements already established.
  // Taking `derived.nodes` wholesale would drop `measured` and force a full
  // re-measure/re-layout on every streamed token.
  useEffect(() => {
    setNodes((prevNodes) => {
      const previousById = new Map(prevNodes.map((node) => [node.id, node]));
      return derived.nodes.map((derivedNode) => {
        const previous = previousById.get(derivedNode.id);
        if (!previous) return derivedNode;
        return {
          ...derivedNode,
          position: previous.position,
          measured: previous.measured,
        };
      });
    });
  }, [derived.nodes]);

  // A fresh prompt hands the viewport back to auto-follow.
  const lastUserMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "user") return messages[index].id;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (lastUserMessageId) autoFollowRef.current = true;
  }, [lastUserMessageId]);

  // Queue the newest node for focus as the response streams in.
  useEffect(() => {
    const count = derived.nodes.length;
    if (!hasSyncedOnceRef.current) {
      // On mount let the `fitView` prop frame the thread as a whole.
      hasSyncedOnceRef.current = true;
      previousNodeCount.current = count;
      return;
    }
    if (count > previousNodeCount.current) {
      pendingFocusRef.current = derived.nodes[count - 1]?.id ?? null;
    }
    previousNodeCount.current = count;
  }, [derived.nodes]);

  // Re-flow columns from measured sizes so cards can never overlap.
  useEffect(() => {
    if (!nodesInitialized) return;
    setNodes((prevNodes) => {
      const boxes = layoutChatGraph(prevNodes);
      let moved = false;
      const next = prevNodes.map((node) => {
        // A card the user dragged keeps its position, but still holds its slot
        // in the stack so the rest of the column stays put.
        if (draggedNodeIds.current.has(node.id)) return node;
        const box = boxes.get(node.id);
        if (!box) return node;
        if (
          Math.abs(node.position.x - box.x) < 0.5 &&
          Math.abs(node.position.y - box.y) < 0.5
        ) {
          return node;
        }
        moved = true;
        return { ...node, position: { x: box.x, y: box.y } };
      });
      // Returning the same reference bails out of the render, so this effect
      // settling on a stable layout does not loop.
      return moved ? next : prevNodes;
    });
  }, [nodes, nodesInitialized]);

  const focusNode = useCallback(
    (nodeId: string) => {
      const container = containerRef.current;
      if (!container) return false;
      const box = layoutChatGraph(nodesRef.current).get(nodeId);
      if (!box) return false;

      const { width: viewWidth, height: viewHeight } =
        container.getBoundingClientRect();
      if (!viewWidth || !viewHeight) return false;

      // Zoom in as far as showing the whole card allows, capped at 1:1.
      const zoom = Math.min(
        FOCUS_MAX_ZOOM,
        Math.max(
          FOCUS_MIN_ZOOM,
          Math.min(
            (viewWidth * FOCUS_VIEWPORT_RATIO) / box.width,
            (viewHeight * FOCUS_VIEWPORT_RATIO) / box.height,
          ),
        ),
      );

      setCenter(box.x + box.width / 2, box.y + box.height / 2, {
        zoom,
        duration: FOCUS_DURATION,
      });
      return true;
    },
    [setCenter, nodesRef],
  );

  // Centre the newest node once it has been measured and laid out.
  useEffect(() => {
    if (!nodesInitialized) return;
    const targetId = pendingFocusRef.current;
    if (!targetId || !autoFollowRef.current) return;
    if (focusNode(targetId)) {
      pendingFocusRef.current = null;
      focusedNodeIdRef.current = targetId;
    }
  }, [nodes, nodesInitialized, focusNode]);

  // Deselect node if it no longer exists
  useEffect(() => {
    if (selectedNodeId && !nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [nodes, selectedNodeId]);

  // Re-frame when the container is resized (sidebar toggle, browser reflow, etc.)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (nodesRef.current.length === 0) return;
        // Preserve whichever framing is in effect rather than always refitting.
        if (autoFollowRef.current && focusedNodeIdRef.current) {
          if (focusNode(focusedNodeIdRef.current)) return;
        }
        fitView(fitViewOptions);
      }, 200);
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [fitView, focusNode, nodesRef]);

  // React Flow passes a null event for viewport moves we triggered ourselves,
  // so a real event here means the user panned/zoomed and owns the view now.
  const onMoveStart = useCallback<OnMove>((event) => {
    if (!event) return;
    autoFollowRef.current = false;
    pendingFocusRef.current = null;
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<ChatGraphNodeType>[]) => {
      changes.forEach((change) => {
        if (change.type === "position" && change.dragging) {
          draggedNodeIds.current.add(change.id);
        }
      });
      setNodes((nds) => applyNodeChanges(changes, nds) as ChatGraphNodeType[]);
    },
    [],
  );

  const selectedNode = useMemo<ChatGraphNodeType | undefined>(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId],
  );

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setSelectedNodeId((current) => (current === node.id ? null : node.id));
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {nodes.length === 0 && (
        <div className="absolute inset-0 z-10 flex h-full w-full items-center justify-center text-sm text-muted-foreground bg-background/60 backdrop-blur-xs pointer-events-none">
          {t("emptyState")}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={derived.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onMoveStart={onMoveStart}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        minZoom={0.005}
        maxZoom={50}
        fitView
        fitViewOptions={fitViewOptions}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={false}
      >
        <Background gap={20} size={1} color="var(--color-border, #cbd5e1)" />
        <Controls
          showInteractive={false}
          className="bg-card border border-border shadow-md rounded-lg"
        />
        {selectedNode && (
          <Panel position="top-right">
            <ChatGraphPanel
              data={selectedNode.data}
              onClose={() => setSelectedNodeId(null)}
            />
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

export function ChatGraphCanvas({ messages }: { messages: UIMessage[] }) {
  return (
    <ReactFlowProvider>
      <ChatGraphCanvasInner messages={messages} />
    </ReactFlowProvider>
  );
}
