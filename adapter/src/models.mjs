// adapter/src/models.mjs -- /api/chat/models + all /api/ai/* routes.
//
// Dynamic model catalog backed by `amiro auth status --json` (connected providers)
// and `amiro model list -p <id> --json` (models per provider), cached for ~60s.
// When AMIRO_PINNED_MODELS is explicitly set, it acts as a hard restriction.
// When unset, all connected provider models are available.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { toolsOption, applyToolProfile } from './chat.mjs';
import { buildRuntimeCliEnv, resolveRuntimeBin } from './runtime.mjs';

const execFileAsync = promisify(execFile);

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function normalizeModelRef(provider, model) {
  if (!model && provider) {
    return String(provider).trim();
  }
  const m = String(model || '').trim();
  const p = String(provider || '').trim();
  if (!p) return m;
  if (m.startsWith(`${p}:`)) return m;
  return `${p}:${m}`;
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// The model catalog is read through the Amiro runtime CLI (`bin/amiro`, which
// delegates every command to the engine). buildRuntimeCliEnv carries the runtime
// home for the child process; resolveRuntimeBin applies the same engine
// resolution order as the CLI itself.
async function runRuntimeJson(ctx, args) {
  const bin = resolveRuntimeBin(ctx?.config?.runtimeBin);
  const env = buildRuntimeCliEnv(ctx?.config);
  const { stdout } = await execFileAsync(bin, args, {
    env,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = String(stdout).trim();
  if (!text) return {};
  return JSON.parse(text);
}

function runRuntimeJsonSync(ctx, args) {
  const bin = resolveRuntimeBin(ctx?.config?.runtimeBin);
  const env = buildRuntimeCliEnv(ctx?.config);
  const stdout = execFileSync(bin, args, {
    env,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  });
  const text = String(stdout).trim();
  if (!text) return {};
  return JSON.parse(text);
}

let catalogCache = {
  at: 0,
  data: null,
  promise: null,
};

export function invalidateCatalog() {
  catalogCache = { at: 0, data: null, promise: null };
}

export async function buildCatalog(ctx, { force = false } = {}) {
  const now = Date.now();
  if (!force && catalogCache.data && now - catalogCache.at < 60000) {
    return catalogCache.data;
  }
  if (!force && catalogCache.promise) {
    return catalogCache.promise;
  }

  const p = (async () => {
    let auth = {};
    try {
      auth = await runRuntimeJson(ctx, ['auth', 'status', '--json']);
    } catch (err) {
      ctx?.log?.('warn', 'amiro runtime auth status failed', { error: String(err && err.message) });
      auth = { providers: [] };
    }

    const available = Array.isArray(auth.providers)
      ? auth.providers.filter((p) => p && p.status === 'available')
      : [];

    const providerResults = await mapConcurrent(available, 4, async (p) => {
      try {
        const res = await runRuntimeJson(ctx, ['model', 'list', '-p', p.id, '--json']);
        return {
          id: p.id,
          name: p.display_name || res.provider || p.id,
          models: Array.isArray(res.models) ? res.models : [],
          selectedModel: res.selected_model || '',
        };
      } catch (err) {
        ctx?.log?.('warn', `Failed to list models for provider ${p.id}`, { error: String(err && err.message) });
        return null;
      }
    });

    const providers = providerResults.filter(Boolean);
    const data = { providers, rawStatus: auth };
    catalogCache = { at: Date.now(), data, promise: null };

    const allRefs = providers.flatMap((p) => p.models.map((m) => `${p.id}:${m}`));
    if (typeof ctx?.runtime?.setDynamicModels === 'function') {
      ctx.runtime.setDynamicModels(allRefs);
    }

    return data;
  })();

  catalogCache.promise = p;
  try {
    return await p;
  } finally {
    if (catalogCache.promise === p) {
      catalogCache.promise = null;
    }
  }
}

function syncBuildCatalog(ctx) {
  if (catalogCache.data && Date.now() - catalogCache.at < 60000) {
    return catalogCache.data;
  }
  let auth = {};
  try {
    auth = runRuntimeJsonSync(ctx, ['auth', 'status', '--json']);
  } catch (err) {
    ctx?.log?.('warn', 'sync amiro runtime auth status failed', { error: String(err && err.message) });
    auth = { providers: [] };
  }

  const available = Array.isArray(auth.providers)
    ? auth.providers.filter((p) => p && p.status === 'available')
    : [];

  const providers = [];
  for (const p of available) {
    try {
      const res = runRuntimeJsonSync(ctx, ['model', 'list', '-p', p.id, '--json']);
      providers.push({
        id: p.id,
        name: p.display_name || res.provider || p.id,
        models: Array.isArray(res.models) ? res.models : [],
        selectedModel: res.selected_model || '',
      });
    } catch (err) {
      ctx?.log?.('warn', `sync failed to list models for provider ${p.id}`, { error: String(err && err.message) });
    }
  }

  const data = { providers, rawStatus: auth };
  catalogCache = { at: Date.now(), data, promise: null };

  const allRefs = providers.flatMap((p) => p.models.map((m) => `${p.id}:${m}`));
  if (typeof ctx?.runtime?.setDynamicModels === 'function') {
    ctx.runtime.setDynamicModels(allRefs);
  }

  return data;
}

export function allowedModelRefs(ctx) {
  const pinnedRaw = (process.env.AMIRO_PINNED_MODELS || '').trim();
  if (pinnedRaw) {
    const list = pinnedRaw
      .split(',')
      .map((s) => s.trim().replace(/^openai-compatible:/, ''))
      .filter(Boolean);
    return new Set(list);
  }

  let data = catalogCache.data;
  if (!data) {
    try {
      data = syncBuildCatalog(ctx);
    } catch {
      data = { providers: [] };
    }
  }

  const set = new Set();
  for (const p of data.providers || []) {
    for (const m of p.models || []) {
      set.add(`${p.id}:${m}`);
    }
  }
  return set;
}

export function isModelAllowed(ctx, provider, model) {
  const allowed = allowedModelRefs(ctx);
  const ref = normalizeModelRef(provider, model);
  if (allowed.has(ref)) return true;

  if (ref.includes(':')) {
    const colonIdx = ref.indexOf(':');
    const p = ref.slice(0, colonIdx);
    const m = ref.slice(colonIdx + 1);
    if (allowed.has(`${p}:${m}`)) return true;
  }

  if (ref.startsWith('openai-compatible:')) {
    const bare = ref.replace(/^openai-compatible:/, '');
    if (allowed.has(bare)) return true;
  } else {
    if (allowed.has(`openai-compatible:${ref}`)) return true;
  }

  return false;
}

export async function getDynamicModelList(ctx) {
  const data = await buildCatalog(ctx);
  const models = [];
  for (const p of data.providers || []) {
    for (const m of p.models || []) {
      models.push(`${p.id}:${m}`);
    }
  }
  const firstWithSelected = (data.providers || []).find(
    (p) => p.selectedModel && p.models.includes(p.selectedModel),
  );
  const defaultModel = firstWithSelected
    ? `${firstWithSelected.id}:${firstWithSelected.selectedModel}`
    : models[0] || '';
  return Object.assign([...models], { models, defaultModel });
}

export function dynamicModelList(ctx) {
  let data = catalogCache.data;
  if (!data) {
    try {
      data = syncBuildCatalog(ctx);
    } catch {
      data = { providers: [] };
    }
  }
  const models = [];
  for (const p of data.providers || []) {
    for (const m of p.models || []) {
      models.push(`${p.id}:${m}`);
    }
  }
  const firstWithSelected = (data.providers || []).find(
    (p) => p.selectedModel && p.models.includes(p.selectedModel),
  );
  const defaultModel = firstWithSelected
    ? `${firstWithSelected.id}:${firstWithSelected.selectedModel}`
    : models[0] || '';
  return Object.assign([...models], { models, defaultModel });
}

export function register(app, ctx) {
  buildCatalog(ctx).catch((err) => {
    ctx?.log?.('warn', 'warm catalog failed', { error: String(err && err.message) });
  });

  function requireAdmin(req, res) {
    if (ctx.auth.isAdmin(req)) return true;
    ctx.error(res, 403, 'admin required');
    return false;
  }

  async function storedProviders() {
    const doc = await ctx.store.read('providers.json', {});
    return doc && typeof doc === 'object' ? doc : {};
  }

  // --- Chat models (PUBLIC) -------------------------------------------------

  app.get('/api/chat/models', async (_req, res) => {
    let catalog;
    try {
      catalog = await buildCatalog(ctx);
    } catch (err) {
      ctx?.log?.('warn', 'buildCatalog failed', { error: String(err && err.message) });
      catalog = { providers: [] };
    }

    const pinnedRaw = (process.env.AMIRO_PINNED_MODELS || '').trim();
    const isPinned = Boolean(pinnedRaw);
    const pinnedSet = isPinned ? allowedModelRefs(ctx) : null;

    const result = [];
    for (const p of catalog.providers || []) {
      let providerModels = p.models || [];
      if (isPinned && pinnedSet) {
        providerModels = providerModels.filter((m) => {
          const ref = `${p.id}:${m}`;
          return (
            pinnedSet.has(ref) ||
            pinnedSet.has(ref.replace(/^openai-compatible:/, '')) ||
            pinnedSet.has(m)
          );
        });
      }
      if (isPinned && providerModels.length === 0) {
        continue;
      }
      result.push({
        provider: p.id,
        providerName: p.name,
        providerType: p.id,
        hasAPIKey: true,
        models: providerModels.map((name) => ({ name })),
      });
    }

    // A configured default model must be the one the UI lands on when the user
    // has no stored choice, so put its provider group first and its model first
    // inside that group. Without this, a fresh chat would start on whichever
    // provider happens to sort first (for example one already rate-limited).
    const preferred = (process.env.AMIRO_DEFAULT_MODEL || '').trim().replace(/^openai-compatible:/, '');
    if (preferred) {
      const [pProvider, ...modelParts] = preferred.split(':');
      const pModel = modelParts.join(':');
      const group = result.find((g) => g.provider === pProvider);
      if (group && (modelParts.length === 0 || group.models.some((m) => m.name === pModel))) {
        if (pModel) group.models.sort((a, b) => (a.name === pModel ? -1 : b.name === pModel ? 1 : 0));
        result.sort((a, b) => (a.provider === pProvider ? -1 : b.provider === pProvider ? 1 : 0));
      }
    }

    ctx.json(res, 200, result);
  });

  // --- AI providers ---------------------------------------------------------

  app.get('/api/ai/providers', async (_req, res) => {
    let catalog;
    try {
      catalog = await buildCatalog(ctx);
    } catch {
      catalog = { providers: [] };
    }
    const stored = await storedProviders();
    const seen = new Set();
    const out = [];
    for (const p of catalog.providers || []) {
      seen.add(p.id);
      out.push({
        id: p.id,
        name: p.name,
        provider: p.id,
        configured: true,
        models: p.models,
      });
    }
    for (const [id, p] of Object.entries(stored)) {
      if (seen.has(id)) {
        const existing = out.find((o) => o.id === id);
        if (existing) {
          existing.name = p.name || existing.name;
          existing.baseUrl = p.baseUrl || existing.baseUrl;
          existing.models = p.models || existing.models;
        }
      } else {
        out.push({
          id,
          name: p.name || id,
          provider: p.provider || id,
          configured: Boolean(p.configured),
          baseUrl: p.baseUrl || undefined,
          models: p.models || [],
        });
      }
    }
    ctx.json(res, 200, out);
  });

  app.post('/api/ai/providers', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await ctx.readJson(req);
    const id = body.id || body.provider || slug(body.name);
    if (body.apiKey) {
      try {
        await ctx.runtime.api.setApiKey(id, body.apiKey);
        await ctx.runtime.api.notifyAuthChanged(id);
        invalidateCatalog();
      } catch (err) {
        ctx.log('warn', 'setApiKey failed', { provider: id, error: String(err && err.message) });
        return ctx.error(res, 400, String(err && err.message ? err.message : err));
      }
    }
    await ctx.store.update('providers.json', {}, (doc) => {
      const out = doc && typeof doc === 'object' ? doc : {};
      out[id] = {
        ...(out[id] || {}),
        id,
        name: body.name || (out[id] && out[id].name) || id,
        provider: body.provider || id,
        baseUrl: body.baseUrl || (out[id] && out[id].baseUrl) || '',
        models: body.models || (out[id] && out[id].models) || [],
        configured: true,
      };
      return out;
    });
    ctx.json(res, 200, { id });
  });

  app.delete('/api/ai/providers/:id', async (req, res, params) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ctx.runtime.api.clearApiKey(params.id);
      invalidateCatalog();
    } catch (err) {
      ctx.log('warn', 'clearApiKey failed', { provider: params.id, error: String(err && err.message) });
    }
    await ctx.store.update('providers.json', {}, (doc) => {
      const out = doc && typeof doc === 'object' ? doc : {};
      delete out[params.id];
      return out;
    });
    res.writeHead(204);
    res.end();
  });

  app.post('/api/ai/providers/models', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await ctx.readJson(req);
    const id = body.id || body.provider;
    if (body.apiKey && id) {
      try {
        await ctx.runtime.api.setApiKey(id, body.apiKey);
        await ctx.runtime.api.notifyAuthChanged(id);
        invalidateCatalog();
      } catch (err) {
        ctx.log('warn', 'setApiKey during model fetch failed', { error: String(err && err.message) });
      }
    }
    let models = [];
    try {
      const catalog = await buildCatalog(ctx);
      const match = (catalog.providers || []).find((p) => p.id === id);
      if (match) {
        models = match.models;
      }
    } catch (err) {
      ctx.log('warn', 'provider model fetch failed', { error: String(err && err.message) });
    }
    ctx.json(res, 200, { models });
  });

  app.post('/api/ai/providers/:id/test', async (req, res, params) => {
    const body = await ctx.readJson(req);
    ctx.requireUser(req);
    const model = ctx.runtime.resolveModel(params.id, body.model);
    const started = Date.now();
    try {
      const result = await ctx.runtime.withIsolated(async (client) => {
        const session = await ctx.runtime.createSession(client, {
          workingDir: ctx.config.workspaceDir,
          tools: toolsOption(),
        });
        try {
          if (!ctx.auth.isAdmin(req)) await applyToolProfile(client, session.session_id);
          if (model) await ctx.runtime.setModelPinned(client, session.session_id, model);
          const turn = await client.run(session.session_id, 'Reply with exactly OK');
          return turn;
        } finally {
          try {
            await client.archiveSession(session.session_id);
          } catch {
            /* ignore */
          }
        }
      });
      ctx.json(res, 200, {
        ok: true,
        model: model || '',
        provider: params.id,
        latencyMs: Date.now() - started,
        text: result.text || '',
        usage: result.usage
          ? {
              PromptTokens: result.usage.input,
              CompletionTokens: result.usage.output,
              TotalTokens: (result.usage.input || 0) + (result.usage.output || 0),
            }
          : undefined,
      });
    } catch (err) {
      ctx.json(res, 200, {
        ok: false,
        model: model || '',
        provider: params.id,
        latencyMs: Date.now() - started,
        error: String(err && err.message ? err.message : err),
      });
    }
  });

  // --- Generation -----------------------------------------------------------

  app.post('/api/ai/generate-object', async (req, res) => {
    const body = await ctx.readJson(req);
    ctx.requireUser(req);
    const schema = body.schema;
    if (!schema) return ctx.error(res, 400, 'schema is required');
    const promptObj = body.prompt || {};
    const content = [promptObj.system, promptObj.user].filter(Boolean).join('\n\n');
    const requestedModel = ctx.runtime.resolveModel(body.model && body.model.provider, body.model && body.model.model);
    try {
      const data = await ctx.runtime.withIsolated(async (client) => {
        const session = await ctx.runtime.createSession(client, {
          workingDir: ctx.config.workspaceDir,
          tools: toolsOption(),
        });
        try {
          if (!ctx.auth.isAdmin(req)) await applyToolProfile(client, session.session_id);
          if (requestedModel) {
            await ctx.runtime.setModelPinned(client, session.session_id, requestedModel);
          }
          const result = await client.runStructured(session.session_id, content, { schema });
          return result.data;
        } finally {
          try {
            await client.archiveSession(session.session_id);
          } catch {
            /* ignore */
          }
        }
      });
      ctx.json(res, 200, data);
    } catch (err) {
      ctx.log('warn', 'generate-object failed', { error: String(err && err.message) });
      ctx.error(res, 500, String(err && err.message ? err.message : err));
    }
  });

  app.post('/api/ai/generate-example-tool-schema', async (req, res) => {
    const body = await ctx.readJson(req);
    ctx.requireUser(req);
    const toolInfo = body.toolInfo || {};
    const prompt =
      body.prompt ||
      `Return only a JSON Schema (draft-07) object describing valid input for a tool named "${
        toolInfo.name || 'tool'
      }" described as: ${toolInfo.description || ''}. Existing schema hint: ${JSON.stringify(
        toolInfo.inputSchema || {},
      )}`;
    try {
      const text = await ctx.runtime.withIsolated(async (client) => {
        const session = await ctx.runtime.createSession(client, {
          workingDir: ctx.config.workspaceDir,
          tools: toolsOption(),
        });
        try {
          if (!ctx.auth.isAdmin(req)) await applyToolProfile(client, session.session_id);
          const requestedModel = ctx.runtime.resolveModel(
            body.model && body.model.provider,
            body.model && body.model.model,
          );
          if (requestedModel) {
            await ctx.runtime.setModelPinned(client, session.session_id, requestedModel);
          }
          const turn = await client.run(session.session_id, prompt);
          return turn.text || '';
        } finally {
          try {
            await client.archiveSession(session.session_id);
          } catch {
            /* ignore */
          }
        }
      });
      const parsed = extractJson(text);
      ctx.json(res, 200, parsed ?? { error: 'could not parse schema' });
    } catch (err) {
      ctx.log('warn', 'generate-example-tool-schema failed', { error: String(err && err.message) });
      ctx.error(res, 500, String(err && err.message ? err.message : err));
    }
  });

  // --- Login panel support --------------------------------------------------

  app.get('/api/providers/login-status', async (_req, res) => {
    const status = await ctx.runtime.authStatus();
    ctx.json(res, 200, Array.isArray(status.providers) ? status.providers : []);
  });
}

function extractJson(text) {
  const s = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const candidate = fenced ? fenced[1].trim() : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
