"use client";

import useSWR from "swr";
import { apiJson, fetcher } from "./client";

/**
 * One connector the agent can use, as backend/src/routes/connectors.rs
 * reports it. Every connector lives in the runtime's mcp.json -- Composio's
 * Tool Router is one entry, custom MCP servers are the rest -- so this is the
 * single list the Connectors page and the agent agree on.
 */
export interface ConnectorSecret {
  /** Vault field under service `mcp.<name>`. */
  field: string;
  envVar: string;
  /** "header:Authorization", "env:GITHUB_TOKEN", "arg" or "url". */
  location: string;
  present: boolean;
}

export type ConnectorStatus =
  | "connected"
  | "error"
  | "disabled"
  | "needs-secret"
  | "unknown";

export interface ConnectorServer {
  name: string;
  source: "composio" | "custom";
  transport: "stdio" | "http" | "sse";
  url?: string;
  command?: string;
  args?: string[];
  headerNames: string[];
  envNames: string[];
  enabled: boolean;
  secrets: ConnectorSecret[];
  status: ConnectorStatus;
  error: string | null;
  tools: { name: string; description?: string }[] | null;
}

export interface ConnectorsSnapshot {
  composio: { configured: boolean };
  statusAvailable: boolean;
  servers: ConnectorServer[];
}

export interface KeyValueEntry {
  name: string;
  value: string;
  secret: boolean;
}

export interface CustomConnectorInput {
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headers?: KeyValueEntry[];
  env?: KeyValueEntry[];
}

export const CONNECTORS_KEY = "/api/connectors";

export function useConnectors() {
  return useSWR<ConnectorsSnapshot>(CONNECTORS_KEY, fetcher, {
    // Status comes from the live runtime; a server that is still starting
    // settles within a few seconds.
    refreshInterval: (data) =>
      data?.servers.some((s) => s.status === "unknown") ? 4000 : 20000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });
}

export function saveCustomConnector(input: CustomConnectorInput) {
  return apiJson<ConnectorServer>("/api/connectors/custom", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function saveConnectorSecrets(name: string, secrets: Record<string, string>) {
  return apiJson<ConnectorServer>(
    `/api/connectors/custom/${encodeURIComponent(name)}/secrets`,
    { method: "PUT", body: JSON.stringify({ secrets }) },
  );
}

/** An MCP OAuth sign-in, as backend/src/routes/connectors.rs reports it. */
export interface ConnectorOAuthFlow {
  server: string;
  status: "pending" | "authorized" | "error" | "expired";
  authorizationUrl: string;
  error?: string | null;
}

/** Starts the browser OAuth sign-in for a remote MCP connector. */
export function startConnectorOAuth(name: string) {
  return apiJson<ConnectorOAuthFlow>(
    `/api/connectors/${encodeURIComponent(name)}/oauth/start`,
    { method: "POST" },
  );
}

export function connectorOAuthStatus(name: string) {
  return apiJson<ConnectorOAuthFlow>(
    `/api/connectors/${encodeURIComponent(name)}/oauth/status`,
  );
}

export function setConnectorEnabled(name: string, enabled: boolean) {
  return apiJson<unknown>(`/api/connectors/${encodeURIComponent(name)}/enabled`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
}

export function removeCustomConnector(name: string) {
  return apiJson<unknown>(`/api/connectors/custom/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function reloadConnectors() {
  return apiJson<ConnectorsSnapshot>("/api/connectors/reload", { method: "POST" });
}

/** Slug rules shared with the backend and the runtime's `mcp add`. */
export function connectorSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Split a pasted command line into command + args, honouring quotes. */
export function splitCommandLine(line: string): { command: string; args: string[] } {
  const parts: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) parts.push(m[1] ?? m[2] ?? m[3]);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

/** Human label for a secret: its header or env name. */
export function secretLabel(secret: ConnectorSecret): string {
  const [, name] = secret.location.split(":");
  return name || secret.field;
}

/**
 * The runtime's `mcp add` ends its output with
 * `CONNECTOR_SETUP {"server":"…","missingSecrets":[…]}`.
 */
export function parseConnectorSetup(
  output: unknown,
): { server: string; missingSecrets: string[] } | null {
  const text =
    typeof output === "string"
      ? output
      : output && typeof output === "object"
        ? JSON.stringify(output)
        : "";
  const at = text.lastIndexOf("CONNECTOR_SETUP");
  if (at < 0) return null;
  const start = text.indexOf("{", at);
  if (start < 0) return null;
  // Walk to the matching brace; the JSON may be followed by other text, or be
  // escaped inside a stringified tool output.
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      const raw = text.slice(start, i + 1);
      for (const candidate of [raw, raw.replace(/\\"/g, '"')]) {
        try {
          const v = JSON.parse(candidate);
          if (typeof v?.server === "string") {
            return {
              server: v.server,
              missingSecrets: Array.isArray(v.missingSecrets) ? v.missingSecrets : [],
            };
          }
        } catch {
          // try the next shape
        }
      }
      return null;
    }
  }
  return null;
}
