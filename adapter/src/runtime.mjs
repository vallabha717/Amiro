// adapter/src/runtime.mjs -- shared Amiro runtime client + reconnect + caches.
//
// The Amiro runtime is the engine Amiro delegates to, owned by the upstream
// project whose MIT-licensed `@1jehuang/jcode-sdk` client this adapter imports.
// Until an Amiro-owned engine build is packaged, the engine is a separate
// installed program: `bin/amiro` (and this module) delegate to it. Nothing here
// is a second agent loop -- the engine owns model execution, session history and
// provider routing.
//
// One runtime connection is shared by every request. The connection is
// established lazily (the adapter must boot even when the runtime socket is not
// up yet) and transparently re-established once on a transport failure.
//
// Exposed surface (ctx.runtime):
//   client()                 -> Promise<AmiroRuntimeClient> (connects lazily)
//   api.<method>(...args)    -> calls through withClient, e.g.
//                               ctx.runtime.api.createSession(...), .sendMessage,
//                               .events, .run, .setModel, .getHistory, ...
//   authStatus({force})      -> parsed `amiro auth status --json`, 60s cache
//   execJson(args)           -> run the runtime CLI and parse stdout as JSON
//   runRuntimeCli(args)      -> run the runtime CLI and return stdout verbatim
//   runtimeUsage()           -> parsed `amiro usage --json`
//   readOpenAiOauthUsage()   -> parsed <runtimeHome>/openai_oauth_usage.json
//   readModelUsageTurns()    -> rows from <runtimeHome>/model-usage-v1.sqlite3 (turns)
//   close()                  -> disconnect on shutdown

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Upstream engine client, aliased to the Amiro runtime name. The dependency is
// external and MIT-licensed; see THIRD-PARTY-NOTICES.md.
import { JcodeClient as AmiroRuntimeClient } from '@1jehuang/jcode-sdk';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
// <repo>/adapter/src -> <repo>
const REPO_ROOT = path.resolve(HERE, '..', '..');

// Identity this adapter announces to the engine. The engine records the client
// name in its own session metadata, so it names the process that is actually
// connecting (this Node adapter), not the engine it drives.
const ADAPTER_VERSION = readAdapterVersion();
const RUNTIME_CLIENT_NAME = `amiro-adapter/${ADAPTER_VERSION}`;

