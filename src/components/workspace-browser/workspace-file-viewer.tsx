"use client";

import { Download, FileQuestion, Lock, Pencil, Save, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { cn } from "lib/utils";
import { Button } from "ui/button";
import { Skeleton } from "ui/skeleton";
import { KIND_STYLE, KindIcon } from "./workspace-tree";
import {
  type AgentFile,
  type FileKind,
  type WorkspaceFile,
  fetchFile,
  fetchRawBlob,
  fileKind,
  formatBytes,
  formatModified,
  hasHiddenSegment,
  saveBlob,
  writeFile,
} from "./workspace-api";

export type ViewerSource =
  | { kind: "workspace"; path: string }
  | { kind: "agent"; file: AgentFile };

type ViewMode = "formatted" | "source";

/**
 * Agent-home files carry notes for the agent on lines starting with "_ "
 * (the runtime strips them from the prompt). In the formatted view they read
 * as a quiet callout instead of body text; Source shows them as written.
 */
const AGENT_NOTE = /^\s*_(\s.*)?$/;

export function agentNoteLines(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => AGENT_NOTE.test(line))
    .map((line) => line.trim().replace(/^_\s?/, ""))
    .filter(Boolean);
}

export function stripAgentNotes(content: string): string {
  return content
    .split("\n")
    .filter((line) => !AGENT_NOTE.test(line))
    .join("\n")
    .replace(/^\s+/, "");
}

function AgentNotes({ content }: { content: string }) {
  const notes = agentNoteLines(content);
  if (!notes.length) return null;
  return (
    <aside
      data-testid="workspace-agent-notes"
      className="mb-4 rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
    >
      <p className="mb-1 font-medium text-foreground/80">Notes for your agent</p>
      {notes.join(" ")}
    </aside>
  );
}

