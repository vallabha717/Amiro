"use client";

import { useSession } from "@/lib/backend/session-context";
import {
  LATER,
  type OnboardingStepId,
  useOnboarding,
} from "@/lib/onboarding/onboarding-api";
import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

const DISMISS_KEY = "amiro:setup-checklist-dismissed";

/**
 * Sidebar reminder for steps skipped in onboarding: each links to where it
 * can be finished, and disappears once that step is actually done.
 */
export function SetupChecklist() {
  const { data: session } = useSession();
  const isOwner = session?.user.role === "admin";
  const { data } = useOnboarding(isOwner);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === data?.completedAt);
  }, [data?.completedAt]);

  if (!data?.completed || dismissed) return null;
  const pending = (["provider", "agent"] as OnboardingStepId[]).filter(
    (id) => data.skipped.includes(id) && !data.steps[id].done,
  );
  if (pending.length === 0) return null;

  return (
    <div
      className="relative rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-3 text-xs"
      data-testid="setup-checklist"
    >
      <button
        type="button"
        aria-label="Dismiss"
        className="absolute right-2 top-2 rounded p-0.5 text-muted-foreground hover:text-foreground"
        onClick={() => {
          if (data.completedAt)
            localStorage.setItem(DISMISS_KEY, data.completedAt);
          setDismissed(true);
        }}
      >
        <X className="size-3.5" />
      </button>
      <p className="mb-2 font-medium text-sidebar-foreground">
        Finish setting up
      </p>
      <ul className="space-y-1.5">
        {pending.map((id) => (
          <li key={id}>
            <Link
              href={LATER[id].href}
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground"
            >
              <span className="size-3.5 rounded-full border border-dashed border-current" />
              {id === "provider" ? "Connect an AI provider" : "Name your agent"}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
