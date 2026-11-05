#!/usr/bin/env node
/**
 * Offline OpenAI-compatible model for journeys that need a chat reply but not
 * a real model (the phone layout steps). Usage: node openai-stub-server.mjs <port>
 *
 *   GET  /v1/models              → a long list of model ids (pickers need to scroll)
 *   POST /v1/chat/completions    → a long, fixed Markdown answer (stream or not)
 *   GET  /__calls                → the requests received, for assertions
 */
import http from "node:http";

const port = Number(process.argv[2] || 38973);
const calls = [];

export const MODELS = Array.from({ length: 40 }, (_, i) => `stub-model-${String(i + 1).padStart(2, "0")}`);

function answer() {
  const days = Array.from({ length: 14 }, (_, i) =>
    `${i + 1}. **Day ${i + 1}** — taste a new oat-milk blend, note the foam and price it for the Koregaon Park menu.`,
  );
  return [
    "Here is the two-week tasting plan for Brew & Bloom:",
    "",
    ...days,
    "",
    "| Blend | Foam | Price (₹) |",
    "| --- | --- | --- |",
    "| Classic oat | Dense | 180 |",
    "| Oat + almond | Light | 210 |",
    "",
    "That's the whole plan — end of answer.",
  ].join("\n");
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {}
    calls.push({ method: req.method, url: req.url, model: body.model });
    const url = (req.url || "").replace(/\?.*$/, "");

    if (url === "/__calls") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(calls));
    }
    if (url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model", owned_by: "stub" })) }));
    }
    if (url.endsWith("/chat/completions")) {
      const text = answer();
      const model = body.model || MODELS[0];
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          id: "stub-1", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
          usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 },
        }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: "stub-1", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }));
      const words = text.split(/(?<=\s)/);
      let i = 0;
      const tick = setInterval(() => {
        if (i >= words.length) {
          clearInterval(tick);
          res.write(chunk({}, "stop"));
          res.write(`data: ${JSON.stringify({ id: "stub-1", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 } })}\n\n`);
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        res.write(chunk({ content: words.slice(i, i + 8).join("") }));
        i += 8;
      }, 15);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

server.listen(port, "127.0.0.1", () => console.log(`openai stub on http://127.0.0.1:${port}`));
