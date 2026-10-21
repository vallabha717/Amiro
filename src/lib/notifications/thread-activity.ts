"use client";

import useSWR from "swr";
import {
  fetchThreadActivity,
  THREAD_ACTIVITY_KEY,
  type ThreadActivity,
} from "@/lib/backend/notifications-api";

/** The one mark a chat row shows, most urgent first. */
export type ThreadStatus = "running" | "failed" | "unseen" | null;

const EMPTY: ThreadActivity = { running: [], unseen: [], failed: [] };

/**
 * Working beats everything (a new turn supersedes the last ending). A chat
 * the user has open never shows an unseen mark: they are looking at it, and
 * the presence report clears it on the server a moment later.
 */
export function threadStatusOf(
  activity: ThreadActivity | undefined,
  threadId: string,
  openThreadId?: string | null,
): ThreadStatus {
  if (!activity) return null;
  if (activity.running.includes(threadId)) return "running";
  if (threadId === openThreadId) return null;
  if (activity.failed.includes(threadId)) return "failed";
  if (activity.unseen.includes(threadId)) return "unseen";
  return null;
}

/**
 * Which chats are working or have something unseen. Kept live by the
 * notification stream's `thread_activity` events.
 */
export function useThreadActivity(): ThreadActivity {
  const { data } = useSWR(THREAD_ACTIVITY_KEY, fetchThreadActivity, {
    revalidateOnFocus: true,
    // The stream keeps it current; this only covers a dropped connection.
    refreshInterval: 60_000,
  });
  return data ?? EMPTY;
}