function readAdapterVersion() {
  try {
    const raw = fsSync.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8');
    const version = JSON.parse(raw).version;
    return typeof version === 'string' && version ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// The Amiro CLI shim in this checkout. It applies the canonical engine
// resolution order (explicit override, packaged runtime, owned native build,
// then a compatibility engine) and relays every command unchanged, so the
// adapter delegates the choice instead of duplicating the rules.
const REPO_CLI = path.join(REPO_ROOT, 'bin', 'amiro');
// Names used when the repo CLI shim is not present (e.g. a packaged adapter).
const AMIRO_CLI_NAME = 'amiro';
// Compatibility engine: the upstream binary name. Used only as the last resort,
// and it is never presented to anyone as if it were bundled with Amiro.
const COMPAT_ENGINE_BIN = 'jcode';

// Is `name` an executable on PATH? Absolute/relative paths are trusted as-is.
function isExecutableOnPath(name) {
  if (name.includes('/') || name.includes('\\')) return true;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fsSync.accessSync(path.join(dir, name), fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// Is `candidate` an existing executable file (not a directory)?
function isExecutableFile(candidate) {
  try {
    if (!fsSync.statSync(candidate).isFile()) return false;
    fsSync.accessSync(candidate, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}


// Backoff schedule for capability-gated connects (see connectWithCapability).
// Zero first delay keeps the healthy path immediate; the rest spans ~9s, which
// covers the runtime's post-turn session_tools withholding window.
const DEFAULT_CAPABILITY_DELAYS_MS = [0, 200, 400, 700, 1100, 1700, 2500, 2500];

function isConnectionError(err) {
  if (!err) return false;
  const code = err.code || '';
  if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EPIPE' || code === 'ECONNRESET') {
    return true;
  }
  const msg = String(err.message || '');
  return /socket|closed|connect|EPIPE|ECONNREFUSED|ENOENT/i.test(msg);
}

// Runtime socket path. AMIRO_API_SOCKET is the Amiro variable; the pre-rename
// name is still read so an existing installation keeps booting unchanged, and
// the last fallback is the runtime home's own bridge socket path.
export function resolveRuntimeSocket(explicit) {
  return (
    explicit ||
    process.env.AMIRO_API_SOCKET ||
    process.env.JCODE_API_SOCKET ||
    path.join(resolveRuntimeHome(), 'scratch', 'amiro-api.sock')
  );
}

// Runtime home: where the engine keeps its *state* (memory, sessions, usage
// SQLite, OAuth token files). AMIRO_RUNTIME_HOME is the Amiro variable.
// AMIRO_JCODE_HOME and JCODE_HOME are the pre-rename variables; when none is set
// we resolve the engine's own legacy on-disk state directory (~/.jcode)
// silently -- it is only ever read, never migrated or rewritten, so existing
// installations keep working as they are.
export function resolveRuntimeHome(explicit) {
  return (
    explicit ||
    process.env.AMIRO_RUNTIME_HOME ||
    process.env.AMIRO_JCODE_HOME ||
    process.env.JCODE_HOME ||
    path.join(os.homedir(), '.jcode')
  );
}

// The home an operator actually configured (or an embedder passed in), or '' when
// none was configured. Deliberately distinct from resolveRuntimeHome()'s default:
// an unconfigured engine resolves its own layout, which is split -- state in
// ~/.jcode but provider credentials in the XDG config directory
// (~/.config/jcode). Substituting our default for the engine's own default made
// the engine look for credentials in a legacy directory that holds none, so
// API-key providers silently reported not_configured and dropped out of the
// model catalog. Only an explicit home may be exported to child processes.
export function configuredRuntimeHome(explicit) {
  return (
    explicit ||
    process.env.AMIRO_RUNTIME_HOME ||
    process.env.AMIRO_JCODE_HOME ||
    process.env.JCODE_HOME ||
    ''
  );
}

// Where the engine keeps provider credentials. Mirrors the engine's own rule:
// `<configured home>/config/jcode` when a home is configured, otherwise the XDG
// config directory. Used for read/delete of the credential files.
export function resolveRuntimeConfigDir(home) {
  const configured = configuredRuntimeHome(home);
  if (configured) return path.join(configured, 'config', 'jcode');
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'jcode');
}

// Runtime CLI. Resolution order, matching `bin/amiro`:
//   1. an explicit value (constructor option) or AMIRO_RUNTIME_BIN -- trusted
//      as-is, because an operator override must not be silently second-guessed
//   2. the repo CLI shim (<repo>/bin/amiro), which itself prefers the owned
//      native build and falls back to a compatibility engine
//   3. the `amiro` CLI name on PATH
//   4. the compatibility engine name on PATH (never called "bundled")
export function resolveRuntimeBin(explicit) {
  const requested = explicit || process.env.AMIRO_RUNTIME_BIN;
  if (requested) return requested;
  if (isExecutableFile(REPO_CLI)) return REPO_CLI;
  if (isExecutableOnPath(AMIRO_CLI_NAME)) return AMIRO_CLI_NAME;
  if (isExecutableOnPath(COMPAT_ENGINE_BIN)) return COMPAT_ENGINE_BIN;
  return AMIRO_CLI_NAME;
}

// What the adapter is actually driving, so boot logs and diagnostics can say it
// plainly instead of implying an engine of our own.
export function describeRuntimeCli(explicit) {
  const requested = explicit || process.env.AMIRO_RUNTIME_BIN;
  if (requested) return { bin: requested, kind: 'explicit' };
  if (isExecutableFile(REPO_CLI)) return { bin: REPO_CLI, kind: 'repo-cli' };
  if (isExecutableOnPath(AMIRO_CLI_NAME)) return { bin: AMIRO_CLI_NAME, kind: 'amiro-cli-on-path' };
  if (isExecutableOnPath(COMPAT_ENGINE_BIN)) {
    return { bin: COMPAT_ENGINE_BIN, kind: 'compatibility-on-path' };
  }
  return { bin: AMIRO_CLI_NAME, kind: 'unresolved' };
}

// Environment for a child runtime CLI process.
//
// Two rules, both learned the hard way on this machine:
//   1. `AMIRO_HOME` must NOT be inherited. For the adapter it is the application
//      data home; the engine reads the same variable as *its* home. Passing ours
//      down made the engine look for provider credentials in
//      `<app home>/config/jcode`, which does not exist, so connected API-key
//      providers silently reported not_configured and dropped out of the model
//      catalog. The engine only ever gets a runtime home.
//   2. A runtime home is exported only when an operator configured one
//      (`config.runtimeCliHome`), under the engine's own variable and the Amiro
//      name. With none configured we export nothing, so the engine resolves its
//      own split layout (state directory + XDG credential directory) exactly as
//      it does when a human runs it.
export function buildRuntimeCliEnv(config, base = process.env) {
  const env = { ...base };
  delete env.AMIRO_HOME;
  const home = configuredRuntimeHome(config && config.runtimeCliHome);
  if (home) {
    env.AMIRO_RUNTIME_HOME = home;
    env.JCODE_HOME = home;
  }
  // The engine honours its own telemetry opt-out variable. Set it for every
  // child CLI invocation so catalog/usage reads never phone home.
  env.JCODE_NO_TELEMETRY = env.JCODE_NO_TELEMETRY || '1';
  return env;
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

export function createAmiroRuntime({ socketPath, runtimeHome, runtimeCliHome, binary, log }) {
  const resolvedSocketPath = resolveRuntimeSocket(socketPath);
  // `runtimeHome` is the engine's *state* directory, used for the reads this
  // module performs (OAuth usage, usage SQLite). `runtimeCliHome` is only exported to
  // child CLI processes, and stays '' unless an operator configured one.
  const resolvedRuntimeHome = resolveRuntimeHome(runtimeHome);
  const resolvedCliHome = configuredRuntimeHome(runtimeCliHome);
  const bin = resolveRuntimeBin(binary);

  // Route-pinned allow-list. When AMIRO_PINNED_MODELS is set (comma-separated
  // `<provider><sep><model>` entries), only those models may be selected and
  // route verification is strict: a mismatch fails the turn instead of falling
  // back.
  const allowedModels = parseModelList(process.env.AMIRO_PINNED_MODELS);
  const routeSep = process.env.AMIRO_MODEL_ROUTE_SEP || ':';

  // When no static pin is configured, the models of the currently connected
  // providers become the allow-list. server.mjs refreshes this snapshot (see
  // models.mjs) so the request path stays synchronous. An empty snapshot means
  // "not known yet": requests are not refused, and the runtime still rejects a
  // model id it does not know.
  let dynamicModels = [];
  let dynamicDefault = '';

  function setDynamicModels(list) {
    dynamicModels = Array.isArray(list) ? list.map((m) => normaliseModel(m)).filter(Boolean) : [];
    // Prefer an operator-configured default so an omitted model never lands on a
    // provider that is rate-limited or unwanted, then the catalog's own
    // selection, then whatever comes first.
    const configured = normaliseModel(process.env.AMIRO_DEFAULT_MODEL || '');
    const preferred = list && typeof list === 'object' && typeof list.defaultModel === 'string' ? normaliseModel(list.defaultModel) : '';
    dynamicDefault =
      (configured && dynamicModels.includes(configured) && configured) ||
      (preferred && dynamicModels.includes(preferred) && preferred) ||
      dynamicModels[0] ||
      '';
  }

  function activeAllowList() {
    return allowedModels.length ? allowedModels : dynamicModels;
  }
  // Build the route-pinned model string. A provider-qualified id is required to
  // pin a route; passing the bare id lets the runtime pick the default endpoint.
  function resolveModel(provider, model) {
    const raw = normaliseModel(model);
    if (!raw) return '';
    if (raw.includes(':') || raw.includes('/')) return raw;
    const p = provider && String(provider).trim() && provider !== 'default' ? String(provider).trim() : '';
    return p ? `${p}${routeSep}${raw}` : raw;
  }

  // Resolve the model for a chat turn. When the client omits a model and a pin
  // allow-list is configured, fall back to the FIRST pinned model (never to the
  // runtime's legacy default, which would bypass the allow-list). Returns ''
  // only when no pin is configured and none was requested.
  function resolveChatModel(provider, model) {
    const resolved = resolveModel(provider, model);
    if (resolved) return resolved;
    return allowedModels[0] || dynamicDefault || '';
  }

  // The model an omitted-model request will actually use (pin first, then the
  // configured/catalog default). Reported at boot so the log is not misleading.
  function activeDefaultModel() {
    return allowedModels[0] || dynamicDefault || '';
  }

  function assertModelAllowed(model) {
    const list = activeAllowList();
    if (!list.length) return;
    if (!list.includes(normaliseModel(model))) {
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
        if (activeAllowList().length) {
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
      const c = await AmiroRuntimeClient.connect({
        socketPath: resolvedSocketPath,
        clientName: RUNTIME_CLIENT_NAME,
      });
      c.on('error', (err) => log('warn', 'amiro runtime client error', { error: String(err && err.message) }));
      c.on('close', () => {
        if (client === c) client = null;
      });
      client = c;
      // `engine` is what the bridge reports about itself; the adapter's own
      // identity is the Amiro runtime client name and appears in its logs only.
      log('info', 'connected to the amiro runtime', { engine: c.server, socketPath: resolvedSocketPath });
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

  // Proxy so ctx.runtime.api.<anyMethod>(...) works without listing all 40.
  // `notifyAuthChanged` additionally fires the registered hook so the connected
  // provider/model catalog is rebuilt the moment credentials change, instead of
  // waiting for the periodic refresh.
  let onAuthChanged = null;

  function setAuthChangedHook(fn) {
    onAuthChanged = typeof fn === 'function' ? fn : null;
  }

  const api = new Proxy(
    {},
    {
      get(_target, prop) {
        return (...args) =>
          withClient(async (c) => {
            const fn = c[prop];
            if (typeof fn !== 'function') {
              throw new Error(`unknown amiro runtime method: ${String(prop)}`);
            }
            const result = await fn.apply(c, args);
            if (prop === 'notifyAuthChanged' && onAuthChanged) {
              try {
                await onAuthChanged(args[0]);
              } catch (err) {
                log('warn', 'auth-change hook failed', { error: String(err && err.message) });
              }
            }
            return result;
          });
      },
    },
  );

  // Run the runtime CLI (the Amiro CLI shim, which delegates to the engine) and
  // return its stdout verbatim. Only an operator-configured home is exported; with
  // none configured the engine resolves its own state and credential locations.
  async function runRuntimeCli(args, { timeout = 30000 } = {}) {
    const options = {
      env: buildRuntimeCliEnv({ runtimeCliHome: resolvedCliHome }),
      maxBuffer: 32 * 1024 * 1024,
      timeout,
    };
    try {
      const { stdout } = await execFileAsync(bin, args, options);
      return String(stdout);
    } catch (err) {
      // Last resort if the resolved CLI disappeared after startup: run the
      // compatibility engine name directly. If that is missing too, the original
      // error is what surfaces.
      if (err && err.code === 'ENOENT' && bin !== COMPAT_ENGINE_BIN) {
        const { stdout } = await execFileAsync(COMPAT_ENGINE_BIN, args, options);
        return String(stdout);
      }
      throw err;
    }
  }

  async function execJson(args, options) {
    const text = String(await runRuntimeCli(args, options)).trim();
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
      log('warn', 'amiro runtime auth status failed', { error: String(err && err.message) });
      return authCache.data || { providers: [] };
    }
  }

  async function runtimeUsage() {
    return execJson(['usage', '--json']);
  }

  async function readOpenAiOauthUsage() {
    const file = path.join(resolvedRuntimeHome, 'openai_oauth_usage.json');
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return { accounts: {} };
    }
  }

  // Read the `turns` table from the runtime's usage sqlite DB, if node:sqlite is
  // available. Returns [] on any failure (missing DB, missing module).
  async function readModelUsageTurns() {
    const file = path.join(resolvedRuntimeHome, 'model-usage-v1.sqlite3');
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

  // A fresh, independent connection. The runtime attaches at most one session
  // per connection, so streaming turns use a dedicated connection and close it
  // when the turn ends rather than contending on the shared client.
  async function newClient() {
    return AmiroRuntimeClient.connect({ socketPath: resolvedSocketPath, clientName: RUNTIME_CLIENT_NAME });
  }

  // Capability-gated connect. The runtime negotiates capabilities per connection
  // in the `hello` handshake, and the preview bridge withholds `session_tools`
  // for several seconds after a turn connection closes (measured ~2.7s, longer
  // under load). A client that depends on that capability -- createSession with
  // a tool policy, or configureTools -- therefore has to open its connection
  // after the runtime is willing again. Capabilities never change on an existing
  // connection, so retrying a call on the same client cannot recover.
  //
  // The healthy path pays nothing: the first attempt is immediate and is kept.
  // Bounded so a runtime that genuinely lacks the capability still fails instead
  // of hanging.
  async function connectWithCapability(connectFn, capability, options = {}) {
    const delays = options.retryDelaysMs || DEFAULT_CAPABILITY_DELAYS_MS;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const onWait = options.onWait || ((info) => log('warn', 'waited for a runtime capability', info));
    let attempts = 0;
    let waitedMs = 0;
    for (const delay of delays) {
      if (delay) {
        await sleep(delay);
        waitedMs += delay;
      }
      attempts += 1;
      const candidate = await connectFn();
      if (!candidate.supports || candidate.supports(capability)) {
        if (attempts > 1) onWait({ capability, attempts, waitedMs });
        return candidate;
      }
      try {
        await candidate.close();
      } catch {
        /* ignore */
      }
    }
    throw new Error(
      `The Amiro runtime did not advertise the ${capability} capability after ${attempts} connections over ~${Math.round(waitedMs / 100) / 10}s.`,
    );
  }

  // Every caller of withIsolated creates a session with a tool policy (the six
  // sites that pass `tools:` to createSession), so `session_tools` is required
  // by default. Connects that do not touch tools -- withSession, used for
  // history/rename/archive and therefore hit right after a turn -- pass
  // requireCapability: null so they are never delayed by the withholding window.
  async function withIsolated(fn, options = {}) {
    const capability =
      options.requireCapability === undefined ? 'session_tools' : options.requireCapability;
    const c = capability
      ? await connectWithCapability(newClient, capability, options)
      : await newClient();
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
  // The runtime requires an attachment before get_history/rename/archive/rewind/
  // runtime_info etc.; skipping it yields unknown_session or empty results.
  // attachSession is idempotent, so this is safe for freshly created sessions too.
  async function withSession(sessionId, fn) {
    return withIsolated(
      async (client) => {
        await client.attachSession(sessionId);
        return fn(client);
      },
      { requireCapability: null },
    );
  }

  async function attach(client, sessionId) {
    await client.attachSession(sessionId);
  }

  // Serialize session creation across all connections. Concurrent
  // create_session calls (e.g. the browser firing the first chat and the title
  // request at once) race inside the runtime, so this runs them one at a time.
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
    socketPath: resolvedSocketPath,
    runtimeHome: resolvedRuntimeHome,
    runtimeCliHome: resolvedCliHome,
    binary: bin,
    connect,
    withClient,
    newClient,
    withIsolated,
    connectWithCapability,
    withSession,
    attach,
    createSession,
    api,
    resolveModel,
    resolveChatModel,
    assertModelAllowed,
    setDynamicModels,
    setAuthChangedHook,
    setModelPinned,
    pinnedModels: () => [...activeAllowList()],
    activeDefaultModel,
    client: () => connect(),
    execJson,
    runRuntimeCli,
    authStatus,
    runtimeUsage,
    readOpenAiOauthUsage,
    readModelUsageTurns,
    close,
  };
}
