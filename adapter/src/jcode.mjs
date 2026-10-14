// adapter/src/jcode.mjs -- shared jcode SDK client + reconnect + caches.
//
// One JcodeClient connection is shared by every request. The connection is
// established lazily (the adapter must boot even when the bridge socket is not
// up yet) and transparently re-established once on a transport failure.
//
// Exposed surface (ctx.jcode):
//   client()                 -> Promise<JcodeClient> (connects lazily)
//   api.<method>(...args)    -> calls through withClient, e.g.
//                               ctx.jcode.api.createSession(...), .sendMessage,
//                               .events, .run, .setModel, .getHistory, ...
//   authStatus({force})      -> parsed `jcode auth status --json`, 60s cache
//   execJson(args)           -> run the jcode binary and parse stdout as JSON
//   readOpenAiOauthUsage()   -> parsed ~/.jcode/openai_oauth_usage.json
//   readModelUsageTurns()    -> rows from ~/.jcode/model-usage-v1.sqlite3 (turns)
//   close()                  -> disconnect on shutdown

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JcodeClient } from '@1jehuang/jcode-sdk';

const execFileAsync = promisify(execFile);

function isConnectionError(err) {
  if (!err) return false;
  const code = err.code || '';
  if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EPIPE' || code === 'ECONNRESET') {
    return true;
  }
  const msg = String(err.message || '');
  return /socket|closed|connect|EPIPE|ECONNREFUSED|ENOENT/i.test(msg);
}

// Model strings are route-pinned as `<provider><sep><model>`. Verified live on
// the dedicated preview bridge: "opencode-go:deepseek-v4.1-flash" resolves to
// provider "OpenCode Go", while the bare id routes to the default endpoint.
// The separator is ":" (AMIRO_MODEL_ROUTE_SEP overrides for other bridges).
function normaliseModel(value) {
  return String(value || '')
    .trim()
    .replace(/^openai-compatible:/, '');
}

function parseModelList(value) {
  return String(value || '')
    .split(',')
    .map((s) => normaliseModel(s))
    .filter(Boolean);
}

