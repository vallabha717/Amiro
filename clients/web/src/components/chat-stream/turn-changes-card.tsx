"use client";

import type { ToolRunStatus } from "../tool-presenters/types";
import { editRowSummary } from "lib/ai/tools/step-kind";
import { cn } from "lib/utils";
import { ChevronRightIcon, FileDiffIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  type DiffSection,
  DiffEditorView,
  sectionsFromEditOutput,
} from "ui/diff-editor-view";
import { Collapse } from "../fold-card";

export interface TurnEdit {
  toolName: string;
  input: any;
  output: any;
  status: ToolRunStatus;
  errorText?: string;
}

export interface FileChange {
  path: string;
  name: string;
  dir: string;
  added: number;
  removed: number;
  created: boolean;
  failed: boolean;
  edits: TurnEdit[];
}

/**
 * The files one turn wrote, one entry per path, in the order first touched.
 * Reads and in-flight calls are left out: this is the record of what
 * changed, so it only holds edits that finished.
 */
export function collectTurnChanges(edits: TurnEdit[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const edit of edits) {
    if (edit.status === "pending") continue;
    const row = editRowSummary(edit.toolName, edit);
    if (!row) continue;
    let change = byPath.get(row.path);
    if (!change) {
      const slash = row.path.lastIndexOf("/");
      change = {
        path: row.path,
        name: row.name,
        dir: slash > 0 ? row.path.slice(0, slash) : "",
        added: 0,
        removed: 0,
        created: row.verb === "Created",
        failed: false,
        edits: [],
      };
      byPath.set(row.path, change);
    }
    if (edit.status === "error") change.failed = true;
    else {
      change.added += row.added ?? 0;
      change.removed += row.removed ?? 0;
    }
    change.edits.push(edit);
  }
  return [...byPath.values()];
}

/** Every hunk the turn wrote to one file, oldest first. */
function sectionsFor(change: FileChange): { sections: DiffSection[]; windowed: boolean } {
  const sections: DiffSection[] = [];
  let windowed = false;
  for (const edit of change.edits) {
    if (edit.status === "error") continue;
    const got = sectionsFromEditOutput(edit.output, edit.input);
    if (got.sections.length) {
      sections.push(...got.sections);
      windowed ||= got.windowed;
    } else if (typeof edit.input?.content === "string") {
      // A whole-file write: everything it wrote is new.
      sections.push({ before: "", after: edit.input.content, startLine: 1 });
    }
  }
  return { sections, windowed: windowed || change.edits.length > 1 };
}

/** GitHub-style five-block bar: the share of added vs removed lines. */
function DiffBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const green = total ? Math.round((added / total) * 5) : 0;
  return (
    <span className="flex gap-px" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn(
            "size-1.5 rounded-[1px]",
            !total
              ? "bg-muted-foreground/20"
              : i < green
                ? "bg-emerald-500"
                : "bg-destructive/80",
          )}
        />
      ))}
    </span>
  );
}

function FileRow({ change }: { change: FileChange }) {
  const t = useTranslations("ChatStream.Changes");
  const [open, setOpen] = useState(false);
  const { sections, windowed } = open ? sectionsFor(change) : { sections: [], windowed: false };
  return (
    <li data-testid="turn-change-file" className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={change.path}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        {change.failed ? (
          <TriangleAlertIcon className="size-3.5 shrink-0 text-destructive" />
        ) : null}
        <span className="shrink-0 font-medium">{change.name}</span>
        {change.created ? (
          <span className="shrink-0 rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-700 dark:text-emerald-400">
            {t("new")}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-muted-foreground">{change.dir}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{change.added}</span>
          <span className="text-destructive">−{change.removed}</span>
          <DiffBar added={change.added} removed={change.removed} />
        </span>
      </button>
      <Collapse open={open}>
        <div className="px-2 pb-2">
          {sections.length ? (
            <DiffEditorView
              path={change.path}
              sections={sections}
              windowed={windowed}
              added={change.added}
              removed={change.removed}
              status="success"
              maxBodyHeight="max-h-96"
            />
          ) : (
            <p className="px-2 py-1 text-xs text-muted-foreground">{t("noPreview")}</p>
          )}
        </div>
      </Collapse>
    </li>
  );
}

/**
 * What the turn changed, as a list of files with their line counts that
 * each open into the full diff -- the review step, one place to look
 * instead of hunting through the timeline for edit rows.
 */
export function TurnChangesCard({ changes }: { changes: FileChange[] }) {
  const t = useTranslations("ChatStream.Changes");
  if (!changes.length) return null;
  const added = changes.reduce((sum, c) => sum + c.added, 0);
  const removed = changes.reduce((sum, c) => sum + c.removed, 0);
  return (
    <section
      data-testid="turn-changes-card"
      aria-label={t("title", { count: changes.length })}
      className="overflow-hidden rounded-xl border bg-card"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <FileDiffIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{t("title", { count: changes.length })}</span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
          <span className="text-destructive">−{removed}</span>
        </span>
      </header>
      <ul className="flex flex-col divide-y">
        {changes.map((change) => (
          <FileRow key={change.path} change={change} />
        ))}
      </ul>
    </section>
  );
}
