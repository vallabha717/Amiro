"use client";

import { AppSidebar } from "@/components/layouts/app-sidebar";
import { setAgentScope } from "@/lib/backend/agent-scope";
import { useSession } from "@/lib/backend/session-context";
import { ArrowUpRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "ui/button";
import { SidebarProvider } from "ui/sidebar";

/**
 * The frame for Team: the collapsed sidebar rail on the left (closed only,
 * matching the closed sidebar in the agent page), followed by the floating
 * team window hosting agent profiles and the chat channel.
 */
export function TeamShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Team");
  const { data: session } = useSession();

  return (
    <SidebarProvider
      open={false}
      defaultOpen={false}
      className="h-svh overflow-hidden bg-canvas workspace-canvas motion-reduce:[&_*]:transition-none"
    >
      <AppSidebar user={session?.user} />
      <div className="flex h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2 md:py-4 md:pr-4 md:pl-2">
        <main
          data-testid="team-window"
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-background shadow-panel"
        >
          <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 md:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-brand text-lg font-bold tracking-tight text-foreground">
                Amiro
              </span>
              <span className="rounded-full border bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t("title")}
              </span>
            </div>
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
          <div className="custom-scrollbar relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
