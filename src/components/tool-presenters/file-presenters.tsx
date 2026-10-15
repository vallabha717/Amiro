"use client";

import { cn } from "lib/utils";
import {
  FileIcon,
  FilePlusIcon,
  FolderIcon,
  PencilIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  DiffEditorView,
  DiffEditorViewCompact,
  sectionsFromEditOutput,
} from "ui/diff-editor-view";
import { usePresenterSurface } from "./surface";
import type { PresenterProps, ToolPresenter } from "./types";

/** Trailing path segment, for glance lines that must stay short. */
function baseName(p?: string) {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function Shell({
  icon: Icon,
  title,
  tone = "default",
  children,
}: {
  icon: typeof FileIcon;
  title: string;
  tone?: "default" | "error" | "warn";
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "w-full rounded-lg border bg-card text-card-foreground overflow-hidden",
        tone === "error" && "border-destructive/50",
        tone === "warn" && "border-amber-500/40",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        />
        <span className="text-xs font-medium truncate">{title}</span>
      </div>
      {children ? <div className="px-3 py-2 text-xs">{children}</div> : null}
    </div>
  );
}

function ErrorBody({ errorText }: { errorText?: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words text-destructive text-xs font-mono">
      {errorText || "failed"}
    </pre>
  );
}

/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */

const readFile: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const path = output?.path ?? input?.path ?? "";
    if (status === "pending") return `reading ${baseName(path)}…`;
    if (status === "error") return `failed to read ${baseName(path)}`;
    const total = output?.total_lines ?? 0;
    return output?.truncated
      ? `${path} · lines ${output.start_line}-${output.end_line} of ${total}`
      : `${path} · ${total} lines`;
  },
  Compact: ({ input, output, status, errorText }: PresenterProps) => {
    const path = output?.path ?? input?.path ?? "";
    return (
      <Shell
        icon={FileIcon}
        title={path}
        tone={status === "error" ? "error" : "default"}
      >
        {status === "error" ? (
          <ErrorBody errorText={errorText} />
        ) : status === "pending" ? (
          <span className="text-muted-foreground">reading…</span>
        ) : (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>{output?.total_lines ?? 0} lines</span>
            {output?.truncated ? (
              <span className="rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5">
                truncated
              </span>
            ) : null}
          </div>
        )}
      </Shell>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => {
    const path = output?.path ?? input?.path ?? "";
    return (
      <Shell
        icon={FileIcon}
        title={path}
        tone={status === "error" ? "error" : "default"}
      >
        {status === "error" ? (
          <ErrorBody errorText={errorText} />
        ) : status === "pending" ? (
          <span className="text-muted-foreground">reading…</span>
        ) : (
          <>
            {output?.notice ? (
              <div className="mb-2 text-amber-600 dark:text-amber-400">
                {output.notice}
              </div>
            ) : null}
            <pre className="max-h-80 overflow-auto font-mono text-xs leading-relaxed whitespace-pre">
              {output?.content ?? ""}
            </pre>
          </>
        )}
      </Shell>
    );
  },
};

/* ------------------------------------------------------------------ */
/* list_dir                                                            */
/* ------------------------------------------------------------------ */

const listDir: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const path = output?.path ?? input?.path ?? ".";
    if (status === "pending") return `listing ${path}…`;
    if (status === "error") return `failed to list ${path}`;
    const n = (output?.file_count ?? 0) + (output?.dir_count ?? 0);
    return `${path}/ · ${n} ${n === 1 ? "entry" : "entries"}`;
  },
  Compact: ({ input, output, status, errorText }: PresenterProps) => (
    <Shell
      icon={FolderIcon}
      title={output?.path ?? input?.path ?? "."}
      tone={status === "error" ? "error" : "default"}
    >
      {status === "error" ? (
        <ErrorBody errorText={errorText} />
      ) : (
        <span className="text-muted-foreground">
          {output?.dir_count ?? 0} dirs · {output?.file_count ?? 0} files
        </span>
      )}
    </Shell>
  ),
  Expanded: ({ input, output, status, errorText }: PresenterProps) => (
    <Shell
      icon={FolderIcon}
      title={output?.path ?? input?.path ?? "."}
      tone={status === "error" ? "error" : "default"}
    >
      {status === "error" ? (
        <ErrorBody errorText={errorText} />
      ) : (
        <>
          {output?.notice ? (
            <div className="mb-2 text-amber-600 dark:text-amber-400">
              {output.notice}
            </div>
          ) : null}
          <ul className="max-h-72 overflow-auto font-mono text-xs space-y-0.5">
            {(output?.entries ?? []).map((e: any) => (
              <li key={e.path} className="flex items-center gap-1.5">
                {e.is_dir ? (
                  <FolderIcon className="size-3 text-muted-foreground shrink-0" />
                ) : (
                  <FileIcon className="size-3 text-muted-foreground shrink-0" />
                )}
                <span className="truncate">{e.path}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Shell>
  ),
};

/* ------------------------------------------------------------------ */
/* glob                                                                */
/* ------------------------------------------------------------------ */

const glob: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const pattern = output?.pattern ?? input?.pattern ?? "";
    if (status === "pending") return `matching ${pattern}…`;
    if (status === "error") return `glob failed: ${pattern}`;
    const n = output?.count ?? 0;
    return `${pattern} · ${n} ${n === 1 ? "match" : "matches"}`;
  },
  Compact: ({ input, output, status, errorText }: PresenterProps) => {
    const n = output?.count ?? 0;
    return (
      <Shell
        icon={SearchIcon}
        title={output?.pattern ?? input?.pattern ?? "glob"}
        tone={status === "error" ? "error" : n === 0 ? "warn" : "default"}
      >
        {status === "error" ? (
          <ErrorBody errorText={errorText} />
        ) : (
          <div className="space-y-0.5 font-mono text-muted-foreground">
            <div>
              {n} {n === 1 ? "match" : "matches"}
            </div>
            {(output?.matches ?? []).slice(0, 3).map((m: any) => (
              <div key={m.path} className="truncate">
                {m.path}
              </div>
            ))}
          </div>
        )}
      </Shell>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => (
    <Shell
      icon={SearchIcon}
      title={output?.pattern ?? input?.pattern ?? "glob"}
      tone={
        status === "error"
          ? "error"
          : (output?.count ?? 0) === 0
            ? "warn"
            : "default"
      }
    >
      {status === "error" ? (
        <ErrorBody errorText={errorText} />
      ) : (
        <ul className="max-h-72 overflow-auto font-mono text-xs space-y-0.5">
          {(output?.matches ?? []).map((m: any) => (
            <li key={m.path} className="truncate">
              {m.path}
            </li>
          ))}
          {(output?.count ?? 0) === 0 ? (
            <li className="text-muted-foreground">no files matched</li>
          ) : null}
        </ul>
      )}
    </Shell>
  ),
};

/* ------------------------------------------------------------------ */
/* grep                                                                */
/* ------------------------------------------------------------------ */

const grep: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const pattern = output?.pattern ?? input?.pattern ?? "";
    if (status === "pending") return `searching for "${pattern}"…`;
    if (status === "error") return `grep failed: ${pattern}`;
    const hits = output?.count ?? 0;
    const files = output?.file_count ?? 0;
    if (hits === 0) return `"${pattern}" · no matches`;
    return `"${pattern}" · ${hits} ${hits === 1 ? "hit" : "hits"} in ${files} ${
      files === 1 ? "file" : "files"
    }`;
  },
  Compact: ({ input, output, status, errorText }: PresenterProps) => {
    const hits = output?.count ?? 0;
    return (
      <Shell
        icon={SearchIcon}
        title={`"${output?.pattern ?? input?.pattern ?? ""}"`}
        tone={status === "error" ? "error" : hits === 0 ? "warn" : "default"}
      >
        {status === "error" ? (
          <ErrorBody errorText={errorText} />
        ) : (
          <div className="space-y-0.5 text-muted-foreground">
            <div>
              {hits} in {output?.file_count ?? 0} files
            </div>
            {(output?.hits ?? []).slice(0, 2).map((h: any, i: number) => (
              <div key={i} className="truncate font-mono">
                {h.path}:{h.line}
              </div>
            ))}
          </div>
        )}
      </Shell>
    );
  },
  Expanded: ({ input, output, status, errorText }: PresenterProps) => (
    <Shell
      icon={SearchIcon}
      title={`"${output?.pattern ?? input?.pattern ?? ""}"`}
      tone={
        status === "error"
          ? "error"
          : (output?.count ?? 0) === 0
            ? "warn"
            : "default"
      }
    >
      {status === "error" ? (
        <ErrorBody errorText={errorText} />
      ) : (
        <div className="max-h-80 overflow-auto space-y-2 font-mono text-xs">
          {(output?.hits ?? []).map((h: any, i: number) => (
            <div key={i}>
              <div className="text-muted-foreground">
                {h.path}:{h.line}
              </div>
              <pre className="whitespace-pre-wrap break-words">{h.text}</pre>
            </div>
          ))}
          {(output?.count ?? 0) === 0 ? (
            <div className="text-muted-foreground">no matches</div>
          ) : null}
        </div>
      )}
    </Shell>
  ),
};

/* ------------------------------------------------------------------ */
/* write_file                                                          */
/* ------------------------------------------------------------------ */

const writeFile: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const path = output?.path ?? input?.path ?? "";
    if (status === "pending") return `writing ${baseName(path)}…`;
    if (status === "error") return `failed to write ${baseName(path)}`;
    const verb = output?.created ? "created" : "overwrote";
    return `${verb} ${path} · ${output?.lines ?? 0} lines`;
  },
  Compact: ({ input, output, status, errorText }: PresenterProps) => (
    <Shell
      icon={FilePlusIcon}
      title={output?.path ?? input?.path ?? ""}
      tone={status === "error" ? "error" : "default"}
    >
      {status === "error" ? (
        <ErrorBody errorText={errorText} />
      ) : (
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded px-1.5 py-0.5",
              output?.created
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
            )}
          >
            {output?.created ? "created" : "overwrote"}
          </span>
          <span className="text-muted-foreground">
            {output?.lines ?? 0} lines
          </span>
        </div>
      )}
    </Shell>
  ),
};
writeFile.Expanded = writeFile.Compact;