// Split a route-pinned model string into provider + model. The runtime reports
// the bare model for the preview bridge (e.g. "deepseek-v4.1-flash"), so the
// model half is what we verify, never the provider prefix.
function splitRoute(value) {
  const s = normaliseModel(value);
  const ci = s.indexOf(':');
  if (ci > 0) return { provider: s.slice(0, ci), model: s.slice(ci + 1) };
  const si = s.indexOf('/');
  if (si > 0) return { provider: s.slice(0, si), model: s.slice(si + 1) };
  return { provider: '', model: s };
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function createJcodeManager({ socketPath, jcodeHome, binary, log }) {
  const bin = binary || 'jcode';
  const resolvedJcodeHome =
    jcodeHome || process.env.JCODE_HOME || path.join(os.homedir(), '.jcode');

  // Route-pinned allow-list. When AMIRO_PINNED_MODELS is set (comma-separated
  // `<provider><sep><model>` entries), only those models may be selected and
  // route verification is strict: a mismatch fails the turn instead of falling
  // back.
  const allowedModels = parseModelList(process.env.AMIRO_PINNED_MODELS);
  const routeSep = process.env.AMIRO_MODEL_ROUTE_SEP || ':';

  // Build the route-pinned model string. A provider-qualified id is required to
  // pin a route; passing the bare id lets the daemon pick the default endpoint.
  function resolveModel(provider, model) {
    const raw = normaliseModel(model);
    if (!raw) return '';
    if (raw.includes(':') || raw.includes('/')) return raw;
    const p = provider && String(provider).trim() && provider !== 'default' ? String(provider).trim() : '';
    return p ? `${p}${routeSep}${raw}` : raw;
  }

  // Resolve the model for a chat turn. When the client omits a model and a pin
  // allow-list is configured, fall back to the FIRST pinned model (never to the
  // daemon's legacy default, which would bypass the allow-list). Returns '' only
  // when no pin is configured and none was requested.
  function resolveChatModel(provider, model) {
    const resolved = resolveModel(provider, model);
    if (resolved) return resolved;
    return allowedModels[0] || '';
  }

  function assertModelAllowed(model) {
    if (!allowedModels.length) return;
    if (!allowedModels.includes(normaliseModel(model))) {
      const err = new Error(`model not allowed: ${model}`);
      err.status = 400;
      err.code = 'model_not_allowed';
      throw err;
    }
  }

  // Set the session model with no fallback. On an unknown/refused model the
  // error propagates and the turn is aborted rather than silently continuing on
  // the session default. In pinned mode the runtime's resolved model (and its
  // provider) must match the request.
  async function setModelPinned(c, sessionId, requested) {
    const model = normaliseModel(requested);
    assertModelAllowed(model);
    const want = splitRoute(model);
    await c.setModel(sessionId, model);
    let info = null;
    try {
      info = await c.getRuntimeInfo(sessionId);
    } catch {
      info = null;
    }
    if (info) {
      const runtimeRoute = splitRoute(info.model || '');
      const modelOk = normName(runtimeRoute.model) === normName(want.model);
      const runtimeProvider = info.provider || runtimeRoute.provider;
      const providerOk = !want.provider || !runtimeProvider || normName(runtimeProvider) === normName(want.provider);
      if (!modelOk || !providerOk) {
        const message = `route pin failed: requested ${model}, runtime provider=${info.provider} model=${info.model}`;
        if (allowedModels.length) {
          const err = new Error(message);
          err.code = 'route_pin_failed';
          throw err;
        }
        log('warn', 'route pin mismatch', { requested: model, runtime: info.model, provider: info.provider });
      }
    }
    return model;
  }

  let client = null;
  let connecting = null;

  async function connect() {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      const c = await JcodeClient.connect({
        socketPath,
        clientName: 'amiro-adapter/0.1.0',
      });
      c.on('error', (err) => log('warn', 'jcode client error', { error: String(err && err.message) }));
      c.on('close', () => {
        if (client === c) client = null;
      });
      client = c;
      log('info', 'connected to jcode bridge', { server: c.server, socketPath });
      return c;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  async function withClient(fn) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const c = await connect();
        return await fn(c);
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isConnectionError(err)) {
          client = null; // force a fresh connection on the retry
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // Proxy so ctx.jcode.api.<anySdkMethod>(...) works without listing all 40.
  const api = new Proxy(
    {},
    {
      get(_target, prop) {
        return (...args) =>
          withClient((c) => {
            const fn = c[prop];
            if (typeof fn !== 'function') {
              throw new Error(`unknown jcode SDK method: ${String(prop)}`);
            }
            return fn.apply(c, args);
          });
      },
    },
  );

  async function execJson(args, { timeout = 30000 } = {}) {
    const env = { ...process.env };
    if (resolvedJcodeHome) env.JCODE_HOME = resolvedJcodeHome;
    const { stdout } = await execFileAsync(bin, args, {
      env,
      maxBuffer: 32 * 1024 * 1024,
      timeout,
    });
    const text = String(stdout).trim();
    if (!text) return {};
    return JSON.parse(text);
  }

  let authCache = { at: 0, data: null };
  async function authStatus({ force = false } = {}) {
    const now = Date.now();
    if (!force && authCache.data && now - authCache.at < 60000) return authCache.data;
    try {
      const data = await execJson(['auth', 'status', '--json']);
      authCache = { at: now, data };
      return data;
    } catch (err) {
      log('warn', 'jcode auth status failed', { error: String(err && err.message) });
      return authCache.data || { providers: [] };
    }
  }

  async function jcodeUsage() {
    return execJson(['usage', '--json']);
  }

  async function readOpenAiOauthUsage() {
    const file = path.join(resolvedJcodeHome, 'openai_oauth_usage.json');
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return { accounts: {} };
    }
  }

  // Read the `turns` table from jcode's usage sqlite DB, if node:sqlite is
  // available. Returns [] on any failure (missing DB, missing module).
  async function readModelUsageTurns() {
    const file = path.join(resolvedJcodeHome, 'model-usage-v1.sqlite3');
    try {
      await fs.access(file);
    } catch {
      return [];
    }
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        return db
          .prepare('SELECT turn_id, model, provider, api_method, last_used FROM turns')
          .all();
      } finally {
        db.close();
      }
    } catch (err) {
      log('warn', 'failed reading model-usage sqlite', { error: String(err && err.message) });
      return [];
    }
  }

  // A fresh, independent connection. The bridge attaches at most one session
  // per connection, so streaming turns use a dedicated connection and close it
  // when the turn ends rather than contending on the shared client.
  async function newClient() {
    return JcodeClient.connect({ socketPath, clientName: 'amiro-adapter/0.1.0' });
  }

  async function withIsolated(fn) {
    const c = await newClient();
    try {
      return await fn(c);
    } finally {
      try {
        await c.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Run a session-scoped call on its own connection with the session attached.
  // The bridge requires an attachment before get_history/rename/archive/rewind/
  // runtime_info etc.; skipping it yields unknown_session or empty results.
  // attachSession is idempotent, so this is safe for freshly created sessions too.
  async function withSession(sessionId, fn) {
    return withIsolated(async (client) => {
      await client.attachSession(sessionId);
      return fn(client);
    });
  }

  async function attach(client, sessionId) {
    await client.attachSession(sessionId);
  }

  // Serialize session creation across all connections. Concurrent
  // create_session calls (e.g. the browser firing the first chat and the title
  // request at once) race inside the bridge, so this runs them one at a time.
  let sessionCreateChain = Promise.resolve();
  function createSession(client, options) {
    const run = () => client.createSession(options);
    const p = sessionCreateChain.then(run, run);
    sessionCreateChain = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  async function close() {
    if (!client) return;
    const c = client;
    client = null;
    try {
      await c.close();
    } catch {
      /* ignore */
    }
  }

  return {
    socketPath,
    jcodeHome: resolvedJcodeHome,
    connect,
    withClient,
    newClient,
    withIsolated,
    withSession,
    attach,
    createSession,
    api,
    resolveModel,
    resolveChatModel,
    assertModelAllowed,
    setModelPinned,
    pinnedModels: () => [...allowedModels],
    client: () => connect(),
    execJson,
    authStatus,
    jcodeUsage,
    readOpenAiOauthUsage,
    readModelUsageTurns,
    close,
  };
}
