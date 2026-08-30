"use client";
import { CheckpointFiles } from "@/lib/backend/checkpoint-api";
import { fetcher } from "lib/utils";
import useSWR, { SWRConfiguration } from "swr";

/**
 * The files one turn checkpointed. The key is `null` (SWR's "don't fetch
 * yet" convention) until the rewind confirmation is actually open, so
 * hovering or rendering an assistant message never fires a request --
 * only clicking "Rewind to here" does.
 */
export function useCheckpointFiles(
  threadId: string | undefined,
  turnId: string | undefined,
  enabled: boolean,
  options?: SWRConfiguration,
) {
  return useSWR<CheckpointFiles>(
    enabled && threadId && turnId
      ? `/api/checkpoint/files?threadId=${encodeURIComponent(threadId)}&turnId=${encodeURIComponent(turnId)}`
      : null,
    fetcher,
    {
      revalidateOnFocus: false,
      errorRetryCount: 0,
      ...options,
    },
  );
}
