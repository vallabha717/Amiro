"use client";

import {
  ArrowDownAZ,
  ChevronRight,
  Eye,
  EyeOff,
  File as FileIcon,
  FileCode,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDriveDownload,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { cn } from "lib/utils";
import { Button } from "ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Input } from "ui/input";
import { ScrollArea } from "ui/scroll-area";
import { Skeleton } from "ui/skeleton";
import {
  type FileKind,
  type WorkspaceEntry,
  fileKind,
  formatBytes,
  parentPath,
} from "./workspace-api";

export type DirState = {
  status: "loading" | "ready" | "error";
  entries: WorkspaceEntry[];
  error?: string;
};
export type SortMode = "name" | "size";
export type TreeAction = "new-file" | "new-folder" | "rename" | "delete";

export const KIND_STYLE: Record<FileKind, string> = {
  markdown: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  json: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  code: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  text: "bg-muted text-muted-foreground",
  image: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  other: "bg-muted text-muted-foreground",
};

const KIND_TEXT: Record<FileKind, string> = {
  markdown: "text-sky-600 dark:text-sky-400",
  json: "text-amber-600 dark:text-amber-400",
  code: "text-violet-600 dark:text-violet-400",
  text: "text-muted-foreground",
  image: "text-emerald-600 dark:text-emerald-400",
  other: "text-muted-foreground",
};

export function KindIcon({
  kind,
  className,
}: {
  kind: FileKind;
  className?: string;
}) {
  const Icon =
    kind === "markdown" || kind === "text"
      ? FileText
      : kind === "json"
        ? FileJson
        : kind === "code"
          ? FileCode
          : kind === "image"
            ? ImageIcon
            : FileIcon;
  return <Icon className={className} aria-hidden="true" />;
}

type Row = { entry: WorkspaceEntry; depth: number; hint?: string };

function sortEntries(entries: WorkspaceEntry[], sort: SortMode) {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    if (sort === "size" && a.type === "file" && a.size !== b.size)
      return b.size - a.size;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function buildRows(
  dirs: Record<string, DirState>,
  expanded: Set<string>,
  sort: SortMode,
  query: string,
): Row[] {
  const needle = query.trim().toLowerCase();
  if (needle) {
    const matches: WorkspaceEntry[] = [];
    for (const state of Object.values(dirs)) {
      for (const entry of state.entries) {
        if (entry.name.toLowerCase().includes(needle)) matches.push(entry);
      }
    }
    return sortEntries(matches, sort).map((entry) => ({
      entry,
      depth: 0,
      hint: parentPath(entry.path),
    }));
  }
  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const state = dirs[dir];
    if (!state) return;
    for (const entry of sortEntries(state.entries, sort)) {
      rows.push({ entry, depth });
      if (entry.type === "dir" && expanded.has(entry.path)) {
        walk(entry.path, depth + 1);
      }
    }
  };
  walk("", 0);
  return rows;
}

type MenuItems = {
  canWrite: boolean;
  entry: WorkspaceEntry;
  onAction: (a: TreeAction, e: WorkspaceEntry) => void;
};

function menuDisabled({ canWrite, entry }: MenuItems) {
  return !canWrite || entry.hidden;
}

function RowMenuItems({
  Item,
  Separator,
  ...p
}: MenuItems & {
  Item: React.ComponentType<React.ComponentProps<typeof ContextMenuItem>>;
  Separator: React.ComponentType;
}) {
  const disabled = menuDisabled(p);
  return (
    <>
      <Item disabled={!p.canWrite} onSelect={() => p.onAction("new-file", p.entry)}>
        <FilePlus className="size-4" /> New file
      </Item>
      <Item disabled={!p.canWrite} onSelect={() => p.onAction("new-folder", p.entry)}>
        <FolderPlus className="size-4" /> New folder
      </Item>
      <Separator />
      <Item disabled={disabled} onSelect={() => p.onAction("rename", p.entry)}>
        <Pencil className="size-4" /> Rename
      </Item>
      <Item
        disabled={disabled}
        variant="destructive"
        onSelect={() => p.onAction("delete", p.entry)}
      >
        <Trash2 className="size-4" /> Delete
      </Item>
    </>
  );
}

function TreeRow({
  row,
  expanded,
  selected,
  canWrite,
  loading,
  onToggle,
  onSelect,
  onAction,
}: {
  row: Row;
  expanded: boolean;
  selected: boolean;
  canWrite: boolean;
  loading: boolean;
  onToggle: (path: string) => void;
  onSelect: (entry: WorkspaceEntry) => void;
  onAction: (a: TreeAction, e: WorkspaceEntry) => void;
}) {
  const { entry, depth, hint } = row;
  const isDir = entry.type === "dir";
  const kind = fileKind(entry.name);
  const activate = () => (isDir ? onToggle(entry.path) : onSelect(entry));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="treeitem"
          tabIndex={0}
          aria-selected={selected}
          aria-expanded={isDir ? expanded : undefined}
          data-testid={`workspace-row-${entry.path}`}
          data-selected={selected || undefined}
          onClick={activate}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              activate();
            }
          }}
          style={{ paddingLeft: 8 + depth * 14 }}
          className={cn(
            "group relative flex cursor-pointer select-none items-center gap-1.5 rounded-md py-1 pr-2 text-[13px] outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-ring/60",
            selected
              ? "bg-primary/[0.12] text-foreground"
              : "text-foreground/90 hover:bg-accent/60",
            entry.hidden && "opacity-60",
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {isDir ? (
              <ChevronRight
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform duration-150",
                  expanded && "rotate-90",
                  loading && "animate-pulse",
                )}
                aria-hidden="true"
              />
            ) : null}
          </span>
          {isDir ? (
            expanded ? (
              <FolderOpen className="size-4 shrink-0 text-primary/80" aria-hidden="true" />
            ) : (
              <Folder className="size-4 shrink-0 text-primary/80" aria-hidden="true" />
            )
          ) : (
            <KindIcon
              kind={kind}
              className={cn("size-4 shrink-0", KIND_TEXT[kind])}
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {entry.name}
            {hint ? (
              <span className="ml-2 text-[11px] text-muted-foreground/70">{hint}</span>
            ) : null}
          </span>
          {!isDir ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground group-hover:opacity-0 group-focus-within:opacity-0">
              {formatBytes(entry.size)}
            </span>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${entry.name}`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <RowMenuItems
                Item={DropdownMenuItem as never}
                Separator={DropdownMenuSeparator as never}
                canWrite={canWrite}
                entry={entry}
                onAction={onAction}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <RowMenuItems
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator as never}
          canWrite={canWrite}
          entry={entry}
          onAction={onAction}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function WorkspaceTree({
  dirs,
  expanded,
  selected,
  sort,
  showHidden,
  canWrite,
  onToggle,
  onSelect,
  onAction,
  onRootAction,
  onSortChange,
  onShowHiddenChange,
  onRetry,
}: {
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  selected: string | null;
  sort: SortMode;
  showHidden: boolean;
  canWrite: boolean;
  onToggle: (path: string) => void;
  onSelect: (entry: WorkspaceEntry) => void;
  onAction: (a: TreeAction, e: WorkspaceEntry) => void;
  onRootAction: (a: "new-file" | "new-folder") => void;
  onSortChange: (s: SortMode) => void;
  onShowHiddenChange: (v: boolean) => void;
  onRetry: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const rows = React.useMemo(
    () => buildRows(dirs, expanded, sort, query),
    [dirs, expanded, sort, query],
  );
  const root = dirs[""];

  return (
    <section
      data-testid="workspace-tree"
      aria-label="Workspace files"
      className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <h2 className="text-sm font-semibold tracking-tight">Files</h2>
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            title={sort === "name" ? "Sorted by name (click for size)" : "Sorted by size (click for name)"}
            aria-label={sort === "name" ? "Sort by size" : "Sort by name"}
            onClick={() => onSortChange(sort === "name" ? "size" : "name")}
          >
            {sort === "name" ? (
              <ArrowDownAZ className="size-4" />
            ) : (
              <HardDriveDownload className="size-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-7 text-muted-foreground", showHidden && "bg-accent text-foreground")}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
            aria-pressed={showHidden}
            data-testid="workspace-toggle-hidden"
            onClick={() => onShowHiddenChange(!showHidden)}
          >
            {showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                aria-label="Create"
                title="Create"
                disabled={!canWrite}
                data-testid="workspace-tree-create"
              >
                <Plus className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={() => onRootAction("new-file")}>
                <FilePlus className="size-4" /> New file
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRootAction("new-folder")}>
                <FolderPlus className="size-4" /> New folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files"
            aria-label="Search files"
            data-testid="workspace-search"
            className="h-8 rounded-lg bg-background pl-8 text-[13px] shadow-none"
          />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div role="tree" className="px-1.5 pb-2" aria-label="Files">
          {!root || root.status === "loading" ? (
            <div className="space-y-1.5 px-2 py-1" aria-busy="true">
              {[70, 50, 62, 44, 56].map((w, i) => (
                <Skeleton key={w + i} className="h-5 rounded-md" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : root.status === "error" ? (
            <div className="space-y-2 px-3 py-4 text-sm" role="alert">
              <p className="text-destructive">{root.error || "Could not load files."}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {query.trim() ? "No matching files" : "This folder is empty"}
            </p>
          ) : (
            rows.map((row) => (
              <TreeRow
                key={row.entry.path}
                row={row}
                expanded={expanded.has(row.entry.path)}
                selected={selected === row.entry.path}
                canWrite={canWrite}
                loading={dirs[row.entry.path]?.status === "loading"}
                onToggle={onToggle}
                onSelect={onSelect}
                onAction={onAction}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
