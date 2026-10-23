"use client";

import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Shared pieces for the onboarding steps: one quiet visual language. */

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-xs font-medium uppercase tracking-[0.14em] text-[var(--onb-accent)]">
      {children}
    </p>
  );
}

export function StepTitle({
  children,
  sub,
}: {
  children: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="mb-8">
      <h1 className="font-brand text-[2.5rem] leading-[1.05] tracking-[-0.02em] text-balance sm:text-5xl">
        {children}
      </h1>
      {sub && (
        <p className="mt-4 max-w-[38ch] text-[17px] leading-relaxed text-muted-foreground text-pretty">
          {sub}
        </p>
      )}
    </div>
  );
}

export function PrimaryButton({
  loading,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cn(
        "inline-flex h-12 min-w-36 items-center justify-center gap-2 rounded-full px-7 text-[15px] font-medium text-[var(--onb-on-accent,#fff)]",
        "bg-[var(--onb-accent)] shadow-[0_1px_0_rgba(255,255,255,.25)_inset,0_8px_24px_-12px_var(--onb-accent)]",
        "transition-[transform,filter,opacity] duration-200 hover:brightness-110 active:scale-[0.98]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function QuietButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-12 items-center rounded-full px-5 text-[15px] text-muted-foreground transition-colors",
        "hover:bg-foreground/5 hover:text-foreground disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onb-accent)]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="mt-10 flex flex-wrap items-center gap-2">{children}</div>
  );
}

export function FieldLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {children}
      </label>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export const inputClass = cn(
  "h-12 w-full rounded-xl border border-foreground/10 bg-background/70 px-4 text-[15px] backdrop-blur",
  "placeholder:text-muted-foreground/60 transition-[border-color,box-shadow]",
  "focus:border-[var(--onb-accent)] focus:outline-none focus:ring-4 focus:ring-[color-mix(in_oklab,var(--onb-accent)_18%,transparent)]",
  "disabled:opacity-60",
);

export function ConfigBadge({ source }: { source: string | null }) {
  if (!source) return null;
  return (
    <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-foreground/10 px-3 py-1 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-[var(--onb-accent)]" />
      Set from <span className="font-mono">{source}</span>
    </p>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[0.85em]">
      {children}
    </code>
  );
}
