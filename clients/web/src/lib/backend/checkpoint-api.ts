import { apiJson } from "./client";

export const CHECKPOINT_KEY = "/api/checkpoint";

/**
 * One file a turn checkpointed -- mirrors
 * backend-go/internal/api/checkpoint's unexported fileResponse.
 */
export interface CheckpointFile {
  path: string;
  existedBefore: boolean;
}

export interface CheckpointFiles {
  turnId: string;
  files: CheckpointFile[];
}

/** One file's outcome from a restore -- mirrors restoreFileResponse. */
export interface CheckpointRestoreFile {
  path: string;
  existedBefore: boolean;
  restored: boolean;
  error?: string;
}

export interface CheckpointRestoreResult {
  turnId: string;
  files: CheckpointRestoreFile[];
}

/**
 * The files a specific turn checkpointed -- what "Rewind to here" on an
 * assistant message fetches to build its confirmation, before anything is
 * reverted.
 */
export async function selectCheckpointFiles(
  threadId: string,
  turnId: string,
): Promise<CheckpointFiles> {
  return apiJson<CheckpointFiles>(
    `${CHECKPOINT_KEY}/files?threadId=${encodeURIComponent(threadId)}&turnId=${encodeURIComponent(turnId)}`,
    { method: "GET" },
  );
}

/** The human's "yes" answer to the rewind confirmation. */
export async function restoreCheckpoint(
  threadId: string,
  turnId: string,
): Promise<CheckpointRestoreResult> {
  return apiJson<CheckpointRestoreResult>(`${CHECKPOINT_KEY}/restore`, {
    method: "POST",
    body: JSON.stringify({ threadId, turnId }),
  });
}
