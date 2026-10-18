"use client";

import { cn } from "lib/utils";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  BrainIcon,
  CheckCircle2Icon,
  CrosshairIcon,
  HistoryIcon,
  MapIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";
import { parseToolTiming } from "lib/ai/tools/timing";
import type { PresenterProps, ToolPresenter } from "./types";

/* ------------------------------------------------------------------ */
/* repo_map                                                            */
/* ------------------------------------------------------------------ */

interface MappedFile {
  path: string;
  lang?: string;
  symbols?: { name: string; kind: string; line: number }[];
}

/**
 * The map is rendered from the structured `files`, never from the `text`
 * the model reads.
 *
 * They carry the same information in two encodings on purpose: the model
 * wants the cheapest token layout of an outline, and a UI wants something
 * it can group and truncate without parsing prose back into structure.
 * Rendering the model's copy in a `<pre>` would have been less code and
 * would have made every future layout change a change to what the model
 * sees.
 */
function RepoMapBody({ input, output }: PresenterProps) {
  const files: MappedFile[] = output?.files ?? [];
  if (files.length === 0) {
    return (
      <span className="text-muted-foreground text-xs">
        {output ? "no source files found" : "mapping…"}
      </span>
    );
  }

  return (
    <div className="space-y-2">
      {files.slice(0, 24).map((f) => (
        <div key={f.path} className="text-xs">
          <div className="font-mono font-medium truncate">{f.path}</div>
          <div className="text-muted-foreground pl-3">
            {(f.symbols ?? [])
              .slice(0, 8)
              .map((s) => s.name)
              .join(", ")}
            {(f.symbols?.length ?? 0) > 8
              ? ` +${(f.symbols?.length ?? 0) - 8} more`
              : ""}
          </div>
        </div>
      ))}
      {files.length > 24 ? (
        <div className="text-[11px] text-muted-foreground">
          +{files.length - 24} more files
        </div>
      ) : null}
      {/* Skipped files change what the map means, so they are not a
          footnote the layout can drop: "37 files" and "37 files, 1,200
          skipped" describe very different repositories. */}
      {output?.skipped ? (
        <div className="text-[11px] text-muted-foreground pt-1 border-t">
          {output.skipped} files skipped (unsupported, too large, or no
          declarations)
          {output.partial ? " · the walk hit its file limit" : ""}
        </div>
      ) : null}
      {input?.focus?.length ? (
        <div className="text-[11px] text-muted-foreground">
          ranked toward: {input.focus.join(", ")}
        </div>
      ) : null}
    </div>
  );
}

const repoMap: ToolPresenter = {
  glance: ({ input, output, status }) => {
    if (status === "error") return "repo map failed";
    if (!output) return "mapping the repository…";
    const focus = input?.focus?.length ? ` · ${input.focus.join(", ")}` : "";
    return `${output.scanned ?? 0} files mapped${focus}`;
  },
  Compact: (props: PresenterProps) => (
    <div className="w-full rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <MapIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">
          Repository map
          {props.input?.path ? ` · ${props.input.path}` : ""}
        </span>
      </div>
      <div className="px-3 py-2 max-h-80 overflow-y-auto">
        <RepoMapBody {...props} />
      </div>
    </div>
  ),
};
repoMap.Expanded = repoMap.Compact;

/* ------------------------------------------------------------------ */
/* lsp                                                                 */
/* ------------------------------------------------------------------ */

const SEVERITY_STYLE: Record<string, string> = {
  error: "text-destructive",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-muted-foreground",
  hint: "text-muted-foreground",
};

function LspBody({ output, status, errorText }: PresenterProps) {
  if (status === "error") {
    return (
      <pre className="whitespace-pre-wrap break-words text-xs text-destructive font-mono">
        {errorText || "failed"}
      </pre>
    );
  }
  if (!output) {
    return <span className="text-muted-foreground text-xs">asking…</span>;
  }

  const problems = output.problems ?? [];
  const hits = output.hits ?? [];

  return (
    <div className="space-y-1 text-xs">
      {problems.map((p: any, i: number) => (
        <div key={i} className="flex items-start gap-2">
          <AlertTriangleIcon
            className={cn("size-3.5 shrink-0 mt-0.5", SEVERITY_STYLE[p.severity])}
          />
          <span className="min-w-0">
            <span className="font-mono text-muted-foreground">
              {p.path}:{p.line}
            </span>{" "}
            {p.message}
          </span>
        </div>
      ))}
      {hits.map((h: any, i: number) => (
        <div key={i} className="flex items-start gap-2">
          <span className="font-mono text-muted-foreground shrink-0">
            {h.path}:{h.line}
          </span>
          {h.text ? (
            <span className="font-mono truncate min-w-0">{h.text}</span>
          ) : null}
        </div>
      ))}
      {output.operation === "diagnostics" &&
      problems.length === 0 &&
      !output.notice ? (
        <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2Icon className="size-3.5" /> no problems
        </div>
      ) : null}
      {/* The notice is where "the server did not answer in time" lives,
          which is the opposite of "clean" and must never be styled as a
          quiet footnote. */}
      {output.notice ? (
        <div className="text-amber-600 dark:text-amber-400 pt-1">
          {output.notice}
        </div>
      ) : null}
      {output.truncated ? (
        <div className="text-[11px] text-muted-foreground">
          showing {hits.length} of {output.total}
        </div>
      ) : null}
    </div>
  );
}