/* ------------------------------------------------------------------ */
/* edit_file / multi_edit                                              */
/* ------------------------------------------------------------------ */

/**
 * The diff strip. This is the single most important thing on the page.
 *
 * edit_file is the only tool that can silently corrupt work, so its result
 * has to be readable in one glance while scrolling a long run -- +N/-M in
 * colour, and a failure that is impossible to skim past.
 */
function DiffStrip({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
      <span className="text-destructive">−{removed}</span>
    </span>
  );
}

function EditBody({ output, status, errorText }: PresenterProps) {
  if (status === "error") {
    return (
      <div className="flex items-start gap-2">
        <TriangleAlertIcon className="size-4 text-destructive shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="font-medium text-destructive">edit not applied</div>
          <pre className="whitespace-pre-wrap break-words text-xs text-destructive/90 mt-1">
            {errorText || "the anchor did not match"}
          </pre>
        </div>
      </div>
    );
  }
  if (status === "pending") {
    return <span className="text-muted-foreground">applying edit…</span>;
  }
  return (
    <div className="space-y-2">
      <DiffStrip added={output?.added ?? 0} removed={output?.removed ?? 0} />
    </div>
  );
}

/**
 * The detail surface's rendering of an edit: the full side-by-side diff, with
 * its own maximize-to-popup affordance. The chat surface never reaches this
 * -- see EditExpanded -- because the row above it in the work log already
 * names the file and the counts; this is where reading the actual patch
 * happens.
 */
