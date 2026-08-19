"use client";

import { BarChart } from "@/components/tool-invocation/bar-chart";
import { InteractiveTable } from "@/components/tool-invocation/interactive-table";
import { LineChart } from "@/components/tool-invocation/line-chart";
import { PieChart } from "@/components/tool-invocation/pie-chart";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  ChatGraphNodeKind,
  ChatGraphNode as ChatGraphNodeType,
} from "app-types/chat-graph";
import { DefaultToolName } from "lib/ai/tools";
import { cn } from "lib/utils";
import {
  BarChart3Icon,
  BotIcon,
  CheckCircle2Icon,
  ClipboardListIcon,
  FileTextIcon,
  GlobeIcon,
  InfoIcon,
  Loader2Icon,
  MessagesSquareIcon,
  PauseIcon,
  PlayIcon,
  PlugIcon,
  TerminalIcon,
  TriangleAlertIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { memo } from "react";
import { useChatGraphActions } from "./chat-graph-actions";
import {
  DiffEditorViewCompact,
  sectionsFromEditOutput,
} from "ui/diff-editor-view";
import { TerminalWindowCompact } from "ui/terminal-window";

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
    label: "TERMINAL",
    icon: TerminalIcon,
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
  // Amber, matching the approval card and the pending-plan tint everywhere
  // else. A user learns one colour for "this is waiting on me" and finds it
  // in the graph without being taught the graph separately.
  gate: {
    label: "REVIEW",
    icon: FileTextIcon,
    badgeBg:
      "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    borderColor: "border-amber-500/40",
    accentBg: "bg-amber-500",
  },
  summary: {
    label: "WALKTHROUGH",
    icon: ClipboardListIcon,
    badgeBg:
      "bg-teal-500/10 text-teal-600 dark:text-teal-400 border-teal-500/30",
    borderColor: "border-teal-500/40",
    accentBg: "bg-teal-500",
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

const EDIT_TOOL_NAMES: string[] = [
  DefaultToolName.EditFile,
  DefaultToolName.MultiEdit,
];

export const ChatGraphNode = memo(function ChatGraphNode({
  data,
  selected,
}: Props) {
  const config = KIND_CONFIG[data.kind] || KIND_CONFIG.tool;
  const Icon = config.icon;
  const isChart = data.kind === "chart";
  const actions = useChatGraphActions();

  const handleStyle = cn(
    "h-3! w-3! border-2! border-background! transition-colors",
    data.status === "fail" && "bg-destructive!",
    data.status === "running" && "bg-blue-500!",
    data.status === "waiting" && "bg-amber-500!",
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
        // A slow breathe rather than the running pulse, and a different
        // colour: the two states must not be told apart only by tempo. Under
        // reduced motion it goes static and the amber border carries it --
        // the information is the colour, the motion only draws the eye.
        data.status === "waiting" &&
          "border-amber-500/80 motion-safe:animate-[pulse_2s_ease-in-out_infinite]",
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
          ) : data.status === "waiting" ? (
            // Not a spinner. The run is stopped, and the thing it is stopped
            // on is the reader.
            <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400 text-[11px] font-medium">
              <PauseIcon className="size-3.5" />
              <span className="hidden sm:inline">Your review</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-emerald-500 text-[11px] font-medium">
              <CheckCircle2Icon className="size-3.5" />
            </div>
          )}
        </div>
      </div>

      {/* Main Card Content */}
      <div
        className={cn(
          "flex flex-col gap-2 text-xs",
          data.kind === "code" ? "p-0" : "p-3.5",
        )}
      >
        {data.kind !== "code" && (
          <div
            className="font-semibold text-foreground truncate px-3.5 pt-3.5"
            title={data.label}
          >
            {data.label}
          </div>
        )}

        {/* Text snippet for prompt/llm/response */}
        {(data.kind === "prompt" ||
          data.kind === "response" ||
          data.kind === "llm") &&
          data.text && (
            <div className="rounded-md border border-border/40 bg-muted/30 p-2.5 mx-3.5 text-muted-foreground line-clamp-3 leading-relaxed">
              {data.text}
            </div>
          )}

        {/* The halted plan. Both actions are here as well as in the artifact
            header and the chat card, because the user may be watching any of
            the three when they decide -- and the one they are watching when
            the run stops is usually this one. */}
        {data.kind === "gate" && (
          <div className="flex flex-col gap-2 px-3.5 pb-3.5">
            {data.status === "waiting" ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                The run is paused here until you answer.
              </p>
            ) : data.status === "running" ? (
              // Not yet suspended -- the model is still writing the plan's
              // arguments. `data.output` does not exist yet at this point, so
              // falling through to the answered branch would read it as
              // undefined and render "Approved." on a plan nobody has seen.
              <p className="flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground">
                <span className="inline-block size-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse" />
                Writing the plan…
              </p>
            ) : (
              <p className="text-[11px] leading-snug text-muted-foreground">
                {(data.output as { decision?: string } | undefined)
                  ?.decision === "revise"
                  ? "Returned for revision."
                  : "Approved."}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.openArtifact?.("plan");
                }}
                className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-[120ms] ease-[var(--ease-out)] hover:bg-muted"
              >
                <MessagesSquareIcon className="size-3" />
                Review
              </button>
              {data.status === "waiting" && (
                <button
                  type="button"
                  disabled={actions.busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (data.toolCallId) actions.proceedWithPlan?.(data.toolCallId);
                  }}
                  className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-transform duration-[160ms] ease-[var(--ease-out)] active:scale-[0.97] disabled:opacity-50"
                >
                  <PlayIcon className="size-3" />
                  Proceed
                </button>
              )}
            </div>
          </div>
        )}

        {data.kind === "summary" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.openArtifact?.("walkthrough");
            }}
            className="mx-3.5 mb-3.5 rounded-md border border-border/40 bg-muted/30 p-2.5 text-left leading-relaxed text-muted-foreground transition-colors duration-[120ms] ease-[var(--ease-out)] hover:bg-muted/60"
          >
            {data.status === "running" && (
              <span className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <span className="inline-block size-1.5 shrink-0 rounded-full bg-amber-500 motion-safe:animate-pulse" />
                Writing…
              </span>
            )}
            <span className="line-clamp-3">
              {/* Falls back to the streaming input's summary before the
                  output exists, matching the walkthrough artifact/card. */}
              {(data.output as { summary?: string } | undefined)?.summary ??
                (data.input as { summary?: string } | undefined)?.summary ??
                "Walkthrough"}
            </span>
          </button>
        )}

        {/* An edit_file/multi_edit node IS a diff, the same way a code node
            IS a shell terminal below -- clicking it opens the full
            side-by-side view in the big popup instead of the raw
            old_string/new_string arguments FieldStack would otherwise dump. */}
        {data.kind === "tool" &&
        data.toolName &&
        EDIT_TOOL_NAMES.includes(data.toolName) ? (
          <div className="px-3.5 pb-3.5">
            <DiffEditorViewCompact
              path={
                (data.output as { path?: string } | undefined)?.path ??
                (data.input as { path?: string } | undefined)?.path ??
                data.label
              }
              {...sectionsFromEditOutput(data.output)}
              added={
                (data.output as { added?: number } | undefined)?.added ?? 0
              }
              removed={
                (data.output as { removed?: number } | undefined)?.removed ?? 0
              }
              status={
                data.status === "fail"
                  ? "error"
                  : data.status === "running"
                    ? "pending"
                    : "success"
              }
              errorText={data.errorText}
            />
          </div>
        ) : (
          (data.kind === "tool" || data.kind === "http") && (
            <div className="px-3.5 pb-3.5">
              <FieldStack input={data.input} />
            </div>
          )
        )}

        {/* The node itself IS a terminal for code/shell execution nodes;
            clicking anywhere on it opens the full terminal in a big popup. */}
        {data.kind === "code" && (
          <TerminalWindowCompact
            className="rounded-none rounded-b-[10px] border-0 -mt-px"
            command={
              (data.input as { command?: string } | undefined)?.command ??
              data.label
            }
            cwd={(data.output as { cwd?: string } | undefined)?.cwd}
            status={
              data.status === "fail"
                ? "error"
                : data.status === "running"
                  ? "pending"
                  : "success"
            }
            exitCode={
              (data.output as { exit_code?: number } | undefined)?.exit_code
            }
            output={
              (data.output as { output?: string } | undefined)?.output ??
              data.errorText
            }
          />
        )}

        {/* Interactive Chart preview inside node */}
        {isChart && data.status === "success" && (
          <div className="mt-2 rounded-lg border border-border/50 bg-background/50 p-2 overflow-hidden mx-3.5 mb-3.5">
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
