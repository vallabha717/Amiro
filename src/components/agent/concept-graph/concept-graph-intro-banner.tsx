import { Sparkles, X } from "lucide-react";

interface ConceptGraphIntroBannerProps {
  onDismiss: () => void;
}

export function ConceptGraphIntroBanner({
  onDismiss,
}: ConceptGraphIntroBannerProps) {
  return (
    <div
      data-graph-control
      className="pointer-events-auto flex w-full max-w-[30rem] items-start gap-3 self-center rounded-xl border border-border/70 bg-card/90 px-4 py-3 shadow-lg backdrop-blur-md"
    >
      <span className="mt-0.5 shrink-0 text-primary" aria-hidden="true">
        <Sparkles size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-foreground">
          This is your assistant&apos;s mind
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          Every idea it learns, and the links it draws between them, shows up
          here. The map grows and rearranges itself as you talk, so the more you
          share, the richer it gets.
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="cursor-pointer rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
