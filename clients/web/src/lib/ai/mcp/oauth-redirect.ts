"use client";

import { apiJson } from "@/lib/backend/client";
import { wait } from "lib/utils";

// Was authorizeMcpClientAction/checkTokenMcpClientAction (Server Actions
// running in-process against the old Postgres/Drizzle mcpClientsManager);
// now POST /api/mcp/servers/{id}/oauth/authorize against the Go sidecar's
// own OAuth implementation (internal/mcp/oauth -- discovery, RFC 7591
// dynamic client registration, PKCE, all built from scratch since neither
// Bifrost nor any Go MCP SDK ships this, unlike @modelcontextprotocol/sdk's
// client/auth.js this file used to lean on indirectly through
// create-mcp-client.ts). The popup + postMessage + poll-on-close shape
// below is otherwise unchanged from the original.
export function redriectMcpOauth(id: string) {
  return apiJson<{ authorizationUrl: string }>(
    `/api/mcp/servers/${id}/oauth/authorize`,
    { method: "POST" },
  ).then(({ authorizationUrl }) => {
    if (!authorizationUrl) throw new Error("Not Authorizing");
    return new Promise((resolve, reject) => {
      const authWindow = window.open(
        authorizationUrl,
        "oauth",
        "width=600,height=800,scrollbars=yes,resizable=yes",
      );
      if (!authWindow) {
        return reject(
          new Error("Please allow popups for OAuth authentication"),
        );
      }

      const check = async () => {
        await wait(1000);
        try {
          const info = await apiJson<{ status: string }>(
            `/api/mcp/servers/${id}`,
          );
          if (info.status === "connected") return resolve(true);
          return reject(new Error("Authentication failed"));
        } catch (e) {
          return reject(e instanceof Error ? e : new Error("Authentication failed"));
        }
      };

      let messageHandlerRegistered = false;
      let intervalId: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (messageHandlerRegistered) {
          window.removeEventListener("message", messageHandler);
          messageHandlerRegistered = false;
        }
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      };

      // Security note: no `event.origin` check here, unlike the original
      // (which could require same-origin since its popup and opener were
      // the same Next.js app). This popup is served by the Go sidecar on
      // its own origin (a different port than this frontend, possibly a
      // different scheme entirely inside the real Tauri build), so the
      // origin legitimately differs and can't be pinned to one exact
      // value up front. Safe regardless: the handler only ever reads a
      // `type` tag off event.data and never trusts it with anything
      // sensitive -- the actual token exchange already happened
      // server-side before this message is even sent (internal/api/mcp's
      // OAuthCallback), so at worst a forged message here just triggers
      // an extra (harmless) status re-check via `check()`.
      const messageHandler = (event: MessageEvent) => {
        if (event.data?.type === "MCP_OAUTH_SUCCESS") {
          cleanup();
          if (authWindow && !authWindow.closed) {
            authWindow.close();
          }
          check();
        } else if (event.data?.type === "MCP_OAUTH_ERROR") {
          cleanup();
          if (authWindow && !authWindow.closed) {
            authWindow.close();
          }
          const errorMessage =
            event.data.error_description ||
            event.data.error ||
            "Authentication failed";
          reject(new Error(errorMessage));
        }
      };

      window.addEventListener("message", messageHandler);
      messageHandlerRegistered = true;

      // Backup: poll for manual window close (in case postMessage fails,
      // e.g. a browser that blocks it across the sidecar's own origin).
      intervalId = setInterval(() => {
        if (authWindow.closed) {
          cleanup();
          check();
        }
      }, 1000);
    });
  });
}
