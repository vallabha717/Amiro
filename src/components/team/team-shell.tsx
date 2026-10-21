"use client";

import { VrndaLogo } from "@/components/layouts/vrnda-logo";
import { setAgentScope } from "@/lib/backend/agent-scope";
import { ArrowUpRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "ui/button";

/**
 * The full-page frame for Team: a slim top bar (brand, a way back to the
 * main Amiro UI) above one floating panel on the workspace canvas, the same
 * canvas and panel tokens the main shell uses so every theme carries over.
 */
export function TeamShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Team");
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-canvas workspace-canvas">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 md:px-6">
        <Link
          href="/team"
          className="flex min-w-0 items-center gap-2"
          aria-label={t("homeLabel")}
        >
          <VrndaLogo className="size-6" />
          <span className="font-brand text-xl font-bold tracking-tight text-foreground">
            Amiro
          </span>
          <span className="rounded-full border bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {t("title")}
          </span>
        </Link>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="bg-background/70"
          data-testid="team-open-amiro"
        >
          <Link href="/amiro" onClick={() => setAgentScope(null)}>
            {t("openAmiro")}
            <ArrowUpRightIcon className="size-4" />
          </Link>
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 md:px-4 md:pb-4">
        <main
          data-testid="team-window"
          className="custom-scrollbar relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden rounded-2xl border bg-background shadow-panel"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
