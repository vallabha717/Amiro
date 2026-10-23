"use client";

import type { ReactNode } from "react";
import { cn } from "lib/utils";
import { DialogDescription, DialogHeader, DialogTitle } from "ui/dialog";

/**
 * Shared popup layout: fixed header, scrollable middle, fixed footer.
 *
 * Every dialog in the app uses this so long content never pushes the title
 * or the action buttons off-screen — only the middle scrolls.
 */
export function PopupShell({
  title,
  description,
  headerExtra,
  children,
  footer,
  className,
  bodyClassName,
  scrollTestId,
}: {
  title: ReactNode;
  description?: ReactNode;
  headerExtra?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  scrollTestId?: string;
}) {
  return (
    <>
      {/* Fixed header: title never scrolls away */}
      <DialogHeader
        className="shrink-0 border-b border-border/60 px-6 pt-3 pb-3"
        data-testid="popup-shell-header"
      >
        <DialogTitle className="text-lg font-semibold tracking-tight">
          {title}
        </DialogTitle>
        {description ? (
          <DialogDescription className="text-xs text-muted-foreground">
            {description}
          </DialogDescription>
        ) : null}
        {headerExtra}
      </DialogHeader>

      {/* Scrollable middle only */}
      <div
        className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5", bodyClassName)}
        data-testid={scrollTestId ?? "popup-shell-scroll"}
      >
        {children}
      </div>

      {/* Fixed footer: actions stay visible */}
      {footer ? (
        <div
          className={cn(
            "shrink-0 border-t border-border/60 bg-background/95 px-6 py-4",
            className,
          )}
          data-testid="popup-shell-footer"
        >
          {footer}
        </div>
      ) : null}
    </>
  );
}
