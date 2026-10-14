"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchFsBrowse, fetchFsRoots, type FsBrowseResponse } from "@/lib/backend/fs-browse-api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Button } from "ui/button";
import { ArrowUp, Folder, FolderGit2, Loader2, Home, AlertCircle } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (absolutePath: string) => void;
  initialPath?: string;
};

function breadcrumbs(absPath: string): { label: string; path: string }[] {
  const parts = absPath.replace(/\/+$/, "").split("/").filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    out.push({ label: p, path: cur });
  }
  return out;
}

export function FolderBrowserDialog({ open, onOpenChange, onSelect, initialPath }: Props) {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [data, setData] = useState<FsBrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roots, setRoots] = useState<string[]>([]);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFsBrowse(p);
      setData(res);
      setCurrentPath(res.path);
      setRoots(res.roots);
    } catch (e: any) {
      setError(e.message || "Failed to browse");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const start = initialPath || "";
    if (start) {
      load(start);
    } else {
      // Load roots then browse first root
      fetchFsRoots()
        .then((r) => {
          setRoots(r.roots);
          const first = r.roots[0] || "/root";
          load(first);
        })
        .catch((e: any) => setError(e.message || "Failed to load roots"));
    }
  }, [open, initialPath, load]);

  const dirs = (data?.entries || []).filter((e) => e.kind === "dir");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col" data-testid="folder-browser-dialog">
        <DialogHeader>
          <DialogTitle>Browse server folders</DialogTitle>
          <DialogDescription>Select a folder on the server to use as your project directory.</DialogDescription>
        </DialogHeader>

        {/* Current path + breadcrumb */}
        <div className="space-y-2 min-w-0">
          <div className="text-xs font-mono bg-muted rounded px-2 py-1 truncate" data-testid="folder-browser-current-path">
            {currentPath || "—"}
          </div>
          {currentPath && (
            <div className="flex flex-wrap gap-1 items-center text-xs">
              {breadcrumbs(currentPath).map((bc, i) => (
                <span key={bc.path} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground">/</span>}
                  <button
                    type="button"
                    className="hover:underline text-primary truncate max-w-[120px]"
                    onClick={() => load(bc.path)}
                    data-testid={`folder-breadcrumb-${i}`}
                  >
                    {bc.label}
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* Roots quick-jump */}
          {roots.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {roots.map((r) => (
                <Button
                  key={r}
                  variant={currentPath === r ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={() => load(r)}
                  data-testid={`folder-root-${r}`}
                >
                  <Home className="size-3 mr-1" />
                  {r}
                </Button>
              ))}
            </div>
          )}
          {data?.parent && (
            <Button variant="outline" size="sm" onClick={() => load(data.parent!)} data-testid="folder-browser-up" className="h-7">
              <ArrowUp className="size-3 mr-1" /> Up
            </Button>
          )}
        </div>

        <div className="flex-1 min-h-[240px] max-h-[360px] overflow-y-auto rounded border bg-background">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="size-5 animate-spin mr-2" /> Loading…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AlertCircle className="size-6 text-destructive mb-2" />
              <p className="text-sm text-destructive" data-testid="folder-browser-error">
                {error}
              </p>
              {currentPath && data?.parent && (
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => load(data.parent!)}>
                  Go up
                </Button>
              )}
            </div>
          ) : dirs.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No subfolders</div>
          ) : (
            <ul className="divide-y">
              {dirs.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    onClick={() => load(e.path)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                    data-testid={`folder-entry-${e.name}`}
                  >
                    {e.isGitRepo ? <FolderGit2 className="size-4 shrink-0 text-primary" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate flex-1">{e.name}</span>
                    {e.isGitRepo && <span className="text-[10px] text-primary border border-primary/30 rounded px-1">git</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data?.truncated && <div className="text-xs text-muted-foreground px-3 py-1 border-t">Showing first 500 entries — list truncated.</div>}
          {/* Also show count of files hidden from folder-only view */}
          {data && data.entries.length > dirs.length && (
            <div className="text-xs text-muted-foreground px-3 py-1">{data.entries.length - dirs.length} file(s) hidden</div>
          )}
        </div>

        <DialogFooter className="flex gap-2 sm:justify-between w-full">
          <div className="text-xs text-muted-foreground self-center hidden sm:block">
            Hidden entries included per spec (dirs first). Never reads file contents.
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (currentPath) onSelect(currentPath);
              }}
              disabled={!currentPath || !!error}
              data-testid="folder-browser-use-this-folder"
            >
              Use this folder
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
