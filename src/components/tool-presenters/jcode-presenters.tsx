"use client";

import { cn } from "lib/utils";
import {
  CalendarIcon,
  ClockIcon,
  GlobeIcon,
  InboxIcon,
  LayoutIcon,
  Link2Icon,
  MonitorIcon,
  ServerIcon,
  WrenchIcon,
} from "lucide-react";
import { parseToolTiming } from "lib/ai/tools/timing";
import type { PresenterProps, ToolPresenter } from "./types";

/* ------------------------------------------------------------------ */
/* Web: websearch, webfetch, browser                                  */
/* ------------------------------------------------------------------ */

const websearch: ToolPresenter = {
  glance: ({ input, status }) => {
    const q = input?.query ?? "";
    if (status === "pending") return `searching the web for "${q}"…`;
    if (status === "error") return `web search failed`;
    return `websearch · "${q}"`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Web search</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          <div className="font-mono text-primary font-medium">"{input?.query ?? ""}"</div>
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Web search · "{input?.query ?? ""}"</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "search failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const webfetch: ToolPresenter = {
  glance: ({ input, status }) => {
    const url = input?.url ?? "";
    if (status === "pending") return `fetching ${url}…`;
    if (status === "error") return `failed to fetch ${url}`;
    return `webfetch · ${url}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Fetch URL</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          <div className="font-mono text-primary truncate">{input?.url ?? ""}</div>
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium truncate">{input?.url ?? "Fetch URL"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "fetch failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const browser: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "act";
    const desc = input?.goal ?? input?.url ?? "browser task";
    if (status === "pending") return `browser (${action}) · ${desc}…`;
    if (status === "error") return `⚠ browser (${action}) failed`;
    return `browser (${action}) · ${desc}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Browser · {input?.action ?? "session"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {input?.goal ? <div className="text-primary">{input.goal}</div> : null}
          {input?.url ? <div className="font-mono text-[11px] text-muted-foreground">{input.url}</div> : null}
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Browser · {input?.action ?? "session"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {input?.goal ? <div className="text-primary font-medium">{input.goal}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "browser failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

/* ------------------------------------------------------------------ */
/* MCP: mcp, mcp_search, mcp_call                                     */
/* ------------------------------------------------------------------ */

const mcp: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "manage";
    const server = input?.server ? ` · ${input.server}` : "";
    if (status === "pending") return `mcp (${action})${server}…`;
    if (status === "error") return `mcp (${action}) failed`;
    return `mcp (${action})${server}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">MCP {input?.action ? `· ${input.action}` : ""}</span>
          {input?.server ? <span className="font-mono text-primary">{input.server}</span> : null}
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">MCP {input?.action ? `· ${input.action}` : ""}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground text-[11px]">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const mcpCall: ToolPresenter = {
  glance: ({ input, status }) => {
    const s = input?.server ?? "mcp";
    const t = input?.tool ?? "tool";
    if (status === "pending") return `calling ${s}/${t}…`;
    if (status === "error") return `⚠ ${s}/${t} failed`;
    return `${s}/${t}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium font-mono text-primary">
            {input?.server ?? "mcp"}/{input?.tool ?? "tool"}
          </span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium font-mono text-primary">
            {input?.server ?? "mcp"}/{input?.tool ?? "tool"}
          </span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground text-[11px]">{input.intent}</div> : null}
          {input?.arguments ? (
            <pre className="max-h-40 overflow-auto font-mono text-[11px] bg-muted/30 p-2 rounded">
              {JSON.stringify(input.arguments, null, 2)}
            </pre>
          ) : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const mcpSearch: ToolPresenter = {
  glance: ({ input, status }) => {
    const q = input?.query ?? "";
    if (status === "pending") return `searching mcp tools for "${q}"…`;
    if (status === "error") return `mcp tool search failed`;
    return `mcp_search · "${q}"`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">MCP search · "{input?.query ?? ""}"</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">MCP search · "{input?.query ?? ""}"</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground text-[11px]">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

/* ------------------------------------------------------------------ */
/* Native UI & Apps: applet, panel, side_panel, schedule, gmail, cal  */
/* ------------------------------------------------------------------ */

const applet: ToolPresenter = {
  glance: ({ input, status }) => {
    const title = input?.title ?? input?.action ?? "native ui";
    if (status === "pending") return `applet (${title})…`;
    if (status === "error") return `applet failed`;
    return `applet · ${title}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <LayoutIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Applet · {input?.title ?? input?.action ?? "ui"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <LayoutIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Applet · {input?.title ?? input?.action ?? "ui"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground text-[11px]">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const schedule: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "create";
    const task = input?.task ? `: ${input.task.slice(0, 32)}` : "";
    if (status === "pending") return `schedule (${action})${task}…`;
    if (status === "error") return `schedule failed`;
    return `schedule (${action})${task}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Schedule · {input?.action ?? "task"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-1">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {input?.task ? <div className="text-primary font-medium">{input.task}</div> : null}
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Schedule · {input?.action ?? "task"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {input?.task ? <div className="text-primary font-medium">{input.task}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const gmail: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "mail";
    if (status === "pending") return `gmail (${action})…`;
    if (status === "error") return `gmail failed`;
    return `gmail (${action})${input?.query ? ` · "${input.query}"` : ""}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <InboxIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Gmail · {input?.action ?? "mail"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <InboxIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Gmail · {input?.action ?? "mail"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

const calendar: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "calendar";
    if (status === "pending") return `calendar (${action})…`;
    if (status === "error") return `calendar failed`;
    return `calendar (${action})${input?.query ? ` · "${input.query}"` : ""}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Calendar · {input?.action ?? "event"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        {input?.intent ? <div className="px-3 py-2 text-muted-foreground">{input.intent}</div> : null}
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : JSON.stringify(output, null, 2);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <CalendarIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Calendar · {input?.action ?? "event"}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : clean ? (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          ) : null}
        </div>
      </div>
    );
  },
};

export const jcodePresenters = {
  websearch,
  webfetch,
  browser,
  mcp,
  mcp_call: mcpCall,
  mcp_search: mcpSearch,
  applet,
  panel: applet,
  side_panel: applet,
  schedule,
  gmail,
  calendar,
};
