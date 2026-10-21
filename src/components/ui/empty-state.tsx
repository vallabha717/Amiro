import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * Centered placeholder for a surface with nothing to show yet.
 * Modeled on Vellum's EmptyState with Amiro design tokens.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-4 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/50 text-muted-foreground shadow-2xs">
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold tracking-tight text-foreground sm:text-base">
        {title}
      </h3>
      {description ? (
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2 flex items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
