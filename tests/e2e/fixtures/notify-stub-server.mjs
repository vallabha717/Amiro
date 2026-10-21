#!/usr/bin/env node
// Offline notification-channel stub for the E2E journeys (zero dependencies).
//
// Mimics just enough of the Telegram / Slack / Discord APIs for the backend
// adapters to verify and deliver against, so the connect flow is proven
// without real bot tokens or network access:
//
//   Telegram  GET  /tg/bot<token>/getMe        -> {ok, result.username}
//             POST /tg/bot<token>/sendMessage  -> {ok, result.message_id}
//   Slack     POST /slack/auth.test            -> {ok, team, user}
//             POST /slack/conversations.open    -> {ok, channel.id}
//             POST /slack/chat.postMessage      -> {ok, ts}
//   Discord   GET  /dc/users/@me               -> {username}
//             POST /dc/users/@me/channels       -> {id}
//             POST /dc/channels/<id>/messages   -> {id}
//
// Any token equal to BAD_TOKEN is rejected the way the real provider rejects
// a revoked token (401 / ok:false). Every send is logged; GET /__calls
// returns the log so specs can prove a delivery really went through the stub.
//
// Usage: node notify-stub-server.mjs <port>
//   Point the backend at it (inherited through the e2e runner env):
//     AMIRO_NOTIFY_TELEGRAM_BASE_URL=http://127.0.0.1:<port>/tg
//     AMIRO_NOTIFY_SLACK_BASE_URL=http://127.0.0.1:<port>/slack
//     AMIRO_NOTIFY_DISCORD_BASE_URL=http://127.0.0.1:<port>/dc
import http from "node:http";

const PORT = Number(process.argv[2] || process.env.NOTIFY_STUB_PORT || 38971);
const BAD_TOKEN = process.env.NOTIFY_STUB_BAD_TOKEN || "e2e-bad-token";

const calls = [];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function bearer(req) {
  return req.headers["authorization"] || "";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname;
  const body = await readBody(req);

  if (path === "/health") return send(res, 200, { ok: true });
  if (path === "/__calls") return send(res, 200, { calls });

  let m;
  // ---- Telegram ----
  if ((m = path.match(/^\/tg\/bot([^/]+)\/getMe$/)) && req.method === "GET") {
    if (m[1] === BAD_TOKEN) return send(res, 401, { ok: false, description: "Unauthorized" });
    return send(res, 200, { ok: true, result: { username: "e2e-bot", first_name: "E2E Bot" } });
  }
  if ((m = path.match(/^\/tg\/bot([^/]+)\/sendMessage$/)) && req.method === "POST") {
    if (m[1] === BAD_TOKEN) return send(res, 401, { ok: false, description: "Unauthorized" });
    calls.push({ api: "telegram.sendMessage", chat_id: body.chat_id, text: body.text });
    return send(res, 200, { ok: true, result: { message_id: calls.length } });
  }
  // ---- Slack ----
  if (path === "/slack/auth.test" && req.method === "POST") {
    if (bearer(req) === `Bearer ${BAD_TOKEN}` || !bearer(req).startsWith("Bearer ")) {
      return send(res, 200, { ok: false, error: "invalid_auth" });
    }
    return send(res, 200, { ok: true, team: "E2E", user: "e2ebot" });
  }
  if (path === "/slack/conversations.open" && req.method === "POST") {
    calls.push({ api: "slack.conversations.open", users: body.users });
    return send(res, 200, { ok: true, channel: { id: "D123" } });
  }
  if (path === "/slack/chat.postMessage" && req.method === "POST") {
    calls.push({ api: "slack.chat.postMessage", channel: body.channel, text: body.text });
    return send(res, 200, { ok: true, ts: "1700000000.0001" });
  }
  // ---- Discord ----
  if (path === "/dc/users/@me" && req.method === "GET") {
    if (bearer(req) === `Bot ${BAD_TOKEN}`) return send(res, 401, { message: "401: Unauthorized" });
    return send(res, 200, { username: "e2ebot" });
  }
  if (path === "/dc/users/@me/channels" && req.method === "POST") {
    return send(res, 200, { id: "DM9" });
  }
  if ((m = path.match(/^\/dc\/channels\/([^/]+)\/messages$/)) && req.method === "POST") {
    calls.push({ api: "discord.message", channel_id: m[1], content: body.content });
    return send(res, 200, { id: "M1" });
  }
  send(res, 404, { error: "unknown stub route" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`notify stub on ${PORT}`));
