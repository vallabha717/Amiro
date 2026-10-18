"use client";

import { ArrowLeft, FilePlus, FolderTree } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";
import { useSession } from "@/lib/backend/session-context";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Input } from "ui/input";
import { Skeleton } from "ui/skeleton";
import { AgentHomeBar } from "./agent-home-bar";
import { WorkspaceFileViewer, type ViewerSource } from "./workspace-file-viewer";
import {
  WorkspaceTree,
  type DirState,
  type SortMode,
  type TreeAction,
} from "./workspace-tree";
import {
  type WorkspaceEntry,
  ancestorsOf,
  baseName,
  deletePath,
  fetchTree,
  hasHiddenSegment,
  joinPath,
  makeDir,
  parentPath,
  renamePath,
  validateName,
  writeFile,
} from "./workspace-api";

type DialogState =
  | { type: "new-file" | "new-folder"; parent: string }
  | { type: "rename" | "delete"; entry: WorkspaceEntry }
  | null;

function setUrlFile(path: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (path) url.searchParams.set("file", path);
  else url.searchParams.delete("file");
  window.history.replaceState(window.history.state, "", url);
}

const isUnder = (path: string, base: string) =>
  path === base || path.startsWith(`${base}/`);

export function WorkspaceBrowser() {
  const { data: session } = useSession();
  const canWrite = session?.user.role === "admin";

  const [showHidden, setShowHiddenState] = React.useState(false);
  const [sort, setSort] = React.useState<SortMode>("name");
  const [dirs, setDirs] = React.useState<Record<string, DirState>>({});
  const [expanded, setExpandedState] = React.useState<Set<string>>(new Set());
  const [selected, setSelected] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState>(null);

  const hiddenRef = React.useRef(false);
  const expandedRef = React.useRef<Set<string>>(new Set());
  const dirtyRef = React.useRef(false);
  const dirsRef = React.useRef(dirs);
  dirsRef.current = dirs;


  const setExpanded = React.useCallback((fn: (prev: Set<string>) => Set<string>) => {
    const next = fn(expandedRef.current);
    expandedRef.current = next;
    setExpandedState(next);
  }, []);

  const loadDir = React.useCallback(async (path: string) => {
    setDirs((prev) => ({
      ...prev,
      [path]: { status: "loading", entries: prev[path]?.entries ?? [] },
    }));
    try {
      const res = await fetchTree(path, hiddenRef.current);
      setDirs((prev) => ({ ...prev, [path]: { status: "ready", entries: res.entries } }));
    } catch (e) {
      const error = e instanceof Error ? e.message : "Could not load files";
      setDirs((prev) => ({ ...prev, [path]: { status: "error", entries: [], error } }));
    }
  }, []);

  const revealPath = React.useCallback(
    async (path: string) => {
      const anc = ancestorsOf(path);
      setExpanded((prev) => new Set([...prev, ...anc]));
      await Promise.all(["", ...anc].map((d) => loadDir(d)));
    },
    [loadDir, setExpanded],
  );

  const confirmDiscard = () =>
    !dirtyRef.current || window.confirm("Discard unsaved changes?");

  const selectFile = React.useCallback((path: string) => {
    if (!confirmDiscard()) return;
    setSelected(path);
    setUrlFile(path);
  }, []);

  // Initial load + ?file= deep link.
  React.useEffect(() => {
    const file = new URLSearchParams(window.location.search).get("file");
    if (file) {
      if (hasHiddenSegment(file)) {
        hiddenRef.current = true;
        setShowHiddenState(true);
      }
      setSelected(file);
      void revealPath(file);
    } else {
      void loadDir("");
    }
  }, []);

  const reloadAll = React.useCallback(() => {
    for (const d of ["", ...expandedRef.current]) void loadDir(d);
  }, [loadDir]);

  const changeShowHidden = (v: boolean) => {
    hiddenRef.current = v;
    setShowHiddenState(v);
    reloadAll();
  };

  const toggleDir = (path: string) => {
    const open = expandedRef.current.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!open && !dirsRef.current[path]) void loadDir(path);
  };

  const onAction = (type: TreeAction, entry: WorkspaceEntry) => {
    if (type === "new-file" || type === "new-folder") {
      setDialog({
        type,
        parent: entry.type === "dir" ? entry.path : parentPath(entry.path),
      });
    } else setDialog({ type, entry });
  };

  const openNew = (type: "new-file" | "new-folder") =>
    setDialog({ type, parent: selected ? parentPath(selected) : "" });

  const submitDialog = async (value: string) => {
    if (!dialog) return;
    try {
      if (dialog.type === "new-file") {
        const path = joinPath(dialog.parent, value.trim());
        if (dirsRef.current[dialog.parent]?.entries.some((e) => e.path === path)) {
          throw new Error(`${baseName(path)} already exists`);
        }
        await writeFile(path, "");
        await revealPath(path);
        if (confirmDiscard()) {
                setSelected(path);
          setUrlFile(path);
        }
        toast.success(`Created ${baseName(path)}`);
      } else if (dialog.type === "new-folder") {
        const path = joinPath(dialog.parent, value.trim());
        await makeDir(path);
        await revealPath(`${path}/x`);
        toast.success(`Created ${baseName(path)}`);
      } else if (dialog.type === "rename") {
        const from = dialog.entry.path;
        const to = joinPath(parentPath(from), value.trim());
        if (to === from) {
          setDialog(null);
          return;
        }
        if (dirtyRef.current && selected && isUnder(selected, from) && !confirmDiscard()) return;
        await renamePath(from, to);
        const remap = (p: string) => (isUnder(p, from) ? to + p.slice(from.length) : p);
        setDirs((prev) => {
          const next: Record<string, DirState> = {};
          for (const [k, v] of Object.entries(prev)) if (!isUnder(k, from)) next[k] = v;
          return next;
        });
        setExpanded((prev) => new Set([...prev].map(remap)));
        if (selected && isUnder(selected, from)) {
          const np = remap(selected);
          setSelected(np);
          setUrlFile(np);
        }
        await loadDir(parentPath(from));
        for (const d of expandedRef.current) if (isUnder(d, to)) void loadDir(d);
        toast.success(`Renamed to ${baseName(to)}`);
      } else if (dialog.type === "delete") {
        const path = dialog.entry.path;
        await deletePath(path);
        setDirs((prev) => {
          const next: Record<string, DirState> = {};
          for (const [k, v] of Object.entries(prev)) if (!isUnder(k, path)) next[k] = v;
          return next;
        });
        setExpanded((prev) => new Set([...prev].filter((p) => !isUnder(p, path))));
        if (selected && isUnder(selected, path)) {
          setSelected(null);
          setUrlFile(null);
        }
        await loadDir(parentPath(path));
        toast.success(`Deleted ${dialog.entry.name}`);
      }
      setDialog(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
    }
  };

  const root = dirs[""];
  const rootEmpty = root?.status === "ready" && root.entries.length === 0;

  const viewerSource: ViewerSource | null = selected ? { kind: "workspace", path: selected } : null;

  return (
    <div
      data-testid="workspace-browser"
      className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6 sm:p-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            href="/agent"
            data-testid="workspace-back-link"
            className="mt-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Agent Hub
          </Link>
          <div className="min-w-0">
            <h1 className="font-brand text-2xl font-bold tracking-tight sm:text-[28px]">
              Workspace
            </h1>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Files your agent reads and writes. Everything it creates in chats lands here.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="shrink-0 gap-1.5 rounded-full px-4 font-medium"
          data-testid="workspace-new-file"
          disabled={!canWrite}
          title={canWrite ? undefined : "Only the owner can create files"}
          onClick={() => openNew("new-file")}
        >
          <FilePlus className="size-4" aria-hidden="true" />
          New file
        </Button>
      </div>

      <AgentHomeBar
        activePath={selected}
        canWrite={!!canWrite}
        onOpen={(name) => {
          selectFile(name);
          void revealPath(name);
        }}
        onOpenJournal={() => {
          setExpanded((prev) => new Set([...prev, "journal"]));
          void loadDir("journal");
        }}
      />

      {!root ? (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]" aria-busy="true">
          <Skeleton className="h-[420px] rounded-xl" />
          <Skeleton className="hidden h-[420px] rounded-xl lg:block" />
        </div>
      ) : rootEmpty ? (
        <div
          data-testid="workspace-empty"
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center"
        >
          <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
            <FolderTree className="size-5" aria-hidden="true" />
          </div>
          <h2 className="text-sm font-semibold">Your agent hasn&apos;t saved anything yet</h2>
          <p className="max-w-sm text-xs text-muted-foreground">
            Ask it to write a note, save research, or build a file — it&apos;ll show up here.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:h-[calc(100vh-16rem)] lg:min-h-[480px] lg:grid-cols-[300px_1fr]">
          <div className="grid h-[320px] min-h-0 lg:h-auto [&>*]:min-h-0">
            <WorkspaceTree
              dirs={dirs}
              expanded={expanded}
              selected={selected}
              sort={sort}
              showHidden={showHidden}
              canWrite={!!canWrite}
              onToggle={toggleDir}
              onSelect={(e) => selectFile(e.path)}
              onAction={onAction}
              onRootAction={openNew}
              onSortChange={setSort}
              onShowHiddenChange={changeShowHidden}
              onRetry={() => void loadDir("")}
            />
          </div>
          <div className="grid min-h-[420px] min-w-0 lg:h-auto lg:min-h-0 [&>*]:min-h-0">
            <WorkspaceFileViewer
              source={viewerSource}
              canWrite={!!canWrite}
              showHidden={showHidden}
              onSaved={(p) => void loadDir(parentPath(p))}
              onDirtyChange={(d) => {
                dirtyRef.current = d;
              }}
            />
          </div>
        </div>
      )}

      <NameDialog
        dialog={dialog}
        onClose={() => setDialog(null)}
        onSubmit={submitDialog}
      />
    </div>
  );
}

