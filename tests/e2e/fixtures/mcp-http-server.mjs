#!/usr/bin/env node
// Offline MCP server fixture for the E2E journeys (zero dependencies).
//
// One process serves four MCP endpoints over Streamable HTTP (JSON responses):
//   /open/mcp     no auth
//   /bearer/mcp   Authorization: Bearer <MCP_BEARER_TOKEN>
//   /apikey/mcp   <MCP_API_KEY_HEADER>: <MCP_API_KEY>
//   /oauth/mcp    OAuth 2.1 (RFC 9728 resource metadata, RFC 8414 AS metadata,
//                 RFC 7591 dynamic registration, PKCE S256). The /authorize
//                 page has a visible "Approve" button so the consent step is
//                 part of the recorded video.
//
// Tools: echo, add, whoami. Every tools/call is logged; GET /__calls returns
// the log so specs can prove a call really went through the connector.
//
// Usage: node mcp-http-server.mjs <port>   (env: MCP_BEARER_TOKEN, MCP_API_KEY_HEADER, MCP_API_KEY)
import crypto from "node:crypto";
import http from "node:http";

const PORT = Number(process.argv[2] || process.env.PORT || 38970);
const BEARER = process.env.MCP_BEARER_TOKEN || "e2e-bearer-token-123456";
const KEY_HEADER = (process.env.MCP_API_KEY_HEADER || "X-Api-Key").toLowerCase();
const API_KEY = process.env.MCP_API_KEY || "e2e-api-key-abcdef";
const BASE = `http://127.0.0.1:${PORT}`;

const calls = [];
const clients = new Map(); // client_id -> {redirect_uris}
const codes = new Map(); // code -> {client_id, redirect_uri, challenge}
const tokens = new Set();

const TOOLS = [
  {
    name: "echo",
    description: "Echo a message back, prefixed with ECHO:. Use when asked to echo through the fixture server.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "whoami",
    description: "Report which endpoint and auth mode served this call.",
    inputSchema: { type: "object", properties: {} },
  },
];

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function authorized(mode, req) {
  if (mode === "open") return true;
  if (mode === "bearer") return req.headers.authorization === `Bearer ${BEARER}`;
  if (mode === "apikey") return req.headers[KEY_HEADER] === API_KEY;
  if (mode === "oauth") {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    return !!m && tokens.has(m[1]);
  }
  return false;
}

function rpc(mode, msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `e2e-fixture-${mode}`, version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      calls.push({ at: new Date().toISOString(), mode, name, args });
      let text;
      if (name === "echo") text = `ECHO: ${args.message}`;
      else if (name === "add") text = String(Number(args.a) + Number(args.b));
      else if (name === "whoami") text = `endpoint=${mode} auth=ok`;
      else return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } };
      return ok({ content: [{ type: "text", text }], isError: false });
    }
    default:
      if (id === undefined || id === null) return null; // notification
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#1e293b;padding:32px 40px;border-radius:16px;max-width:460px;box-shadow:0 10px 40px #0008}
button{font-size:16px;padding:10px 24px;border-radius:10px;border:0;background:#22c55e;color:#04210f;font-weight:600;cursor:pointer}
code{background:#0f172a;padding:2px 6px;border-radius:6px}</style></head><body><div class="card">${body}</div></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;

  if (p === "/__calls") return json(res, 200, calls);
  if (p === "/__reset") {
    calls.length = 0;
    return json(res, 200, { ok: true });
  }
  if (p === "/health") return json(res, 200, { ok: true });

  // ---- OAuth discovery -------------------------------------------------------
  if (p.startsWith("/.well-known/oauth-protected-resource")) {
    return json(res, 200, {
      resource: `${BASE}/oauth/mcp`,
      authorization_servers: [BASE],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  }
  if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) {
    return json(res, 200, {
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["mcp"],
    });
  }
  if (p === "/register" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const client_id = `e2e-client-${crypto.randomBytes(6).toString("hex")}`;
    clients.set(client_id, { redirect_uris: body.redirect_uris || [] });
    return json(res, 201, {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris || [],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }
  if (p === "/authorize") {
    const q = url.searchParams;
    const approve = new URL(`${BASE}/authorize/approve`);
    for (const [k, v] of q) approve.searchParams.set(k, v);
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(
      page(
        "Authorize Amiro",
        `<h2>E2E Fixture MCP</h2><p><b>Amiro</b> wants to access the fixture MCP server on your behalf.</p>
         <p>client: <code>${q.get("client_id") || "?"}</code></p>
         <form method="get" action="/authorize/approve">${[...approve.searchParams]
           .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}">`)
           .join("")}<button id="approve" type="submit">Approve</button></form>`,
      ),
    );
  }
  if (p === "/authorize/approve") {
    const q = url.searchParams;
    const code = crypto.randomBytes(12).toString("hex");
    codes.set(code, {
      client_id: q.get("client_id"),
      redirect_uri: q.get("redirect_uri"),
      challenge: q.get("code_challenge"),
    });
    const back = new URL(q.get("redirect_uri"));
    back.searchParams.set("code", code);
    if (q.get("state")) back.searchParams.set("state", q.get("state"));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (p === "/token" && req.method === "POST") {
    const form = new URLSearchParams(await readBody(req));
    if (form.get("grant_type") === "refresh_token") {
      const t = `e2e-at-${crypto.randomBytes(12).toString("hex")}`;
      tokens.add(t);
      return json(res, 200, { access_token: t, token_type: "Bearer", expires_in: 3600 });
    }
    const entry = codes.get(form.get("code") || "");
    if (!entry) return json(res, 400, { error: "invalid_grant" });
    if (entry.challenge) {
      const verifier = form.get("code_verifier") || "";
      const digest = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (digest !== entry.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
    }
    codes.delete(form.get("code"));
    const t = `e2e-at-${crypto.randomBytes(12).toString("hex")}`;
    tokens.add(t);
    return json(res, 200, {
      access_token: t,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: `e2e-rt-${crypto.randomBytes(12).toString("hex")}`,
      scope: "mcp",
    });
  }

  // ---- MCP endpoints ---------------------------------------------------------
  const m = /^\/(open|bearer|apikey|oauth)\/(mcp|sse)\/?$/.exec(p);
  if (m) {
    const mode = m[1];
    if (!authorized(mode, req)) {
      const headers =
        mode === "oauth"
          ? { "www-authenticate": `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/oauth/mcp"` }
          : {};
      return json(res, 401, { error: "unauthorized" }, headers);
    }
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST" });
      return res.end();
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      return res.end();
    }
    const raw = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const replies = (Array.isArray(msg) ? msg : [msg]).map((x) => rpc(mode, x)).filter(Boolean);
    const headers = { "mcp-session-id": "e2e-session" };
    if (!replies.length) {
      res.writeHead(202, headers);
      return res.end();
    }
    return json(res, 200, Array.isArray(msg) ? replies : replies[0], headers);
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`e2e MCP fixture on ${BASE} (open|bearer|apikey|oauth)/mcp`);
});
