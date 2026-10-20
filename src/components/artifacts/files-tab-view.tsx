"use client";

import { FileArtifactsPanel } from "./file-artifacts";
import { TodoPanel } from "./todo-panel";
import type { TodoArtifact } from "./use-artifacts";

/**
 * The Files tab: file artifacts with the turn's task list on top.
 *
 * Tasks render only once the agent actually wrote some -- an empty "no
 * tasks yet" state sitting above every file list would punish the turns
 * that never made one. The fixed height keeps the checklist scrollable
 * without stealing the panel from the files below it.
 */
export function FilesTabView({
  todos,
  threadId,
}: {
  todos?: TodoArtifact;
  threadId?: string;
}) {
  const showTasks = !!todos && todos.items.length > 0;
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="files-tab-view"
    >
      {showTasks && (
        <div className="h-64 shrink-0 overflow-hidden border-b">
          <TodoPanel todos={todos} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <FileArtifactsPanel threadId={threadId} />
      </div>
    </div>
  );
}
