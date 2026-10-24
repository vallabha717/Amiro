"use client";

// Replaces src/app/api/mcp/actions.ts's client-callable exports with
// fetches against the Go sidecar. Not ported: authorizeMcpClientAction/
// checkTokenMcpClientAction (OAuth -- see oauth-redirect.ts's doc
// comment). existMcpClientByServerNameAction has no dedicated endpoint;
// callers resolve it from the already-fetched server list instead (see
// mcp-editor.tsx).
import { apiJson } from "./client";

export async function selectMcpClients() {
  return apiJson<unknown[]>("/api/mcp/list");
}

export async function selectMcpClient(id: string) {
  return apiJson(`/api/mcp/servers/${id}`);
}

export async function saveMcpClient(server: unknown) {
  return apiJson("/api/mcp", {
    method: "POST",
    body: JSON.stringify(server),
  });
}

export async function removeMcpClient(id: string) {
  await apiJson(`/api/mcp/servers/${id}`, { method: "DELETE" });
}

export async function refreshMcpClient(id: string) {
  await apiJson(`/api/mcp/servers/${id}/refresh`, { method: "POST" });
}

export async function callMcpTool(id: string, toolName: string, input: unknown) {
  return apiJson(
    `/api/mcp/servers/${id}/tools/${encodeURIComponent(toolName)}/call`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

// No by-server-name call endpoint on the sidecar (only by-id, see
// callMcpTool above); resolved client-side off the already-fetched list,
// the same simplification existMcpClientByServerNameAction's replacement
// (mcp-editor.tsx) uses.
export async function callMcpToolByServerName(
  serverName: string,
  toolName: string,
  input: unknown,
) {
  const servers = await selectMcpClients();
  const server = servers.find(
    (s) => (s as { name?: string }).name === serverName,
  ) as { id: string } | undefined;
  if (!server) {
    throw new Error(`MCP server not found: ${serverName}`);
  }
  return callMcpTool(server.id, toolName, input);
}

export async function shareMcpServer(
  id: string,
  visibility: "public" | "private",
) {
  return apiJson(`/api/mcp/servers/${id}/share`, {
    method: "POST",
    body: JSON.stringify({ visibility }),
  });
}
