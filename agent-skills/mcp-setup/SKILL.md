---
name: mcp-setup
description: Connect, check, and remove MCP servers so you can use an outside service's tools — Linear, GitHub, Notion, a company API, or any service that publishes an MCP endpoint. Load it whenever the user asks to connect, add, or set up a tool, app, or MCP server, or when a task needs a service you have no tools for.
allowed-tools: mcp, websearch, webfetch
metadata:
  emoji: "🔌"
  amiro:
    display-name: "MCP Setup"
    category: "integrations"
---

You connect the user's outside services as **connectors**. A connector is an MCP server saved in your MCP config; once connected its tools are yours in every chat. The user sees all connectors on the **Connectors** page.

## 1. Check what is already there

Call `mcp` with `action: "list"` first. If the service is already connected, just use it. If it is configured but failing, read its error before adding anything new.

Apps like Gmail, Slack, Google Calendar, GitHub, or Notion may already be available through **Composio** (the `composio` server). Prefer that over adding a second connector for the same app. If Composio is not configured or the app is not connected there, tell the user they can connect it in one click on the Connectors page, and offer the MCP route below as an alternative.

## 2. Find the official MCP server

Use the service's own documentation (`websearch`, then `webfetch` the docs page). Look for an official **remote** MCP endpoint first (an `https://…/mcp` or `…/sse` URL); fall back to an official local package (`npx -y @org/server-…`) only when no remote one exists. Never use an unofficial server for a service that handles the user's private data without saying so.

Well-known remote endpoints (verify against the docs if unsure):

| Service | URL | Auth |
| --- | --- | --- |
| Linear | `https://mcp.linear.app/mcp` | OAuth (see step 4) |
| Notion | `https://mcp.notion.com/mcp` | OAuth |
| GitHub | `https://api.githubcopilot.com/mcp/` | Bearer personal access token |
| Context7 (docs) | `https://mcp.context7.com/mcp` | none |

## 3. Add it — secrets never go through you

Call `mcp` with `action: "add"`:

```
mcp {
  action: "add",
  server: "github",
  url: "https://api.githubcopilot.com/mcp/",
  transport: "http",
  secrets: [{ key: "authorization", header: "Authorization", prefix: "Bearer " }]
}
```

- For a local server use `command` + `args`, and put tokens in `secrets` with `env` instead of `header`: `{ key: "github_token", env: "GITHUB_PERSONAL_ACCESS_TOKEN" }`.
- **Never** ask the user to paste a token, key, or password into the chat, and never put one in `headers`, `env`, or `args` yourself — the tool rejects literal secrets. List what is needed in `secrets`; Amiro shows the user a **secure card** in the chat, the value goes straight to the encrypted vault, and you never see it.
- When the result says it is waiting for a key, tell the user in one short sentence what to paste and where to get it (for GitHub: "a personal access token from github.com/settings/tokens with `repo` scope"), then stop and wait.
- Adding a server needs the user's approval. Say briefly what you are adding before you call the tool.

## 4. Connect and confirm

When the user says the key is in (or presses Continue), call `mcp` with `action: "connect"` and the same `server`. On success, name two or three of the new tools that match what they wanted and carry on with the original task.

If the server uses OAuth instead of a token, `connect` will say it needs a login. Tell the user to run `amiro mcp login <server>` in a terminal once; there is no in-chat OAuth for custom servers yet.

## 5. When it fails

- **401 / 403**: the key is wrong, expired, or lacks a scope. Say which scope is likely missing and ask the user to update the key from the Connectors page (⋯ → Update keys).
- **404 / connection refused**: the URL is wrong. Re-check the docs before trying another.
- **A local command crashed**: the package name or arguments are wrong, or a required environment variable is missing.

Do not retry the same failing call more than once. Explain the problem plainly and what the user can do.

## Removing

`mcp { action: "remove", server: "<name>" }` deletes the connector and its saved keys. Confirm with the user first. Composio is managed on the Connectors page and cannot be removed here.
