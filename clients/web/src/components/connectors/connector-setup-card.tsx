"use client";

import { useConnectors } from "@/lib/backend/connectors-api";
import { CheckCircle2Icon, ExternalLinkIcon, Loader2, PlugZapIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "ui/button";
import { StatusPill } from "./connectors-page";
import { SecretsForm } from "./connector-dialogs";

/**
 * Shown under a turn in which the agent added a connector with `mcp add`.
 * The key goes from this card straight to the encrypted vault -- the agent
 * asked for it by name and never sees the value (Vellum's credential prompt,
 * in Amiro's chat).
 */
export function ConnectorSetupCard({
  server: name,
  missingSecrets,
  readonly,
  onDone,
}: {
  server: string;
  missingSecrets: string[];
  readonly?: boolean;
  /** Tells the agent the key is in, so it can connect and carry on. */
  onDone?: (text: string) => void;
}) {
  const { data, isLoading } = useConnectors();
  const [told, setTold] = useState(false);
  const server = data?.servers.find((s) => s.name === name);
  const stillMissing = server?.secrets.filter((s) => !s.present && (!missingSecrets.length || missingSecrets.includes(s.field))) ?? [];
  const tools = server?.tools ?? [];

  return (
    <div
      className="my-2 w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      data-testid="connector-setup-card"
      data-server={name}
    >
      <div className="flex items-center gap-2.5 border-b border-border bg-muted/40 px-3.5 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
          <PlugZapIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="text-[11px] text-muted-foreground">New connector</p>
        </div>
        {server && <StatusPill status={server.status} />}
      </div>

      <div className="px-3.5 py-3">
        {isLoading && !server ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Checking…
          </p>
        ) : !server ? (
          <p className="text-xs text-muted-foreground">This connector was removed.</p>
        ) : stillMissing.length > 0 ? (
          readonly ? (
            <p className="text-xs text-muted-foreground">Waiting for a key.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                Paste the key here. It's stored encrypted and never shown to the agent or kept in the chat.
              </p>
              <SecretsForm server={server} only={stillMissing.map((s) => s.field)} compact />
            </div>
          )
        ) : (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1.5 text-sm">
              <CheckCircle2Icon className="size-4 text-emerald-600" />
              {server.status === "connected"
                ? `Connected${tools.length ? ` · ${tools.length} tool${tools.length === 1 ? "" : "s"}` : ""}`
                : "Key saved"}
            </p>
            {tools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tools.slice(0, 8).map((t) => (
                  <span key={t.name} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    {t.name}
                  </span>
                ))}
                {tools.length > 8 && <span className="text-[10px] text-muted-foreground">+{tools.length - 8} more</span>}
              </div>
            )}
            {server.status === "error" && server.error && (
              <p className="text-xs text-red-600 dark:text-red-400">{server.error}</p>
            )}
            <div className="flex items-center gap-2 pt-1">
              {onDone && !told && (
                <Button
                  size="sm"
                  onClick={() => {
                    setTold(true);
                    onDone(`I've added the key for ${name}. Please connect it and continue.`);
                  }}
                  data-testid="connector-setup-continue"
                >
                  Continue with {name}
                </Button>
              )}
              <Button asChild size="sm" variant="ghost">
                <Link href="/connectors">
                  <ExternalLinkIcon className="size-3.5" /> Connectors
                </Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
