"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  BarChart3Icon,
  BotIcon,
  CheckCircle2Icon,
  Code2Icon,
  FileTextIcon,
  GlobeIcon,
  InfoIcon,
  Loader2Icon,
  PlugIcon,
  TriangleAlertIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "lib/utils";
import {
  ChatGraphNode as ChatGraphNodeType,
  ChatGraphNodeKind,
} from "app-types/chat-graph";
import { PieChart } from "@/components/tool-invocation/pie-chart";
import { BarChart } from "@/components/tool-invocation/bar-chart";
import { LineChart } from "@/components/tool-invocation/line-chart";
import { InteractiveTable } from "@/components/tool-invocation/interactive-table";
import { DefaultToolName } from "lib/ai/tools";

type Props = NodeProps<ChatGraphNodeType>;

interface NodeConfig {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badgeBg: string;
  borderColor: string;
  accentBg: string;
}

const KIND_CONFIG: Record<ChatGraphNodeKind, NodeConfig> = {
  prompt: {
    label: "INPUT",
    icon: UserIcon,
    badgeBg:
      "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
    borderColor: "border-blue-500/40",
    accentBg: "bg-blue-500",
  },
  llm: {
    label: "INFO",
    icon: InfoIcon,
    badgeBg: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30",
    borderColor: "border-sky-500/40",
    accentBg: "bg-sky-500",
  },
  tool: {
    label: "TOOL",
    icon: WrenchIcon,
    badgeBg:
      "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30",
    borderColor: "border-purple-500/40",
    accentBg: "bg-purple-500",
  },
  chart: {
    label: "DATA VISUALIZATION",
    icon: BarChart3Icon,
    badgeBg:
      "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
    borderColor: "border-cyan-500/40",
    accentBg: "bg-cyan-500",
  },
  code: {
    label: "CODE",
    icon: Code2Icon,
    badgeBg:
      "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    borderColor: "border-emerald-500/40",
    accentBg: "bg-emerald-500",
  },
  http: {
    label: "HTTP",
    icon: GlobeIcon,
    badgeBg:
      "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30",
    borderColor: "border-rose-500/40",
    accentBg: "bg-rose-500",
  },
  template: {
    label: "TEMPLATE",
    icon: FileTextIcon,
    badgeBg:
      "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30",
    borderColor: "border-violet-500/40",
    accentBg: "bg-violet-500",
  },
  response: {
    label: "OUTPUT",
    icon: BotIcon,
    badgeBg:
      "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30",
    borderColor: "border-green-500/40",
    accentBg: "bg-green-500",
  },
};

function ChartPreview({ toolName, input }: { toolName?: string; input: any }) {
  if (!input) return null;
  switch (toolName) {
    case DefaultToolName.CreatePieChart:
      return <PieChart {...input} />;
    case DefaultToolName.CreateBarChart:
      return <BarChart {...input} />;
    case DefaultToolName.CreateLineChart:
      return <LineChart {...input} />;
    case DefaultToolName.CreateTable:
      return <InteractiveTable {...input} />;
    default:
      return null;
  }
}

function FieldStack({ input }: { input: unknown }) {
  if (!input || typeof input !== "object") return null;
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 4);
  if (entries.length === 0) return null;

  return (
    <div className="mt-2.5 flex flex-col gap-1.5 rounded-md border border-border/50 bg-muted/40 p-2 text-xs">
      {entries.map(([key, val]) => {
        let valStr = "";
        if (typeof val === "string") valStr = val;
        else if (typeof val === "number" || typeof val === "boolean")
          valStr = String(val);
        else if (Array.isArray(val)) valStr = `[${val.length} items]`;
        else valStr = "{...}";

        return (
          <div
            key={key}
            className="flex items-center justify-between gap-2 overflow-hidden"
          >
            <span className="shrink-0 font-medium text-muted-foreground">
              {key}
            </span>
            <span className="truncate rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-foreground border border-border/40">
              {valStr}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const ChatGraphNode = memo(function ChatGraphNode({
  data,
  selected,
}: Props) {
  const config = KIND_CONFIG[data.kind] || KIND_CONFIG.tool;
  const Icon = config.icon;
  const isChart = data.kind === "chart";

  const handleStyle = cn(
    "h-3! w-3! border-2! border-background! transition-colors",
    data.status === "fail" && "bg-destructive!",
    data.status === "running" && "bg-blue-500!",
    data.status === "success" && "bg-emerald-500!",
  );

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border-2 bg-card text-card-foreground shadow-md transition-all duration-200 hover:shadow-lg",
        isChart ? "w-96" : "w-72",
        selected
          ? "ring-2 ring-primary ring-offset-2 border-primary"
          : "border-border/80",
        data.status === "fail" && "border-destructive/80",
        data.status === "running" && "border-blue-500/80 animate-pulse",
      )}
    >
      {/* Target Handles (Top & Left) */}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        className={handleStyle}
      />
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        className={handleStyle}
      />

      {/* Header Bar with Category Badge */}
      <div className="flex items-center justify-between border-b border-border/50 px-3.5 py-2.5 bg-muted/20 rounded-t-xl">
        <div className="flex items-center gap-2 overflow-hidden">
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase shrink-0",
              config.badgeBg,
            )}
          >
            <Icon className="size-3 shrink-0" />
            <span>{config.label}</span>
          </div>

          {data.isMcp && (
            <div className="flex items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-bold text-indigo-500 uppercase shrink-0">
              <PlugIcon className="size-2.5" />
              <span>MCP</span>
            </div>
          )}
        </div>

        {/* Status Indicator */}
        <div className="ml-2 shrink-0">
          {data.status === "fail" ? (
            <div className="flex items-center gap-1 text-destructive text-[11px] font-medium">
              <TriangleAlertIcon className="size-3.5" />
              <span className="hidden sm:inline">Failed</span>
            </div>
          ) : data.status === "running" ? (
            <div className="flex items-center gap-1 text-blue-500 text-[11px] font-medium">
              <Loader2Icon className="size-3.5 animate-spin" />
              <span className="hidden sm:inline">Running</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-emerald-500 text-[11px] font-medium">
              <CheckCircle2Icon className="size-3.5" />
            </div>
          )}
        </div>
      </div>

      {/* Main Card Content */}
      <div className="flex flex-col p-3.5 gap-2 text-xs">
        <div
          className="font-semibold text-foreground truncate"
          title={data.label}
        >
          {data.label}
        </div>

        {/* Text snippet for prompt/llm/response */}
        {(data.kind === "prompt" ||
          data.kind === "response" ||
          data.kind === "llm") &&
          data.text && (
            <div className="rounded-md border border-border/40 bg-muted/30 p-2.5 text-muted-foreground line-clamp-3 leading-relaxed">
              {data.text}
            </div>
          )}

        {/* Tool input fields stack */}
        {(data.kind === "tool" ||
          data.kind === "code" ||
          data.kind === "http") && <FieldStack input={data.input} />}

        {/* Interactive Chart preview inside node */}
        {isChart && data.status === "success" && (
          <div className="mt-2 rounded-lg border border-border/50 bg-background/50 p-2 overflow-hidden">
            <ChartPreview toolName={data.toolName} input={data.input} />
          </div>
        )}
      </div>

      {/* Source Handles (Bottom & Right) */}
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        className={handleStyle}
      />
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className={handleStyle}
      />
    </div>
  );
});
