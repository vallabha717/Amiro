"use client";

import { appStore } from "@/app/store";
import { useCallback } from "react";

/**
 * Open a workspace file in the artifact pane's Files tab, viewed with the same
 * viewer the Workspace page uses. `path` is workspace-relative.
 */
export function useOpenWorkspaceFile() {
  const mutate = appStore((s) => s.mutate);
  return useCallback(
    (path: string) =>
      mutate((s) => ({
        artifactView: {
          ...s.artifactView,
          isOpen: true,
          tab: "files",
          fileId: undefined,
          workspacePath: path,
        },
      })),
    [mutate],
  );
}
