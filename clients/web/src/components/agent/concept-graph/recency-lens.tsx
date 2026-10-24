import { cn } from "@/lib/utils";

/** The recency window the graph highlights. "all" disables the lens. */
export type RecencyWindow = "all" | "month" | "week";

interface RecencyLensProps {
  value: RecencyWindow;
  onChange: (value: RecencyWindow) => void;
}

const ITEMS: { value: RecencyWindow; label: string }[] = [
  { value: "all", label: "All" },
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
];

export function RecencyLens({ value, onChange }: RecencyLensProps) {
  return (
    <div
      role="group"
      aria-label="Filter concepts by recency"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border/70 bg-card/85 p-0.5 backdrop-blur-md"
    >
      {ITEMS.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            value === item.value
              ? "bg-secondary text-foreground shadow-2xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
