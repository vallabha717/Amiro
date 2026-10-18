"use client";

import Link from "next/link";
import { ArrowRight, PlugZap, Puzzle } from "lucide-react";
import { ScrollArea } from "ui/scroll-area";
import { Card, CardDescription, CardHeader, CardTitle } from "ui/card";

/**
 * Admin → Integrations & MCP (Vellum-style preferences page).
 *
 * Provides unified access to App Connectors (`/connectors`) and MCP Servers
 * (`/mcp`) inside the Admin Preferences shell.
 */
export default function AdminIntegrationsPage() {
  return (
    <ScrollArea className="h-full w-full">
      <div className="max-w-3xl mx-auto px-8 py-8 flex flex-col gap-6">
        <div>
          <h3 className="text-xl font-semibold">Integrations &amp; MCP</h3>
          <p className="text-sm text-muted-foreground pt-2">
            Connect external apps, OAuth toolkits, and Model Context Protocol
            (MCP) servers so your assistant can work across your tools.
          </p>
        </div>

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

          <Link href="/mcp" data-testid="admin-integrations-mcp-link">
            <Card className="cursor-pointer transition-colors hover:bg-accent/40">
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/40">
                  <Puzzle className="size-5 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base">
                    MCP Configuration
                  </CardTitle>
                  <CardDescription>
                    Add, edit, and test Model Context Protocol servers and their
                    tools.
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