const lsp: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const op = input?.operation ?? "lsp";
    const what = input?.symbol ? ` ${input.symbol}` : "";
    if (status === "error") return `${op}${what} failed`;
    if (!output) return `${op}${what}…`;

    if (op === "diagnostics") {
      const n = output.problems?.length ?? 0;
      if (output.notice?.includes("NOT a clean bill")) return "not analysed yet";
      return n === 0 ? "no problems" : `${n} problem${n === 1 ? "" : "s"}`;
    }
    const n = output.total ?? 0;
    const noun = op === "references" ? "reference" : op === "symbols" ? "symbol" : "definition";
    return `${n} ${noun}${n === 1 ? "" : "s"}${what}`;
  },
  Compact: (props: PresenterProps) => (
    <div
      className={cn(
        "w-full rounded-lg border bg-card overflow-hidden",
        props.status === "error" && "border-destructive/50",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <CrosshairIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium truncate">
          {props.input?.operation ?? "lsp"}
          {props.input?.symbol ? ` · ${props.input.symbol}` : ""}
          {props.input?.path ? ` · ${props.input.path}` : ""}
        </span>
      </div>
      <div className="px-3 py-2 max-h-72 overflow-y-auto">
        <LspBody {...props} />
      </div>
    </div>
  ),
};
lsp.Expanded = lsp.Compact;

/* ------------------------------------------------------------------ */
/* memory_write / memory_read / memory_forget                          */
/* ------------------------------------------------------------------ */

function MemoryBody({ input, output }: PresenterProps) {
  // A write shows the note itself. This is what the approval card renders,
  // and the note is the entire decision the user is being asked to make --
  // a card that showed "memory_write(1 note)" would be asking them to
  // approve something they cannot see.
  if (input?.text !== undefined) {
    return (
      <div className="space-y-1 text-xs">
        <p className="leading-relaxed">{output?.text ?? input.text}</p>
        {input.tags?.length ? (
          <div className="text-[11px] text-muted-foreground">
            {input.tags.join(" · ")}
          </div>
        ) : null}
        {output?.updated ? (
          <div className="text-[11px] text-muted-foreground">
            reinforced an existing note rather than adding a second
          </div>
        ) : null}
      </div>
    );
  }

  if (input?.content) {
    return (
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2Icon className="size-3.5 shrink-0" />
          <span>memory updated</span>
        </div>
        <div className="text-muted-foreground pl-5">{input.content}</div>
      </div>
    );
  }

  const entries = output?.entries;
  if (entries) {
    if (entries.length === 0) {
      return (
        <span className="text-muted-foreground text-xs">
          {output.notice || "no notes yet"}
        </span>
      );
    }
    return (
      <div className="space-y-1 text-xs">
        {entries.map((e: any, idx: number) => (
          <div key={e.id ?? idx} className="leading-relaxed">
            {e.text ?? (typeof e === "string" ? e : JSON.stringify(e))}
          </div>
        ))}
      </div>
    );
  }

  if (output?.removed !== undefined) {
    return (
      <span className="text-xs text-muted-foreground">
        {output.removed ? "note removed" : "no note with that id"}
      </span>
    );
  }

  if (typeof output === "string") {
    return (
      <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">
        {parseToolTiming(output).cleanText}
      </pre>
    );
  }

  return <span className="text-muted-foreground text-xs">…</span>;
}

const memory: ToolPresenter = {
  glance: ({ input, output, status }) => {
    if (status === "error") return "memory failed";
    if (input?.content !== undefined) {
      return `remembered: ${String(input.content).slice(0, 60)}`;
    }
    if (input?.text !== undefined) {
      const verb = output?.updated ? "reinforced" : "remembered";
      return `${verb}: ${String(input.text).slice(0, 60)}`;
    }
    if (input?.query !== undefined) {
      return `recall: ${String(input.query).slice(0, 60)}`;
    }
    if (output?.removed !== undefined) {
      return output.removed ? "forgot a note" : "no such note";
    }
    const n = output?.entries?.length ?? 0;
    return `${n} note${n === 1 ? "" : "s"}`;
  },
  Compact: (props: PresenterProps) => {
    const timing = parseToolTiming(props.output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium">
            {props.input?.action
              ? `Memory · ${props.input.action}`
              : props.input?.text !== undefined || props.input?.content !== undefined
                ? "Remember about this workspace"
                : props.input?.id !== undefined
                  ? "Forget a note"
                  : "Workspace notes"}
          </span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2">
          <MemoryBody {...props} />
        </div>
      </div>
    );
  },
};
memory.Expanded = memory.Compact;

const agentgrep: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const mode = input?.mode ?? "grep";
    const q = input?.query ?? input?.terms?.join(", ") ?? input?.file ?? "";
    if (status === "pending") return `agentgrep (${mode}) · "${q}"…`;
    if (status === "error") return `⚠ agentgrep failed · ${mode}`;
    const timing = parseToolTiming(output);
    const clean = typeof output === "string" ? timing.cleanText : "";
    const matchLines = clean ? clean.split("\n").filter(Boolean).length : 0;
    return `agentgrep (${mode}) · "${q}" · ${matchLines} ${matchLines === 1 ? "match" : "matches"}`;
  },
  Compact: ({ input, output, status }: PresenterProps) => {
    const mode = input?.mode ?? "grep";
    const timing = parseToolTiming(output);
    return (
      <div
        className={cn(
          "w-full rounded-lg border bg-card overflow-hidden text-xs",
          status === "error" && "border-destructive/50",
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">agentgrep</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase">
            {mode}
          </span>
          {input?.query ? (
            <span className="font-mono text-muted-foreground truncate max-w-xs">
              "{input.query}"
            </span>
          ) : null}
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 text-muted-foreground space-y-1">
          {input?.intent ? <div className="text-[11px]">{input.intent}</div> : null}
          {input?.path || input?.file || input?.glob ? (
            <div className="text-[11px] font-mono">
              target: {input.file ?? input.path ?? input.glob}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const mode = input?.mode ?? "grep";
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
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">agentgrep</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase">
            {mode}
          </span>
          {input?.query ? (
            <span className="font-mono text-muted-foreground truncate max-w-xs">
              "{input.query}"
            </span>
          ) : null}
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-[11px] text-muted-foreground">{input.intent}</div> : null}
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">
              {errorText || "search failed"}
            </pre>
          ) : clean ? (
            <pre className="max-h-80 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border leading-relaxed">
              {clean}
            </pre>
          ) : (
            <div className="text-muted-foreground">no matches</div>
          )}
        </div>
      </div>
    );
  },
};

const sessionSearch: ToolPresenter = {
  glance: ({ input, status }) => {
    const q = input?.query ?? "";
    if (status === "pending") return `searching sessions for "${q}"…`;
    if (status === "error") return `session search failed`;
    return `session search · "${q}"`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Session search</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 text-muted-foreground font-mono">
          "{input?.query ?? ""}"
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
          <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Session search · "{input?.query ?? ""}"</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2">
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          )}
        </div>
      </div>
    );
  },
};

