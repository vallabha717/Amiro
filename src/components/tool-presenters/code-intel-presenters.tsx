"use client";

import { cn } from "lib/utils";
import {
  AlertTriangleIcon,
  BrainIcon,
  CheckCircle2Icon,
  CrosshairIcon,
  MapIcon,
} from "lucide-react";
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
        {entries.map((e: any) => (
          <div key={e.id} className="leading-relaxed">
            {e.text}
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
  return <span className="text-muted-foreground text-xs">…</span>;
}

const memory: ToolPresenter = {
  glance: ({ input, output, status }) => {
    if (status === "error") return "memory failed";
    if (input?.text !== undefined) {
      const verb = output?.updated ? "reinforced" : "remembered";
      return `${verb}: ${String(input.text).slice(0, 60)}`;
    }
    if (output?.removed !== undefined) {
      return output.removed ? "forgot a note" : "no such note";
    }
    const n = output?.entries?.length ?? 0;
    return `${n} note${n === 1 ? "" : "s"}`;
  },
  Compact: (props: PresenterProps) => (
    <div className="w-full rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">
          {props.input?.text !== undefined
            ? "Remember about this workspace"
            : props.input?.id !== undefined
              ? "Forget a note"
              : "Workspace notes"}
        </span>
      </div>
      <div className="px-3 py-2">
        <MemoryBody {...props} />
      </div>
    </div>
  ),
};
memory.Expanded = memory.Compact;

export const codeIntelPresenters = {
  repo_map: repoMap,
  lsp,
  memory_write: memory,
  memory_read: memory,
  memory_forget: memory,
};
