"use client";

import { ApiKeyPanel, ComposioSetupCard } from "@/components/composio-dashboard";
import { useComposioConfig } from "@/hooks/queries/use-composio";
import { Skeleton } from "ui/skeleton";

import Link from "next/link";
import { ArrowRight, KeyRound, PlugZap, Puzzle } from "lucide-react";
import { ScrollArea } from "ui/scroll-area";
import { Card, CardDescription, CardHeader, CardTitle } from "ui/card";

/**
 * Admin → Integrations & MCP (Vellum-style preferences page).
 *
 * Provides unified access to App Connectors (`/connectors`) and MCP Servers
 * (`/mcp`) inside the Admin Preferences shell.
 */
function ComposioKeySection() {
  const { data: config, isLoading } = useComposioConfig();
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  return config?.configured ? <ApiKeyPanel /> : <ComposioSetupCard />;
}

export default function AdminIntegrationsPage() {
  return (
    <ScrollArea className="h-full w-full">
      <div className="max-w-3xl mx-auto px-8 py-8 flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold">Integrations &amp; MCP</h1>
          <p className="text-sm text-muted-foreground pt-2">
            Connect external apps, OAuth toolkits, and Model Context Protocol
            (MCP) servers so your assistant can work across your tools.
          </p>
        </div>

        <section className="flex flex-col gap-3" data-testid="admin-integrations-composio">
          <div>
            <h4 className="text-sm font-semibold">Composio</h4>
            <p className="text-xs text-muted-foreground">
              The key that unlocks one-click apps on the Connectors page. Set it once here; everyone on this
              Amiro then connects their own accounts.
            </p>
          </div>
          <ComposioKeySection />
        </section>

        <div className="grid gap-4">
          <Link href="/connectors" data-testid="admin-integrations-tab-connectors">
            <Card className="cursor-pointer transition-colors hover:bg-accent/40">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/40">
                  <PlugZap className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base">App Connectors</CardTitle>
                  <CardDescription>
                    Browse and connect OAuth app toolkits and API credentials.
                  </CardDescription>
                </div>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </CardHeader>
            </Card>
          </Link>

          <Link
            href="/admin/credentials"
            data-testid="admin-integrations-credentials-link"
          >
            <Card className="cursor-pointer transition-colors hover:bg-accent/40">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/40">
                  <KeyRound className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base">
                    Credentials &amp; Secret Vault
                  </CardTitle>
                  <CardDescription>
                    Encrypted API keys, tokens, and agent environment variable
                    bindings ($AMIRO_CRED_*).
                  </CardDescription>
                </div>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </CardHeader>
            </Card>
          </Link>

          <Link href="/connectors" data-testid="admin-integrations-mcp-link">
            <Card className="cursor-pointer transition-colors hover:bg-accent/40">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/40">
                  <Puzzle className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base">
                    Custom MCP servers
                  </CardTitle>
                  <CardDescription>
                    Now part of Connectors: add remote or local MCP servers,
                    store their keys in the vault, and see their tools.
                  </CardDescription>
                </div>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </CardHeader>
            </Card>
          </Link>
        </div>
      </div>
    </ScrollArea>
  );
}
