// Minimal static server for the `next build` export in clients/web/out/, so the
// production bundle can be exercised in a browser the same way `next dev`
// was. Mirrors the trailing-slash / .html resolution a real static host does.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("./clients/web/out/", import.meta.url).pathname;
const PORT = Number(process.argv[2] || 3000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const exists = async (p) => {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [
    join(ROOT, rel),
    join(ROOT, `${rel}.html`),
    join(ROOT, rel, "index.html"),
    join(ROOT, "404.html"),
  ];
  for (const file of candidates) {
    if (await exists(file)) {
      const body = await readFile(file);
      res.writeHead(file.endsWith("404.html") ? 404 : 200, {
        "content-type": TYPES[extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
  }
  res.writeHead(404).end("not found");
}).listen(PORT, () => console.log(`serving clients/web/out/ on http://localhost:${PORT}`));