function NameDialog({
  dialog,
  onClose,
  onSubmit,
}: {
  dialog: DialogState;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const type = dialog?.type;

  React.useEffect(() => {
    setValue(dialog?.type === "rename" ? dialog.entry.name : "");
    setBusy(false);
  }, [dialog]);

  const isDelete = type === "delete";
  const error = !isDelete && value ? validateName(value, type !== "rename") : null;
  const submit = async () => {
    if (!isDelete && (error || !value.trim())) return;
    setBusy(true);
    try {
      await onSubmit(value);
    } finally {
      setBusy(false);
    }
  };

  const title =
    type === "new-file"
      ? "New file"
      : type === "new-folder"
        ? "New folder"
        : type === "rename"
          ? "Rename"
          : "Delete";
  const where =
    dialog && (dialog.type === "new-file" || dialog.type === "new-folder")
      ? dialog.parent
        ? `In ${dialog.parent}/`
        : "In the workspace root"
      : null;

  return (
    <Dialog open={!!dialog} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm" data-testid="workspace-dialog">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{isDelete ? `Delete ${dialog?.type === "delete" ? dialog.entry.name : ""}?` : title}</DialogTitle>
            <DialogDescription>
              {isDelete
                ? dialog?.type === "delete" && dialog.entry.type === "dir"
                  ? "This folder and everything in it will be permanently deleted."
                  : "This file will be permanently deleted."
                : (where ?? "Choose a new name.")}
            </DialogDescription>
          </DialogHeader>
          {!isDelete ? (
            <div className="grid gap-1.5">
              <Input
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={type === "new-folder" ? "folder-name" : "notes.md"}
                aria-label="Name"
                aria-invalid={!!error}
                data-testid="workspace-name-input"
              />
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={isDelete ? "destructive" : "default"}
              disabled={busy || (!isDelete && (!value.trim() || !!error))}
              data-testid="workspace-dialog-confirm"
            >
              {isDelete ? "Delete" : type === "rename" ? "Rename" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