function CodeView({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return (
    <div className="flex min-w-max font-mono text-[12.5px] leading-6">
      <div
        aria-hidden="true"
        className="sticky left-0 select-none border-r border-border/60 bg-card px-3 text-right text-muted-foreground/60 tabular-nums"
      >
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="px-4 text-foreground/90">
        {lines.map((l, i) => (
          <div key={i}>{l || " "}</div>
        ))}
      </pre>
    </div>
  );
}

function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

function Segmented({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="View mode"
      data-testid="workspace-view-mode"
      className="inline-flex rounded-lg bg-muted p-0.5 text-xs"
    >
      {(["formatted", "source"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={value === m}
          data-testid={`workspace-view-${m}`}
          onClick={() => onChange(m)}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium capitalize transition-colors",
            value === m
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function Notice({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {children ? (
        <div className="max-w-xs text-xs text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}

export function WorkspaceFileViewer({
  source,
  canWrite,
  showHidden,
  onSaved,
  onDirtyChange,
}: {
  source: ViewerSource | null;
  canWrite: boolean;
  showHidden: boolean;
  onSaved: (path: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  if (!source) {
    return (
      <section
        data-testid="workspace-viewer"
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      >
        <Notice icon={FileQuestion} title="Nothing open yet">
          Select a file to view
        </Notice>
      </section>
    );
  }
  const key = source.kind === "agent" ? `agent:${source.file.name}` : source.path;
  return (
    <ViewerBody
      key={key}
      source={source}
      canWrite={canWrite}
      showHidden={showHidden}
      onSaved={onSaved}
      onDirtyChange={onDirtyChange}
    />
  );
}

function ViewerBody({
  source,
  canWrite,
  showHidden,
  onSaved,
  onDirtyChange,
}: {
  source: ViewerSource;
  canWrite: boolean;
  showHidden: boolean;
  onSaved: (path: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const isAgent = source.kind === "agent";
  // IDENTITY.md at the root is generated from the Personality page; edits
  // here would be overwritten on the next save there.
  const isManaged = isAgent || (source.kind === "workspace" && source.path === "IDENTITY.md");
  const [file, setFile] = React.useState<WorkspaceFile | null>(
    source.kind === "agent"
      ? {
          path: source.file.name,
          name: source.file.name,
          size: source.file.size,
          mimeType: "text/markdown",
          modifiedAt: source.file.modifiedAt,
          isBinary: false,
          content: source.file.content,
        }
      : null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<ViewMode>("formatted");
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);
  const path = source.kind === "workspace" ? source.path : null;

  React.useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const f = await fetchFile(path, showHidden);
        if (cancelled) return;
        setFile(f);
        if (f.isBinary && f.mimeType.startsWith("image/")) {
          const blob = await fetchRawBlob(path, { showHidden });
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setImageUrl(objectUrl);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not open file");
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  const dirty = editing && file?.content != null && draft !== file.content;
  React.useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  if (error) {
    return (
      <section
        data-testid="workspace-viewer"
        className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      >
        <div role="alert">
          <Notice icon={FileQuestion} title="Could not open file">
            {error}
          </Notice>
        </div>
      </section>
    );
  }
  if (!file) {
    return (
      <section
        data-testid="workspace-viewer"
        className="flex min-h-0 flex-col gap-3 overflow-hidden rounded-xl border border-border bg-card p-4"
        aria-busy="true"
      >
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </section>
    );
  }

  const kind: FileKind = fileKind(file.name);
  const isText = !file.isBinary && file.content != null;
  const canEdit = canWrite && !isManaged && isText && !hasHiddenSegment(file.path);
  const toggleable = isText && !editing && (kind === "markdown" || kind === "json");
  const effectiveMode: ViewMode = toggleable ? mode : "source";

  const download = async () => {
    try {
      if (isAgent) {
        saveBlob(new Blob([file.content ?? ""], { type: "text/markdown" }), file.name);
      } else {
        saveBlob(await fetchRawBlob(file.path, { download: true, showHidden }), file.name);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed");
    }
  };

  const startEdit = () => {
    setDraft(file.content ?? "");
    setEditing(true);
  };
  const discard = () => setEditing(false);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await writeFile(file.path, draft);
      setFile({ ...file, content: draft, size: res.size, modifiedAt: res.modifiedAt });
      setEditing(false);
      toast.success(`Saved ${file.name}`);
      onSaved(file.path);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  let body: React.ReactNode;
  if (editing) {
    body = (
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
          }
        }}
        spellCheck={false}
        aria-label={`Edit ${file.name}`}
        data-testid="workspace-editor"
        className="block size-full min-h-[320px] resize-none bg-transparent p-4 font-mono text-[12.5px] leading-6 text-foreground outline-none"
      />
    );
  } else if (file.isBinary && imageUrl) {
    body = (
      <div className="flex min-h-full items-center justify-center bg-muted/30 p-6">
        <img
          src={imageUrl}
          alt={file.name}
          data-testid="workspace-image"
          className="max-h-[60vh] max-w-full rounded-md border border-border bg-background object-contain shadow-sm"
        />
      </div>
    );
  } else if (file.isBinary || file.tooLarge) {
    body = (
      <Notice
        icon={FileQuestion}
        title={file.tooLarge ? "Too large to preview" : "No preview available"}
      >
        {file.mimeType} · {formatBytes(file.size)}
        <div className="mt-3">
          <Button type="button" size="sm" variant="outline" onClick={download} className="gap-1.5">
            <Download className="size-3.5" /> Download
          </Button>
        </div>
      </Notice>
    );
  } else if (isText && file.content === "") {
    body = (
      <Notice icon={FileQuestion} title="This file is empty">
        {canEdit ? "Use Edit to add some content." : null}
      </Notice>
    );
  } else if (effectiveMode === "formatted" && kind === "markdown") {
    body = (
      <div className="px-6 py-5 text-sm" data-testid="workspace-markdown">
        <AgentNotes content={file.content ?? ""} />
        <Markdown>{stripAgentNotes(file.content ?? "")}</Markdown>
      </div>
    );
  } else if (effectiveMode === "formatted" && kind === "json") {
    const pretty = prettyJson(file.content ?? "");
    body = <CodeView text={pretty ?? file.content ?? ""} />;
  } else {
    body = <CodeView text={file.content ?? ""} />;
  }

  return (
    <section
      data-testid="workspace-viewer"
      aria-label={file.name}
      className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              KIND_STYLE[kind],
            )}
          >
            <KindIcon kind={kind} className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold leading-tight" title={file.path}>
              {file.name}
              {dirty ? <span className="ml-1.5 text-primary" title="Unsaved changes">•</span> : null}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {formatBytes(file.size)}
              {file.modifiedAt ? ` · ${formatModified(file.modifiedAt)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {toggleable ? <Segmented value={mode} onChange={setMode} /> : null}
          {canEdit && !editing ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={startEdit}
              data-testid="workspace-edit"
              className="h-8 gap-1.5"
            >
              <Pencil className="size-3.5" /> Edit
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={download}
            data-testid="workspace-download"
            className="h-8 gap-1.5"
          >
            <Download className="size-3.5" /> Download
          </Button>
        </div>
      </header>
      {isManaged ? (
        <div
          className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
          data-testid="workspace-agent-note"
        >
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Read-only. Managed on the{" "}
            <Link href="/agent/personality" className="font-medium text-foreground underline-offset-2 hover:underline">
              Personality page
            </Link>
            .
          </span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      {editing ? (
        <footer className="flex items-center justify-between gap-2 border-t border-border bg-muted/30 px-4 py-2.5">
          <span className="text-[11px] text-muted-foreground">
            Press Ctrl/Cmd+S to save
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={discard}
              disabled={saving}
              data-testid="workspace-discard"
              className="h-8 gap-1.5"
            >
              <X className="size-3.5" /> Discard
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              disabled={saving || !dirty}
              data-testid="workspace-save"
              className="h-8 gap-1.5"
            >
              <Save className="size-3.5" /> {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}
