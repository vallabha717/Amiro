"use client";

import { appStore } from "@/app/store";
import { WorkspaceFileViewer } from "@/components/workspace-browser/workspace-file-viewer";
import { Button } from "ui/button";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback } from "react";

/**
 * A workspace file opened from a path in the chat, shown with the Workspace
 * page's own viewer so a file looks and behaves the same wherever it opens.
 * Read-only here: editing stays on the Workspace page.
 */
export function WorkspaceFileTab({ path }: { path: string }) {
  const mutate = appStore((s) => s.mutate);
  const close = useCallback(
    () =>
      mutate((s) => ({
        artifactView: { ...s.artifactView, workspacePath: undefined },
      })),
    [mutate],
  );
  const noop = useCallback(() => {}, []);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-file-tab">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={close}
          data-testid="workspace-file-tab-back"
        >
          <ArrowLeftIcon className="size-3.5" />
          Files
        </Button>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={path}>
          {path}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-2 [&>section]:min-h-0 [&>section]:flex-1">
        <WorkspaceFileViewer
          source={{ kind: "workspace", path }}
          canWrite={false}
          showHidden={false}
          onSaved={noop}
          onDirtyChange={noop}
        />
      </div>
    </div>
  );
}
