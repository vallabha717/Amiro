import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageShellProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  backTestId?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Shared layout shell for Agent sub-pages (Channels, Contacts, Memory, Workspace, etc.).
 * Standardizes the top back-link, page title, subtitle, optional right-aligned action,
 * and the responsive master-detail or grid body below.
 */
export function PageShell({
  title,
  subtitle,
  backHref = "/agent",
  backLabel = "Agent Hub",
  backTestId,
  action,
  children,
  className,
}: PageShellProps) {
  return (
    <div
      className={cn(
        "mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-5 overflow-y-auto p-4 sm:p-6",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={backHref}
            data-testid={backTestId || (backLabel.toLowerCase().includes("agent") ? "channels-back-link" : undefined)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {backLabel}
          </Link>
          <div className="flex min-w-0 flex-col">
            <h1 className="font-brand text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
