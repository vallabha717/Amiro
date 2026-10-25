#!/usr/bin/env node
// Offline stand-in for the GitHub "latest release" API the update check calls
// (backend/src/updates.rs, AMIRO_UPDATE_API_BASE). Serves one release:
//
//   GET /repos/<owner>/<name>/releases/latest  -> v99.0.0 with release notes
//   GET /health                                -> { ok: true }
//
//   node tests/e2e/fixtures/release-stub-server.mjs <port>
import http from "node:http";

const port = Number(process.argv[2] || 38972);
const STUB_VERSION = "v99.0.0";

const release = {
  tag_name: STUB_VERSION,
  html_url: `https://github.com/vallabha717/Amiro/releases/tag/${STUB_VERSION}`,
  published_at: "2026-10-25T12:00:00Z",
  body: "## What's new\n\n- Self-update for the server and the desktop app\n- A reload banner for open tabs and phones",
};

http
  .createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = (req.url || "/").split("?")[0];
    if (path === "/health") return send(200, { ok: true });
    if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(path)) return send(200, release);
    return send(404, { message: "Not Found" });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`release stub on http://127.0.0.1:${port}`);
  });
