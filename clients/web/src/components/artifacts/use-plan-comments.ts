"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlanComment } from "./use-artifacts";

/**
 * Comment drafts for one proposed plan.
 *
 * Deliberately **not** persisted server-side, and deliberately in
 * sessionStorage rather than localStorage.
 *
 * An unsent comment is a draft. Once sent it becomes part of the transcript
 * (it rides the tool result the model reads), and that is the copy worth
 * keeping. Storing drafts durably would mean an objection written weeks ago
 * resurfacing against a plan that has since changed, attached to text that
 * may no longer mean the same thing -- and the user would have no way to tell
 * a fresh comment from a stale one.
 *
 * sessionStorage covers the case that actually happens: a reload, or a tab
 * left open while the user goes to read the code the plan is about. It dies
 * with the tab, which is the right lifetime for a draft.
 */
export function usePlanComments(
  threadId: string | undefined,
  toolCallId: string,
) {
  const key = `amiro:plan-comments:${threadId ?? "none"}:${toolCallId}`;
  const [comments, setComments] = useState<PlanComment[]>([]);

  // Read on mount rather than in useState's initializer: this runs in a
  // client component that Next also renders on the server during export,
  // where sessionStorage does not exist. Reading in an effect keeps the
  // first render identical on both sides and avoids a hydration mismatch.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(key);
      setComments(raw ? (JSON.parse(raw) as PlanComment[]) : []);
    } catch {
      // A corrupt or unavailable store is not worth failing a plan review
      // over -- the user simply starts with no drafts.
      setComments([]);
    }
  }, [key]);

  const persist = useCallback(
    (next: PlanComment[]) => {
      setComments(next);
      try {
        if (next.length === 0) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or blocked. The comments still work for this render;
        // only surviving a reload is lost, and saying so would be noise at
        // the moment the user is trying to review a plan.
      }
    },
    [key],
  );

  const add = useCallback(
    (comment: Omit<PlanComment, "id">) => {
      persist([
        ...comments,
        { ...comment, id: `${Date.now()}-${comments.length}` },
      ]);
    },
    [comments, persist],
  );

  const remove = useCallback(
    (id: string) => persist(comments.filter((c) => c.id !== id)),
    [comments, persist],
  );

  const clear = useCallback(() => persist([]), [persist]);

  return { comments, add, remove, clear };
}
