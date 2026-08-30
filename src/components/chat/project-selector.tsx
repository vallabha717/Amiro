"use client";

import { appStore } from "@/app/store";
import { WorkspaceTrustPromptDialog } from "@/components/workspace-trust/trust-prompt-dialog";
import { useWorkspaceTrustStatus } from "@/hooks/queries/use-workspace-trust";
import { cn } from "lib/utils";
import {
  Check,
  ChevronDown,
  Clock,
  Folder,
  FolderGit2,
  FolderOpen,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "ui/tooltip";
import { useShallow } from "zustand/shallow";

export function ProjectSelector({
  disabled,
  className,
}: {
  disabled?: boolean;
  className?: string;
}) {
  const [projectDirectory, recentProjectDirectories, appStoreMutate] = appStore(
    useShallow((state) => [
      state.projectDirectory,
      state.recentProjectDirectories,
      state.mutate,
    ]),
  );

  const [open, setOpen] = useState(false);
  const [trustPromptRoot, setTrustPromptRoot] = useState<string | null>(null);

  const folderName = useMemo(() => {
    if (!projectDirectory) return "Project";
    const parts = projectDirectory
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    return parts[parts.length - 1] || projectDirectory;
  }, [projectDirectory]);

  // Checked whenever projectDirectory changes -- including on mount, when
  // it loads from persisted storage rather than a fresh pick. Read-only
  // exploration is fine on an ungranted root; the prompt is what turns
  // that into write/exec access. A failed check (the picker only ever
  // returns a bare folder name in some browsers, which the server may not
  // be able to resolve) is swallowed via SWR's own error state rather than
  // surfaced here: the ordinary per-call refusal already explains the
  // problem if it comes up, and this check is a courtesy, not the
  // enforcement point.
  const { data: trustStatus } = useWorkspaceTrustStatus(
    projectDirectory || undefined,
  );
  useEffect(() => {
    if (projectDirectory && trustStatus && !trustStatus.trusted) {
      setTrustPromptRoot(projectDirectory);
    }
  }, [projectDirectory, trustStatus]);

  const selectDirectory = (dir: string) => {
    const trimmed = dir.trim();
    if (!trimmed) return;

    appStoreMutate((prev) => {
      // Store exactly the last 5 folders
      const recent = [
        trimmed,
        ...(prev.recentProjectDirectories || []).filter((d) => d !== trimmed),
      ].slice(0, 5);
      return {
        projectDirectory: trimmed,
        recentProjectDirectories: recent,
      };
    });
    setOpen(false);
    toast.success(`Project set to ${trimmed}`);
  };

  const removeRecent = (e: React.MouseEvent, dir: string) => {
    e.stopPropagation();
    e.preventDefault();
    appStoreMutate((prev) => ({
      recentProjectDirectories: (prev.recentProjectDirectories || []).filter(
        (d) => d !== dir,
      ),
      projectDirectory:
        prev.projectDirectory === dir ? "" : prev.projectDirectory,
    }));
  };

  const handleFolderPick = async () => {
    try {
      if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
        const handle = await (window as any).showDirectoryPicker();
        if (handle?.name) {
          selectDirectory(handle.name);
          return;
        }
      } else {
        // Fallback: file input with webkitdirectory
        const input = document.createElement("input");
        input.type = "file";
        (input as any).webkitdirectory = true;
        (input as any).directory = true;
        input.onchange = (e: any) => {
          const file = e.target.files?.[0];
          if (file?.webkitRelativePath) {
            const rootDir = file.webkitRelativePath.split("/")[0];
            if (rootDir) {
              selectDirectory(rootDir);
            }
          }
        };
        input.click();
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        toast.error("Failed to pick directory");
      }
    }
  };

  // Show only last 5 folders
  const lastFiveProjects = useMemo(() => {
    return (recentProjectDirectories || []).slice(0, 5);
  }, [recentProjectDirectories]);

  const isProjectActive = Boolean(projectDirectory);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild disabled={disabled}>
              <button
                type="button"
                className={cn(
                  "group inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium max-w-[200px] border border-transparent",
                  isProjectActive
                    ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 dark:bg-emerald-500/15 dark:hover:bg-emerald-500/25"
                    : "text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/80 dark:bg-white/5 dark:hover:bg-white/10",
                  open && "ring-1 ring-border/80 dark:ring-white/20",
                  "active:scale-[0.97] transition-[color,background-color,transform] duration-120 ease-out outline-none select-none cursor-pointer",
                  className,
                )}
              >
                <FolderGit2
                  className={cn(
                    "size-3.5 shrink-0",
                    isProjectActive
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground",
                  )}
                />
                <span className="truncate">{folderName}</span>
                <ChevronDown className="size-3 shrink-0 opacity-60 transition-transform duration-150 group-data-[state=open]:rotate-180" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <span>{projectDirectory || "Select active project directory"}</span>
          </TooltipContent>
        </Tooltip>

        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          className="w-72 p-1.5 rounded-xl bg-popover/85 supports-[backdrop-filter]:bg-popover/75 backdrop-blur-xl backdrop-saturate-150 reduce-transparency:bg-popover reduce-transparency:backdrop-blur-none border-border/70 shadow-xl shadow-black/5 dark:shadow-black/40"
        >
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
            <span>Workspace Project</span>
            {projectDirectory && (
              <span className="text-[10px] text-muted-foreground/70 normal-case font-normal truncate max-w-[140px]">
                {projectDirectory}
              </span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="my-1 bg-border/60 dark:bg-white/10" />

          <DropdownMenuGroup className="space-y-0.5">
            <DropdownMenuItem
              onClick={handleFolderPick}
              className="flex items-center gap-2.5 p-2 rounded-lg cursor-pointer hover:bg-muted/60 dark:hover:bg-white/5 transition-colors duration-100"
            >
              <div className="p-1 rounded-md bg-primary/10 text-primary shrink-0">
                <FolderOpen className="size-3.5" />
              </div>
              <div className="flex flex-col flex-1 min-w-0">
                <span className="text-xs font-medium text-foreground">
                  Select Folder...
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Pick a folder from your filesystem
                </span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          {lastFiveProjects.length > 0 && (
            <>
              <DropdownMenuSeparator className="my-1.5 bg-border/60 dark:bg-white/10" />
              <DropdownMenuLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 flex items-center gap-1.5">
                <Clock className="size-3" />
                Recent Folders (Last 5)
              </DropdownMenuLabel>

              <DropdownMenuGroup className="space-y-0.5 max-h-48 overflow-y-auto">
                {lastFiveProjects.map((dir) => {
                  const isCurrent = projectDirectory === dir;
                  const name =
                    dir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
                    dir;
                  return (
                    <DropdownMenuItem
                      key={dir}
                      onClick={() => selectDirectory(dir)}
                      className={cn(
                        "group flex items-center justify-between gap-2 p-2 rounded-lg cursor-pointer transition-colors duration-100",
                        isCurrent
                          ? "bg-accent/80 text-accent-foreground font-medium"
                          : "hover:bg-muted/60 dark:hover:bg-white/5",
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Folder className="size-3.5 text-muted-foreground shrink-0" />
                        <div className="flex flex-col min-w-0">
                          <span className="text-xs font-medium truncate text-foreground">
                            {name}
                          </span>
                          <span className="text-[10px] text-muted-foreground truncate">
                            {dir}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {isCurrent && (
                          <Check className="size-3.5 text-primary" />
                        )}
                        <button
                          type="button"
                          onClick={(e) => removeRecent(e, dir)}
                          className="opacity-0 group-hover:opacity-100 p-1 hover:text-destructive hover:bg-destructive/10 rounded transition-opacity duration-150"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            </>
          )}

          {projectDirectory && (
            <>
              <DropdownMenuSeparator className="my-1.5 bg-border/60 dark:bg-white/10" />
              <DropdownMenuItem
                onClick={() => {
                  appStoreMutate({ projectDirectory: "" });
                  toast.info("Reset to default workspace");
                }}
                className="flex items-center gap-2 p-2 rounded-lg cursor-pointer text-destructive hover:bg-destructive/10 transition-colors duration-100"
              >
                <Trash2 className="size-3.5" />
                <span className="text-xs">Reset to Server Default</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {trustPromptRoot && (
        <WorkspaceTrustPromptDialog
          root={trustPromptRoot}
          open={Boolean(trustPromptRoot)}
          onOpenChange={(next) => {
            if (!next) setTrustPromptRoot(null);
          }}
          onGranted={() => setTrustPromptRoot(null)}
        />
      )}
    </>
  );
}
