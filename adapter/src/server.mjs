// adapter/src/server.mjs -- entry point for the Amiro Node adapter.
//
// Plain Node (>=22) + node:http only. No framework, no TypeScript. This file
// owns the HTTP router, request helpers, the SSE writer the UI-message-stream
// routes use, static serving for the Next `out/` export, and process boot.
//
// ============================================================================
// WORKER 2 (adapter-routes) CONTRACT -- do not change without telling worker 1
// ============================================================================
// `./routes/index.mjs` MUST export:
//
//     export function registerRoutes(app, ctx) { ... }
//
//   * `app` is the router created below. Register with:
//       app.get(path, handler), app.post, app.put, app.delete, app.all
//     Paths support `:param` segments, e.g. "/api/archive/:id". Handlers are
//     called as `handler(req, res, params)` where `params` is a plain object of
//     decoded path params. `req.user` is set on authenticated routes.
//   * `ctx` is documented at its construction site below and carries helpers:
//       ctx.config, ctx.log, ctx.store, ctx.jcode, ctx.auth,
//       ctx.readJson(req), ctx.json(res, status, obj), ctx.error(res, status, msg),
//       ctx.sse(res), ctx.requireUser(req), ctx.nowIso()
//
// The import is done dynamically + resiliently so adapter-core boots and
// smoke-tests before worker 2's files land. Once routes/index.mjs exists it is
// loaded and its registerRoutes(app, ctx) is called at boot.
// ============================================================================

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';

import { createStore } from './store.mjs';
import { createJcodeManager } from './jcode.mjs';
import { createAuth } from './auth.mjs';
import * as chat from './chat.mjs';
import * as threads from './threads.mjs';
import * as models from './models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Config (fixed decisions from docs/_adapter-contract.md)
// ---------------------------------------------------------------------------

function resolveHome(raw, fallbackSuffix) {
  if (!raw) return path.join(os.homedir(), fallbackSuffix);
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

const config = {
  port: Number(process.env.AMIRO_PORT || 8787),
  host: process.env.AMIRO_HOST || '127.0.0.1',
  token: process.env.AMIRO_TOKEN || '',
  home: resolveHome(process.env.AMIRO_HOME, '.amiro'),
  jcodeSocket: process.env.JCODE_API_SOCKET || '/root/.jcode/scratch/amiro-api.sock',
  jcodeHome: process.env.AMIRO_JCODE_HOME || undefined,
  outDir: path.join(REPO_ROOT, 'out'),
  workspaceDir: '',
  jcodeBin: process.env.JCODE_BIN || 'jcode',
};
config.workspaceDir = path.join(config.home, 'workspace');

// ---------------------------------------------------------------------------
// Structured logging: one JSON line per event.
// ---------------------------------------------------------------------------

function log(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
  const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  sink.write(`${JSON.stringify(line)}\n`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function compilePattern(pattern) {
  const keys = [];
  const body = pattern
    .replace(/\/+$/, '')
    .replace(/\/:([A-Za-z0-9_]+)/g, (_m, k) => {
      keys.push(k);
      return '/([^/]+)';
    });
  return { regex: new RegExp(`^${body || '/'}/?$`), keys };
}

function createRouter() {
  const routes = [];
  function add(method, pattern, handler) {
    const { regex, keys } = compilePattern(pattern);
    routes.push({ method, pattern, regex, keys, handler });
  }
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    delete: (p, h) => add('DELETE', p, h),
    all: (p, h) => add('*', p, h),
    routes,
    match(method, pathname) {
      const hits = [];
      for (const r of routes) {
        if (r.method !== '*' && r.method !== method) continue;
        const m = r.regex.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => {
          try {
            params[k] = decodeURIComponent(m[i + 1]);
          } catch {
            params[k] = m[i + 1];
          }
        });
        hits.push({ handler: r.handler, params });
      }
      return hits;
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers exposed on ctx
// ---------------------------------------------------------------------------

const MAX_BODY = 32 * 1024 * 1024;

async function readJson(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('request body too large');
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, obj) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: String(message) });
}

// SSE writer emitting the Vercel AI SDK UI Message Stream over SSE. Byte-shape
// mirrors backend-go/internal/ai/uimessage/stream.go:
//   headers Content-Type text/event-stream + X-Vercel-Ai-Ui-Message-Stream: v1
//   frames  `data: <json>\n\n`, flushed per frame
//   end     `data: [DONE]\n\n`
export const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Vercel-Ai-Ui-Message-Stream': 'v1',
  'X-Accel-Buffering': 'no',
};

