"use client";

import { AppLogo, ComposioAppsSection } from "@/components/composio-dashboard";
import Link from "next/link";
import { fetcher } from "@/lib/backend/client";
import useSWR from "swr";
import {
  type ConnectorServer,
  type ConnectorStatus,
  removeCustomConnector,
  reloadConnectors,
  secretLabel,
  setConnectorEnabled,
  useConnectors,
} from "@/lib/backend/connectors-api";
import { removeComposioConnection } from "@/lib/backend/composio-api";
import { cn } from "lib/utils";
import {
  AppWindowIcon,
  ChevronDownIcon,
  GlobeIcon,
  KeyRoundIcon,
  Loader2,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCw,
  SparklesIcon,
  TerminalIcon,
  Trash2Icon,
  UnplugIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { Badge } from "ui/badge";
import { Button } from "ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "ui/dropdown-menu";
import { ScrollArea } from "ui/scroll-area";
import { handleErrorWithToast } from "ui/shared-toast";
import { Skeleton } from "ui/skeleton";
import { Switch } from "ui/switch";
import { ConnectorDialog, SecretsDialog } from "./connector-dialogs";

const STATUS: Record<ConnectorStatus, { label: string; dot: string; text: string }> = {
  connected: { label: "Connected", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  error: { label: "Error", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  disabled: { label: "Off", dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
  "needs-secret": { label: "Needs a key", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  unknown: { label: "Checking…", dot: "bg-sky-500 animate-pulse", text: "text-muted-foreground" },
};

export function StatusPill({ status }: { status: ConnectorStatus }) {
  const s = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", s.text)}>
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

function listOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const items = (value as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

function where(server: ConnectorServer): string {
  if (server.transport === "stdio") {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
  }
  try {
    return server.url ? new URL(server.url.replace(/\$\{[^}]+\}/g, "x")).host : "";
  } catch {
    return server.url ?? "";
  }
}

function ServerRow({
  server,
  onEdit,
  onSecrets,
}: {
  server: ConnectorServer;
  onEdit: (s: ConnectorServer) => void;
  onSecrets: (s: ConnectorServer) => void;
}) {
  const { mutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const tools = server.tools ?? [];
  const missing = server.secrets.filter((s) => !s.present);
  const Icon = server.transport === "stdio" ? TerminalIcon : GlobeIcon;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await setConnectorEnabled(server.name, enabled);
      await mutate("/api/connectors");
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${server.name}? Its saved keys are deleted too.`)) return;
    setBusy(true);
    try {
      await removeCustomConnector(server.name);
      toast.success(`Removed ${server.name}`);
      await mutate("/api/connectors");
    } catch (e) {
      handleErrorWithToast(e as Error);
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-border bg-secondary/30 transition-colors hover:border-foreground/15"
      data-testid={`connector-row-${server.name}`}
      data-status={server.status}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{server.name}</span>
            <Badge variant="outline" className="text-[10px] font-normal">
              {server.transport === "stdio" ? "MCP · local" : `MCP · ${server.transport.toUpperCase()}`}
            </Badge>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StatusPill status={server.status} />
            <span className="truncate font-mono text-[11px]">{where(server)}</span>
          </div>
        </div>
        {missing.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => onSecrets(server)} data-testid="connector-add-key">
            <KeyRoundIcon className="size-3.5" />
            Add {missing.length === 1 ? secretLabel(missing[0]) : `${missing.length} keys`}
          </Button>
        )}
        {tools.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-muted-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <WrenchIcon className="size-3.5" />
            {tools.length} tool{tools.length === 1 ? "" : "s"}
            <ChevronDownIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </Button>
        )}
        <Switch
          checked={server.enabled}
          disabled={busy}
          onCheckedChange={toggle}
          aria-label={server.enabled ? `Turn off ${server.name}` : `Turn on ${server.name}`}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-8" aria-label={`More for ${server.name}`}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontalIcon className="size-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(server)}>
              <PencilIcon className="size-4" /> Edit
            </DropdownMenuItem>
            {server.secrets.length > 0 && (
              <DropdownMenuItem onClick={() => onSecrets(server)}>
                <KeyRoundIcon className="size-4" /> Update keys
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={remove}>
              <Trash2Icon className="size-4" /> Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {server.status === "error" && server.error && (
        <p className="border-t border-border px-4 py-2 text-xs text-red-600 dark:text-red-400">{server.error}</p>
      )}
      {open && tools.length > 0 && (
        <ul className="grid gap-x-6 gap-y-1.5 border-t border-border px-4 py-3 sm:grid-cols-2">
          {tools.map((t) => (
            <li key={t.name} className="min-w-0 text-xs">
              <span className="font-mono">{t.name}</span>
              {t.description && <span className="block truncate text-muted-foreground">{t.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A connected Composio app, as a tile (logo, name, live dot, disconnect). */
function ConnectedAppTile({ toolkit, id, status }: { toolkit: string; id: string; status: string }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const active = status === "ACTIVE";
  const name = toolkit.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div
      className={cn(
        "relative flex flex-col items-center gap-2.5 rounded-2xl border p-4 text-center transition-all",
        active ? "border-emerald-500/40 bg-emerald-500/[0.05]" : "border-amber-500/40 bg-amber-500/[0.05]",
      )}
      data-testid={`connector-app-${toolkit}`}
      data-status={status}
    >
      <span
        className={cn(
          "absolute right-3 top-3 size-2 rounded-full",
          active ? "animate-pulse bg-emerald-500" : "bg-amber-500",
        )}
        aria-label={active ? "Connected" : status.toLowerCase()}
      />
      <AppLogo name={name} logo={`https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`} />
      <div className="w-full min-w-0">
        <p className="truncate text-sm font-semibold">{name}</p>
        <p className={cn("text-[11px]", active ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600")}>
          {active ? "Connected" : status === "INITIATED" ? "Finishing sign-in…" : "Needs attention"}
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 w-full text-xs font-semibold text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await removeComposioConnection(id);
            toast.success(`Disconnected ${name}`);
            await Promise.all([mutate("/api/composio/connections"), mutate("/api/connectors")]);
          } catch (e) {
            handleErrorWithToast(e as Error);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <UnplugIcon className="size-3.5" />}
        Disconnect
      </Button>
    </div>
  );
}

/**
 * Connectors: one place for everything the agent can reach. Apps connected
 * through Composio and custom MCP servers (remote or local) are the same
 * thing to the agent -- entries in the runtime's mcp.json -- so they are
 * listed together, and the agent can add more on its own.
 */
export function ConnectorsPage() {
  const { mutate } = useSWRConfig();
  const { data, isLoading } = useConnectors();
  // Composio answers 400 until a key is configured; don't ask before then.
  const { data: rawConnections } = useSWR<unknown>(
    data?.composio.configured ? "/api/composio/connections" : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "edit"; server: ConnectorServer } | null>(null);
  const [secretsFor, setSecretsFor] = useState<ConnectorServer | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const custom = useMemo(() => (data?.servers ?? []).filter((s) => s.source === "custom"), [data]);
  const connections = useMemo(
    () => listOf<{ id: string; toolkit: string; status: string }>(rawConnections),
    [rawConnections],
  );
  const composioConfigured = data?.composio.configured ?? false;
  const total = custom.length + connections.length;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await reloadConnectors();
      await mutate("/api/connectors", next, false);
      await mutate("/api/composio/connections");
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <ScrollArea className="z-40 h-full w-full">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-8 pb-12 pt-8" data-testid="connectors-page">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold">Connectors</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Apps and MCP servers your agent can use. Everything here is available in every chat.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing} data-testid="connectors-refresh">
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setDialog({ mode: "add" })} data-testid="connectors-add-custom">
            <PlusIcon className="size-4" />
            Add custom
          </Button>
        </header>

        <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm">
          <SparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">Or just ask your agent.</span> Say "connect the Linear MCP
            server" or "add the GitHub MCP server". It finds the server, adds it here, and asks you for any key in a
            secure card — the key never goes through the chat.
          </p>
        </div>

        <section className="flex flex-col gap-3" data-testid="connectors-yours">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            Your connectors
            {total > 0 && <span className="text-xs font-normal text-muted-foreground">{total}</span>}
            {data && !data.statusAvailable && custom.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                · live status appears once a chat session is running
              </span>
            )}
          </h2>
          {isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border px-6 py-10 text-center">
              <AppWindowIcon className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">Nothing connected yet</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Connect an app below, add a custom MCP server, or ask your agent to set one up.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {connections.length > 0 && (
                <div
                  className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
                  data-testid="connectors-connected-apps"
                >
                  {connections.map((c) => (
                    <ConnectedAppTile key={c.id} id={c.id} toolkit={c.toolkit} status={c.status} />
                  ))}
                </div>
              )}
              {custom.length > 0 && (
                <div className="flex flex-col gap-2">
                  {connections.length > 0 && (
                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      MCP servers
                    </h3>
                  )}
                  {custom.map((server) => (
                    <ServerRow
                      key={server.name}
                      server={server}
                      onEdit={(s) => setDialog({ mode: "edit", server: s })}
                      onSecrets={setSecretsFor}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {isLoading ? null : composioConfigured ? (
          <ComposioAppsSection />
        ) : (
          <section className="flex flex-col gap-3" data-testid="connectors-apps-setup">
            <h2 className="text-base font-semibold">
              Apps <span className="text-xs font-normal text-muted-foreground">via Composio</span>
            </h2>
            <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-secondary/30 px-5 py-4">
              <div className="flex -space-x-2">
                {["gmail", "slack", "github", "notion"].map((slug) => (
                  <AppLogo
                    key={slug}
                    name={slug}
                    logo={`https://logos.composio.dev/api/${slug}`}
                    className="size-9 rounded-full p-1.5 ring-2 ring-background"
                  />
                ))}
              </div>
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">1,000+ apps in one click.</span> Gmail, Slack, GitHub,
                Notion and more, once an admin adds the Composio key.
              </p>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/integrations">Set up in Admin</Link>
              </Button>
            </div>
          </section>
        )}
      </div>

      {dialog && (
        <ConnectorDialog
          initial={dialog.mode === "edit" ? dialog.server : undefined}
          onClose={() => setDialog(null)}
        />
      )}
      {secretsFor && <SecretsDialog server={secretsFor} onClose={() => setSecretsFor(null)} />}
    </ScrollArea>
  );
}
