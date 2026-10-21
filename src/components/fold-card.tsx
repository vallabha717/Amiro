"use client";

import { cn } from "lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

const CLOSE_MS = 220;

/**
 * Height-animated body. The content mounts on open and unmounts once the
 * close has finished, so a folded diff or terminal costs nothing. The height
 * moves through a 0fr -> 1fr grid track (no measured pixel heights, so content
 * that grows while open stays smooth), with a short rise and fade on the
 * content. Reduced motion keeps the fade and drops the movement.
 */
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() =>
        requestAnimationFrame(() => setShown(true)),
      );
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), reduced ? 0 : CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open, reduced]);

  if (!mounted) return null;
  return (
    <div
      className={cn(
        "grid",
        reduced
          ? "transition-opacity duration-150"
          : "transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
        shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        !shown && !reduced && "duration-200 ease-[cubic-bezier(0.4,0,1,1)]",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            !reduced &&
              "transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
            shown || reduced ? "translate-y-0" : "-translate-y-1.5",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The card the chat uses to fold a run of work: a bordered row with a stack
 * of small icon discs, a label, optional chips and a chevron that turns as it
 * opens. Matches the web sources bar so both read as one family.
 */
export function FoldCard({
  open,
  onToggle,
  icons,
  label,
  trailing,
  testId,
  children,
  bodyClassName,
}: {
  open: boolean;
  onToggle: () => void;
  icons?: ReactNode[];
  label: ReactNode;
  trailing?: ReactNode;
  testId?: string;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="overflow-hidden rounded-xl border bg-card text-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="group/fold flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40 active:bg-muted/60"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
            open && "rotate-90",
          )}
        />
        {icons?.length ? (
          <span className="flex shrink-0 items-center">
            {icons.map((icon, i) => (
              <span
                key={i}
                className="fold-icon-in flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground"
                style={{ marginLeft: i === 0 ? 0 : -6, animationDelay: `${i * 60}ms` }}
              >
                {icon}
              </span>
            ))}
          </span>
        ) : null}
        <span className="font-medium">{label}</span>
        {trailing}
      </button>
      <Collapse open={open}>
        <div className={cn("border-t p-2", bodyClassName)}>{children}</div>
      </Collapse>
    </div>
  );
}
