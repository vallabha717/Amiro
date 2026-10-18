"use client";

import {
  type ConnectorServer,
  type KeyValueEntry,
  connectorSlug,
  saveConnectorSecrets,
  saveCustomConnector,
  secretLabel,
  splitCommandLine,
} from "@/lib/backend/connectors-api";
import { cn } from "lib/utils";
import { GlobeIcon, KeyRoundIcon, Loader2, LockIcon, PlusIcon, TerminalIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { Button } from "ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "ui/dialog";
import { Input } from "ui/input";
import { Label } from "ui/label";
import { handleErrorWithToast } from "ui/shared-toast";

type Auth = "none" | "bearer" | "header";

const SECRET_NAME = /(token|key|secret|password|auth|credential)/i;

/** A list of name/value rows with a per-row "secret" lock. */
function EntryRows({
  label,
  rows,
  onChange,
  namePlaceholder,
  editing,
  testId,
}: {
  label: string;
  rows: KeyValueEntry[];
  onChange: (rows: KeyValueEntry[]) => void;
  namePlaceholder: string;
  editing: boolean;
  testId: string;
}) {
  const set = (i: number, patch: Partial<KeyValueEntry>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => onChange([...rows, { name: "", value: "", secret: false }])}
        >
          <PlusIcon className="size-3" /> Add
        </Button>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={row.name}
            placeholder={namePlaceholder}
            className="h-8 w-2/5 font-mono text-xs"
            onChange={(e) => {
              const name = e.target.value;
              set(i, { name, secret: row.secret || SECRET_NAME.test(name) });
            }}
          />
          <Input
            value={row.value}
            type={row.secret ? "password" : "text"}
            autoComplete="off"
            placeholder={editing ? (row.secret ? "•••• saved — leave blank to keep" : "unchanged") : "value"}
            className="h-8 flex-1 font-mono text-xs"
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <Button
            type="button"
            size="icon"
            variant={row.secret ? "secondary" : "ghost"}
            className="size-8"
            title={row.secret ? "Stored encrypted in the vault" : "Mark as secret"}
            onClick={() => set(i, { secret: !row.secret })}
            aria-pressed={row.secret}
          >
            <LockIcon className={cn("size-3.5", !row.secret && "opacity-40")} />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label="Remove row"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Add or edit a custom MCP connector. */
export function ConnectorDialog({
  initial,
  onClose,
}: {
  initial?: ConnectorServer;
  onClose: () => void;
}) {
  const { mutate } = useSWRConfig();
  const editing = !!initial;
  const secretAt = new Set(initial?.secrets.map((s) => s.location) ?? []);
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"remote" | "local">(initial?.transport === "stdio" ? "local" : "remote");
  const [transport, setTransport] = useState<"http" | "sse">(initial?.transport === "sse" ? "sse" : "http");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [commandLine, setCommandLine] = useState(
    initial?.transport === "stdio" ? [initial.command, ...(initial.args ?? [])].filter(Boolean).join(" ") : "",
  );
  const existingAuth = initial?.headerNames.find((h) => h.toLowerCase() === "authorization");
  const [auth, setAuth] = useState<Auth>(existingAuth ? "bearer" : "none");
  const [authHeader, setAuthHeader] = useState("X-API-Key");
  const [authValue, setAuthValue] = useState("");
  const [headers, setHeaders] = useState<KeyValueEntry[]>(
    (initial?.headerNames ?? [])
      .filter((h) => h !== existingAuth)
      .map((h) => ({ name: h, value: "", secret: secretAt.has(`header:${h}`) })),
  );
  const [env, setEnv] = useState<KeyValueEntry[]>(
    (initial?.envNames ?? []).map((n) => ({ name: n, value: "", secret: secretAt.has(`env:${n}`) })),
  );
  const [saving, setSaving] = useState(false);

  const slug = connectorSlug(name);
  const valid =
    slug.length > 0 &&
    (kind === "remote" ? /^https?:\/\//.test(url.trim()) : splitCommandLine(commandLine).command.length > 0);

  const save = async () => {
    setSaving(true);
    try {
      const allHeaders = headers.filter((h) => h.name.trim());
      if (kind === "remote" && auth === "bearer") {
        allHeaders.unshift({
          name: "Authorization",
          value: authValue.trim() ? `Bearer ${authValue.trim().replace(/^Bearer\s+/i, "")}` : "",
          secret: true,
        });
      } else if (kind === "remote" && auth === "header" && authHeader.trim()) {
        allHeaders.unshift({ name: authHeader.trim(), value: authValue.trim(), secret: true });
      }
      const { command, args } = splitCommandLine(commandLine);
      const server = await saveCustomConnector(
        kind === "remote"
          ? { name: slug, transport, url: url.trim(), headers: allHeaders }
          : { name: slug, transport: "stdio", command, args, env: env.filter((e) => e.name.trim()) },
      );
      await mutate("/api/connectors");
      const tools = server.tools?.length;
      toast.success(
        server.status === "connected"
          ? `${server.name} connected${tools ? ` · ${tools} tools` : ""}`
          : server.status === "needs-secret"
            ? `${server.name} saved — add its key to finish`
            : `${server.name} saved`,
      );
      onClose();
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="connector-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${initial?.name}` : "Add a custom connector"}</DialogTitle>
          <DialogDescription>
            Any MCP server: a remote URL, or a command that runs on this machine. Keys are stored encrypted and
            never shown to the agent.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="connector-name" className="text-xs">
              Name
            </Label>
            <Input
              id="connector-name"
              value={name}
              disabled={editing}
              placeholder="linear"
              onChange={(e) => setName(e.target.value)}
              data-testid="connector-name"
            />
            {name && slug !== name && <p className="text-[11px] text-muted-foreground">Saved as "{slug}"</p>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["remote", GlobeIcon, "Remote URL", "HTTP or SSE endpoint"],
                ["local", TerminalIcon, "Local command", "Runs on this machine"],
              ] as const
            ).map(([k, Icon, title, sub]) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                data-testid={`connector-kind-${k}`}
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                  kind === k ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
                )}
              >
                <Icon className="mt-0.5 size-4 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-[11px] text-muted-foreground">{sub}</span>
                </span>
              </button>
            ))}
          </div>

          {kind === "remote" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="connector-url" className="text-xs">
                  Server URL
                </Label>
                <div className="flex gap-1.5">
                  <Input
                    id="connector-url"
                    value={url}
                    placeholder="https://mcp.linear.app/mcp"
                    className="flex-1 font-mono text-xs"
                    onChange={(e) => setUrl(e.target.value)}
                    data-testid="connector-url"
                  />
                  <select
                    value={transport}
                    onChange={(e) => setTransport(e.target.value as "http" | "sse")}
                    className="h-9 rounded-md border border-input bg-transparent px-2 text-xs"
                    aria-label="Transport"
                  >
                    <option value="http">Streamable HTTP</option>
                    <option value="sse">SSE</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Authentication</Label>
                <div className="flex gap-1 rounded-lg border bg-secondary/40 p-1">
                  {(
                    [
                      ["none", "None"],
                      ["bearer", "Bearer token"],
                      ["header", "API key header"],
                    ] as const
                  ).map(([k, l]) => (
                    <Button
                      key={k}
                      type="button"
                      size="sm"
                      variant={auth === k ? "secondary" : "ghost"}
                      className="flex-1"
                      onClick={() => setAuth(k)}
                    >
                      {l}
                    </Button>
                  ))}
                </div>
                {auth !== "none" && (
                  <div className="flex gap-1.5">
                    {auth === "header" && (
                      <Input
                        value={authHeader}
                        onChange={(e) => setAuthHeader(e.target.value)}
                        className="h-8 w-2/5 font-mono text-xs"
                        aria-label="Header name"
                      />
                    )}
                    <Input
                      type="password"
                      autoComplete="off"
                      value={authValue}
                      onChange={(e) => setAuthValue(e.target.value)}
                      placeholder={editing && existingAuth ? "•••• saved — leave blank to keep" : "Paste token"}
                      className="h-8 flex-1 font-mono text-xs"
                      data-testid="connector-token"
                    />
                  </div>
                )}
              </div>
              <EntryRows
                label="Extra headers"
                rows={headers}
                onChange={setHeaders}
                namePlaceholder="Header-Name"
                editing={editing}
                testId="connector-headers"
              />
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="connector-command" className="text-xs">
                  Command
                </Label>
                <Input
                  id="connector-command"
                  value={commandLine}
                  placeholder="npx -y @modelcontextprotocol/server-github"
                  className="font-mono text-xs"
                  onChange={(e) => setCommandLine(e.target.value)}
                  data-testid="connector-command"
                />
              </div>
              <EntryRows
                label="Environment variables"
                rows={env}
                onChange={setEnv}
                namePlaceholder="GITHUB_TOKEN"
                editing={editing}
                testId="connector-env"
              />
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!valid || saving} data-testid="connector-save">
            {saving && <Loader2 className="size-4 animate-spin" />}
            {editing ? "Save" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Secure inputs for a connector's missing keys. Values go straight to the
 * encrypted vault; neither the chat nor the agent ever sees them.
 */
export function SecretsForm({
  server,
  only,
  onSaved,
  compact,
}: {
  server: ConnectorServer;
  /** Restrict to these fields (the ones the agent asked for). */
  only?: string[];
  onSaved?: (server: ConnectorServer) => void;
  compact?: boolean;
}) {
  const { mutate } = useSWRConfig();
  const fields = server.secrets.filter((s) => !only?.length || only.includes(s.field));
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const filled = fields.some((f) => values[f.field]?.trim());

  const save = async () => {
    setSaving(true);
    try {
      const secrets = Object.fromEntries(
        Object.entries(values)
          .map(([k, v]) => [k, v.trim()])
          .filter(([, v]) => v),
      );
      const next = await saveConnectorSecrets(server.name, secrets);
      setValues({});
      await mutate("/api/connectors");
      onSaved?.(next);
    } catch (e) {
      handleErrorWithToast(e as Error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled && !saving) void save();
      }}
      data-testid="connector-secrets-form"
    >
      {fields.map((f) => (
        <div key={f.field} className="flex flex-col gap-1">
          {!compact && (
            <Label className="flex items-center gap-1.5 text-xs">
              {secretLabel(f)}
              {f.present && <span className="font-normal text-muted-foreground">· saved</span>}
            </Label>
          )}
          <div className="relative">
            <KeyRoundIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="password"
              autoComplete="off"
              value={values[f.field] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
              placeholder={f.present ? "•••• saved — paste to replace" : `Paste ${secretLabel(f)}`}
              className="h-9 pl-8 font-mono text-xs"
              aria-label={secretLabel(f)}
              data-testid={`connector-secret-${f.field}`}
            />
          </div>
        </div>
      ))}
      <Button type="submit" size="sm" disabled={!filled || saving} data-testid="connector-secrets-save">
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : <LockIcon className="size-3.5" />}
        Save securely
      </Button>
    </form>
  );
}

export function SecretsDialog({ server, onClose }: { server: ConnectorServer; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keys for {server.name}</DialogTitle>
          <DialogDescription>Stored encrypted in the vault. The agent never sees them.</DialogDescription>
        </DialogHeader>
        <SecretsForm
          server={server}
          onSaved={(next) => {
            toast.success(
              next.status === "connected" ? `${next.name} connected` : `Saved keys for ${next.name}`,
            );
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