function EditDetail({
  input,
  output,
  status,
  errorText,
  note,
}: PresenterProps & { note?: string }) {
  const { sections, windowed } = sectionsFromEditOutput(output);
  return (
    <DiffEditorView
      path={output?.path ?? input?.path ?? ""}
      sections={sections}
      windowed={windowed}
      added={output?.added ?? 0}
      removed={output?.removed ?? 0}
      status={status}
      errorText={errorText}
      note={note}
    />
  );
}

/**
 * The chat surface's rendering of an edit: the same compact, colored +N/-M
 * card the detail surface uses, with its own click-to-expand side-by-side
 * diff dialog -- there is no reason a reader should have to leave the
 * conversation to see what changed.
 */
function EditExpanded(props: PresenterProps & { note?: string }) {
  const surface = usePresenterSurface();
  if (surface === "detail") {
    return <EditDetail {...props} />;
  }
  const { input, output, status, errorText, note } = props;
  const { sections, windowed } = sectionsFromEditOutput(output);
  return (
    <DiffEditorViewCompact
      path={output?.path ?? input?.path ?? ""}
      sections={sections}
      windowed={windowed}
      added={output?.added ?? 0}
      removed={output?.removed ?? 0}
      status={status}
      errorText={errorText}
      note={note}
    />
  );
}

const editFile: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const path = output?.path ?? input?.path ?? "";
    if (status === "pending") return `editing ${baseName(path)}…`;
    // Loud on purpose: a failed anchor is the one outcome a reviewer
    // scanning a long run must never scroll past.
    if (status === "error") return `⚠ edit failed · ${baseName(path)}`;
    return `${path} · +${output?.added ?? 0} −${output?.removed ?? 0}`;
  },
  Compact: (props: PresenterProps) => (
    <Shell
      icon={PencilIcon}
      title={props.output?.path ?? props.input?.path ?? ""}
      tone={props.status === "error" ? "error" : "default"}
    >
      <EditBody {...props} />
    </Shell>
  ),
};
editFile.Expanded = EditExpanded;

const multiEdit: ToolPresenter = {
  glance: ({ input, output, status }) => {
    const path = output?.path ?? input?.path ?? "";
    const n = output?.edits?.length ?? input?.edits?.length ?? 0;
    if (status === "pending") return `editing ${baseName(path)}…`;
    if (status === "error")
      return `⚠ ${n} edits not applied · ${baseName(path)}`;
    return `${path} · ${n} edits · +${output?.added ?? 0} −${output?.removed ?? 0}`;
  },
  Compact: (props: PresenterProps) => {
    const n = props.output?.edits?.length ?? props.input?.edits?.length ?? 0;
    return (
      <Shell
        icon={PencilIcon}
        title={`${props.output?.path ?? props.input?.path ?? ""} · ${n} edits`}
        tone={props.status === "error" ? "error" : "default"}
      >
        <EditBody {...props} />
        {props.status === "error" ? (
          <div className="mt-2 text-xs text-muted-foreground">
            multi_edit is atomic — no edit in this batch was written.
          </div>
        ) : null}
      </Shell>
    );
  },
};
multiEdit.Expanded = (props: PresenterProps) => (
  <EditExpanded
    {...props}
    note={
      props.status === "error"
        ? "multi_edit is atomic — no edit in this batch was written."
        : undefined
    }
  />
);

export const filePresenters = {
  read_file: readFile,
  list_dir: listDir,
  glob,
  grep,
  write_file: writeFile,
  edit_file: editFile,
  multi_edit: multiEdit,
};
