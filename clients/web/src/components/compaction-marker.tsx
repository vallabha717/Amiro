"use client";

import { FoldVerticalIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * What the backend sent when it shrank the outbound history. Mirrors
 * compactIfNeeded in backend-go/internal/api/chat/compact.go.
 */
export interface CompactionData {
  replaced: number;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * The visible marker for a context compaction.
 *
 * This exists because a silent context drop is the kind of thing a user has
 * to be able to see to trust a transcript. Without it, an agent that
 * suddenly stops remembering the start of a long turn looks like it got
 * dumber for no reason -- and the user's natural response, repeating
 * themselves, is exactly right but for the wrong reason.
 *
 * Rendered deliberately quietly: it is a fact about the machinery, not
 * about the work, and it should be findable when scrolling back without
 * competing with the actual conversation.
 */
export function CompactionMarker({ data }: { data: CompactionData }) {
  const t = useTranslations("Chat");
  const saved = Math.max(0, data.tokensBefore - data.tokensAfter);

  return (
    <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      <FoldVerticalIcon className="size-3 shrink-0" />
      <span className="shrink-0">
        {t("contextCompacted", {
          count: data.replaced,
          // Thousands, because the underlying figure is an estimate and
          // rendering "47,213 tokens" would claim a precision the character
          // heuristic behind it does not have.
          saved: Math.round(saved / 1000),
        })}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