const docsPresenter: ToolPresenter = {
  glance: ({ input, status }) => {
    const q = input?.query ?? input?.path ?? "documentation";
    if (status === "pending") return `searching docs · ${q}…`;
    if (status === "error") return `docs search failed`;
    return `docs · ${q}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <BookOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Docs</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 text-muted-foreground">
          {input?.query ?? input?.path ?? "search docs"}
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
          <BookOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Docs · {input?.query ?? input?.path ?? ""}</span>
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2">
          {status === "error" ? (
            <pre className="text-destructive font-mono whitespace-pre-wrap">{errorText || "failed"}</pre>
          ) : (
            <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap bg-muted/20 p-2 rounded border">
              {clean}
            </pre>
          )}
        </div>
      </div>
    );
  },
};

const skillPresenter: ToolPresenter = {
  glance: ({ input, status }) => {
    const action = input?.action ?? "manage";
    const name = input?.name ?? "";
    if (status === "pending") return `skill (${action}) · ${name}…`;
    if (status === "error") return `skill ${action} failed`;
    return `skill (${action}) · ${name}`;
  },
  Compact: ({ input, output }: PresenterProps) => {
    const timing = parseToolTiming(output);
    return (
      <div className="w-full rounded-lg border bg-card overflow-hidden text-xs">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
          <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">Skill · {input?.action ?? "manage"}</span>
          {input?.name ? <span className="font-mono text-primary">{input.name}</span> : null}
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
          <span className="font-medium">Skill · {input?.action ?? "manage"}</span>
          {input?.name ? <span className="font-mono text-primary">{input.name}</span> : null}
          {timing.duration ? (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-muted border text-muted-foreground">
              {timing.duration}
            </span>
          ) : null}
        </div>
        <div className="px-3 py-2 space-y-2">
          {input?.intent ? <div className="text-muted-foreground">{input.intent}</div> : null}
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

export const codeIntelPresenters = {
  repo_map: repoMap,
  lsp,
  memory_write: memory,
  memory_read: memory,
  memory_forget: memory,
  memory,
  agentgrep,
  session_search: sessionSearch,
  conversation_search: sessionSearch,
  amiro_docs: docsPresenter,
  jcode_docs: docsPresenter,
  skill_manage: skillPresenter,
  skill: skillPresenter,
};