function createSse(res) {
  let open = true;
  res.writeHead(200, STREAM_HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.on('close', () => {
    open = false;
  });
  const frame = (value) => {
    if (!open) return;
    try {
      res.write(`data: ${JSON.stringify(value)}\n\n`);
    } catch {
      open = false;
    }
  };
  return {
    get open() {
      return open;
    },
    start: (messageId) => frame({ type: 'start', messageId }),
    startStep: () => frame({ type: 'start-step' }),
    finishStep: () => frame({ type: 'finish-step' }),
    textStart: (id) => frame({ type: 'text-start', id }),
    textDelta: (id, delta) => frame({ type: 'text-delta', id, delta }),
    textEnd: (id) => frame({ type: 'text-end', id }),
    reasoningStart: (id) => frame({ type: 'reasoning-start', id }),
    reasoningDelta: (id, delta) => frame({ type: 'reasoning-delta', id, delta }),
    reasoningEnd: (id) => frame({ type: 'reasoning-end', id }),
    toolInputStart: (toolCallId, toolName) =>
      frame({ type: 'tool-input-start', toolCallId, toolName }),
    toolInputDelta: (toolCallId, inputTextDelta) =>
      frame({ type: 'tool-input-delta', toolCallId, inputTextDelta }),
    toolInputAvailable: (toolCallId, toolName, input) =>
      frame({ type: 'tool-input-available', toolCallId, toolName, input }),
    toolOutputAvailable: (toolCallId, output) =>
      frame({ type: 'tool-output-available', toolCallId, output }),
    toolOutputError: (toolCallId, errorText) =>
      frame({ type: 'tool-output-error', toolCallId, errorText }),
    data: (name, id, data) => {
      const f = { type: `data-${name}`, data };
      if (id) f.id = id;
      frame(f);
    },
    error: (errorText) => frame({ type: 'error', errorText }),
    finish: (messageMetadata) => {
      const f = { type: 'finish' };
      if (messageMetadata != null) f.messageMetadata = messageMetadata;
      frame(f);
    },
    done: () => {
      if (!open) return;
      try {
        res.write('data: [DONE]\n\n');
      } catch {
        /* client gone */
      }
      open = false;
      res.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Static serving for the Next `out/` export
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (pathname.includes('..')) return false;
  const attempts = [
    pathname,
    pathname.endsWith('/') ? `${pathname}index.html` : `${pathname}.html`,
    `${pathname.replace(/\/$/, '')}/index.html`,
  ];
  for (const rel of attempts) {
    const file = path.join(config.outDir, rel);
    if (!file.startsWith(config.outDir)) continue;
    try {
      const st = await fs.stat(file);
      if (st.isDirectory()) continue;
      let data = await fs.readFile(file);
      if (path.extname(file) === '.html') {
        data = Buffer.from(data.toString('utf8').replace('<head>', '<head><script>window.__BACKEND_ORIGIN__="";</script>'));
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
        'Content-Length': data.length,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(config.home, { recursive: true });
  await fs.mkdir(config.workspaceDir, { recursive: true });

  const store = createStore(config.home);
  const jcode = createJcodeManager({
    socketPath: config.jcodeSocket,
    jcodeHome: config.jcodeHome,
    binary: config.jcodeBin,
    log,
  });
  const auth = createAuth({ home: config.home, store, token: config.token, log });
  await auth.init();

  const app = createRouter();

  const ctx = {
    config,
    log,
    store,
    jcode,
    auth,
    app,
    readJson,
    json: sendJson,
    error: sendError,
    sse: createSse,
    nowIso: () => new Date().toISOString(),
    requireUser(req) {
      if (req.user) return req.user;
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    },
  };

  // Core routes first so worker 2's routes cannot accidentally shadow them.
  auth.register(app, ctx);
  threads.register(app, ctx);
  chat.register(app, ctx);
  models.register(app, ctx);

  // Route registration is required. A broken module must fail deployment,
  // rather than silently publishing a partially functional application.
  const mod = await import('./routes/index.mjs');
  if (typeof mod.registerRoutes !== 'function') throw new Error('Missing registerRoutes export');
  mod.registerRoutes(app, ctx);
  const workerRoutesLoaded = true;

  // When no static pin is configured, the models of the currently connected
  // Jcode providers form the allow-list. Compute it once before serving so the
  // first request already sees a populated catalog, then refresh in the
  // background (a provider login adds/removes models without a restart).
  const modelsModule = await import('./models.mjs');
  async function refreshDynamicModels() {
    if ((process.env.AMIRO_PINNED_MODELS || '').trim()) return;
    try {
      const list = await modelsModule.getDynamicModelList(ctx);
      ctx.jcode.setDynamicModels(list);
      log('info', 'dynamic model catalog loaded', {
        models: list.length,
        catalogDefault: list.defaultModel || null,
        effectiveDefault: ctx.jcode.activeDefaultModel(),
      });
    } catch (err) {
      log('warn', 'dynamic model catalog unavailable', { error: String(err && err.message) });
    }
  }
  await refreshDynamicModels();
  const modelRefresh = setInterval(() => {
    refreshDynamicModels().catch(() => {});
  }, 60 * 1000);
  modelRefresh.unref?.();

  // Connecting or removing a provider must change what the model selector can
  // offer on the very next request, so rebuild the catalog as soon as any route
  // reports an auth change (every provider route funnels through this SDK call).
  ctx.jcode.setAuthChangedHook(async () => {
    modelsModule.invalidateCatalog();
    await refreshDynamicModels();
  });

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    res.on('finish', () => {
      log('info', 'request', {
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });

    handle(req, res, url, app, ctx).catch((err) => {
      log('error', 'unhandled request error', {
        method: req.method,
        path: url.pathname,
        error: String(err && err.stack ? err.stack : err),
      });
      if (!res.headersSent) sendError(res, err.status || 500, err.message || 'internal error');
      else res.end();
    });
  });

  server.listen(config.port, config.host, () => {
    log('info', 'adapter listening', {
      host: config.host,
      port: config.port,
      home: config.home,
      tokenRequired: Boolean(config.token),
      jcodeSocket: config.jcodeSocket,
      workerRoutesLoaded,
    });
    if (!config.token) log('info', 'standalone web mode: API access is protected by user bearer sessions');
  });

  const shutdown = async (signal) => {
    log('info', 'shutting down', { signal });
    server.close();
    try {
      await jcode.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const loginAttempts = new Map();
function allowLoginAttempt(req) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const key = loopback && req.headers['x-real-ip'] ? String(req.headers['x-real-ip']) : req.socket.remoteAddress;
  const now = Date.now();
  for (const [address, item] of loginAttempts) if (item.until <= now) loginAttempts.delete(address);
  if (!loginAttempts.has(key)) loginAttempts.set(key, { count: 0, until: now + 15 * 60 * 1000 });
  const item = loginAttempts.get(key);
  item.count += 1;
  return item.count <= 15;
}

async function handle(req, res, url, app, ctx) {
  // Same-origin web deployment plus explicit local development origins only.
  // Never reflect arbitrary origins with credentials.
  const origin = req.headers.origin;
  const sameOrigin = !origin || (() => {
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  })();
  const devOrigin = origin && ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3210', 'http://127.0.0.1:3210', 'tauri://localhost', 'http://tauri.localhost'].includes(origin);
  if (!sameOrigin && !devOrigin) {
    sendError(res, 403, 'origin not allowed');
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-Amiro-Token,X-BetterChatbot-Token',
  );
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = url.pathname;
  if (pathname === '/api/auth/login' && req.method === 'POST' && !allowLoginAttempt(req)) {
    res.setHeader('Retry-After', '900');
    sendError(res, 429, 'Too many login attempts. Try again in 15 minutes.');
    return;
  }

  // (a) sidecar shared secret, when configured.
  if (config.token) {
    const provided =
      req.headers['x-amiro-token'] ||
      req.headers['x-betterchatbot-token'] ||
      url.searchParams.get('token') ||
      '';
    if (!timingSafeEqual(String(provided), config.token)) {
      sendError(res, 401, 'invalid or missing sidecar token');
      return;
    }
  }

  // (b) user session: always resolved (optional), enforced on non-public routes.
  req.user = await ctx.auth.authenticate(req);

  const hits = app.match(req.method, pathname);
  if (!hits.length) {
    if (await serveStatic(req, res, url)) return;
    sendError(res, 404, 'not found');
    return;
  }

  if (!ctx.auth.isPublic(req.method, pathname) && !req.user) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  // The public preview does not expose root execution or pretend that legacy
  // integrations were connected to Jcode. These need a dedicated policy layer.
  const unsupported = (
    (pathname === '/api/background-jobs' && req.method === 'POST') ||
    pathname === '/api/skills/generate' ||
    pathname === '/api/checkpoint/restore' ||
    (pathname.startsWith('/api/mcp/') && /\/(call|authorize|callback|refresh)$/.test(pathname)) ||
    (pathname === '/api/mcp' && req.method === 'POST') ||
    pathname.startsWith('/api/search/')
  );
  if (unsupported) {
    sendError(res, 501, 'This integration is not enabled in the restricted Jcode preview');
    return;
  }

  // First registered match wins.
  const { handler, params } = hits[0];
  await handler(req, res, params);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

main().catch((err) => {
  log('error', 'fatal boot error', { error: String(err && err.stack ? err.stack : err) });
  process.exit(1);
});
