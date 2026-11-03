"use client";

import { MessageSquarePlus } from "lucide-react";
import { useTranslations } from "next-intl";

/** What the backend sends when the running turn reads mid-turn follow-ups. */
export interface InterjectionData {
  items: Array<{ id: string; text: string }>;
  /** Runtime injection point: `D` after tools, `B` where it would have stopped. */
  point?: string;
}

/**
 * Where in the reply the agent read what the user added while it worked.
 * Rendered in place, like the compaction marker: its position is the
 * information, since everything after it was written having seen it. After a
 * reload the same messages show as ordinary user bubbles from history.
 */
export function InterjectionMarker({ data }: { data: InterjectionData }) {
  const t = useTranslations("Chat");
  return (
    <div
      data-testid="interjection-marker"
      className="my-1 flex flex-col items-end gap-1"
    >
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <MessageSquarePlus className="size-3" />
        {t("interjectionRead")}
      </span>
      {data.items.map((item) => (
        <div
          key={item.id}
          className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-accent px-4 py-2 text-sm text-accent-foreground"
        >
          {item.text}
        </div>
      ))}
    </div>
  );
}
