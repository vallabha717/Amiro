"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

export interface TraitCycleRowProps {
  label: string;
  value: string;
  colorHex?: string;
  onPrev: () => void;
  onNext: () => void;
  prevTestId?: string;
  nextTestId?: string;
  valueTestId?: string;
}

/**
 * Vellum-style arrow color selector. Label left, chevron buttons with
 * accessible names "Previous {label}"/"Next {label}", centered current value
 * plus optional color dot. Used for Theme (dot = var(--sidebar-primary)) and
 * Form to keep the customizer visually consistent.
 */
export function TraitCycleRow({
  label,
  value,
  colorHex,
  onPrev,
  onNext,
  prevTestId,
  nextTestId,
  valueTestId,
}: TraitCycleRowProps) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/30 px-3.5 py-2.5">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Previous ${label}`}
          data-testid={prevTestId}
          onClick={onPrev}
          className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-foreground transition-transform hover:bg-accent active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <div className="flex min-w-[120px] items-center justify-center gap-2 px-1">
          {colorHex ? (
            <span
              aria-hidden="true"
              className="size-3.5 shrink-0 rounded-full border border-border shadow-xs"
              style={{ backgroundColor: colorHex }}
            />
          ) : null}
          <span
            data-testid={valueTestId}
            aria-live="polite"
            className="max-w-[120px] truncate text-sm font-semibold capitalize"
          >
            {value}
          </span>
        </div>
        <button
          type="button"
          aria-label={`Next ${label}`}
          data-testid={nextTestId}
          onClick={onNext}
          className="flex size-7 items-center justify-center rounded-full border border-border/60 bg-background/80 text-foreground transition-transform hover:bg-accent active:scale-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
