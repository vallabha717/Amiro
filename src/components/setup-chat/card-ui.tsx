"use client";

import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Button } from "ui/button";

/** The answer card under an agent turn. */
export function SetupCard({
  children,
  testId,
  className,
}: {
  children: ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mt-3 rounded-2xl border bg-card p-4 shadow-sm sm:p-5",
        className,
      )}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function CardActions({
  children,
  onSkip,
  skipLabel,
  busy,
}: {
  children?: ReactNode;
  onSkip?: () => void;
  skipLabel?: string;
  busy?: boolean;
}) {
  const t = useTranslations("SetupChat");
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {children}
      {onSkip && (
        <Button
          variant="ghost"
          onClick={onSkip}
          disabled={busy}
          data-testid="setup-skip"
        >
          {skipLabel ?? t("skip")}
        </Button>
      )}
    </div>
  );
}

/** One option in a grid of choices: a provider, a search engine, a voice. */
export function ChoiceButton({
  title,
  subtitle,
  badge,
  connected,
  onClick,
  testId,
  disabled,
}: {
  title: string;
  subtitle?: string | null;
  badge?: string | null;
  connected?: boolean;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  const t = useTranslations("SetupChat");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-xl border bg-background p-3 text-left transition-colors",
        "hover:border-ring hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        connected && "border-emerald-500/40",
      )}
      data-testid={testId}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted font-medium text-sm">
        {title.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{title}</span>
          {badge && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {badge}
            </span>
          )}
        </span>
        {subtitle && (
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
        {connected && (
          <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" strokeWidth={3} />
            {t("connected")}
          </span>
        )}
      </span>
    </button>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-3 text-sm text-destructive">
      {error}
    </p>
  );
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
