// adapter/src/models.mjs -- /api/chat/models + all /api/ai/* routes.
//
// Model data comes from `jcode auth status --json` (shelled out, cached 60s)
// plus `client.listModels(sessionId)` on a throwaway session. The model ids
// returned are what `setModel` expects, so chat.mjs passes the frontend's
// `chatModel.model` straight through.

import { toolsOption, applyToolProfile } from './chat.mjs';

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

export function register(app, ctx) {
  let catalogCache = { at: 0, data: null };

  // Provider changes (storing/clearing API keys, listing models against a
  // supplied key) are admin-only. Read-only listing stays available to any
  // authenticated user.
  function requireAdmin(req, res) {
    if (ctx.auth.isAdmin(req)) return true;
    ctx.error(res, 403, 'admin required');
    return false;
  }

  // The route catalog (getRuntimeInfo.routes) is the only source that knows
  // which provider serves which model on this bridge -- listModels returns bare
  // names that the daemon routes to the default (wrong) endpoint.
  async function listRoutes() {
    return ctx.jcode.withIsolated(async (client) => {
      const session = await ctx.jcode.createSession(client, {
        workingDir: ctx.config.workspaceDir,
        tools: { enabled: [] },
      });
      try {
        const info = await client.getRuntimeInfo(session.session_id);
        return Array.isArray(info.routes) ? info.routes : [];
      } finally {
        try {
          await client.archiveSession(session.session_id);
        } catch {
          /* ignore */
        }
      }
    });
  }

  function allowedModels() {
    return ctx.jcode.pinnedModels();
  }

  // Routes filtered to the pinned allow-list (when one is configured) and to
  // currently-available providers.
  function usableRoutes(routes) {
    const allowed = allowedModels();
    return (routes || []).filter((r) => {
      if (!r || !r.model || r.available === false) return false;
      const pinned = ctx.jcode.resolveModel(slug(r.provider), r.model);
      return allowed.length === 0 || allowed.includes(pinned);
    });
  }

  async function buildCatalog() {
    const now = Date.now();
    if (catalogCache.data && now - catalogCache.at < 60000) return catalogCache.data;
    const status = await ctx.jcode.authStatus();
    let routes = [];
    try {
      routes = await listRoutes();
    } catch (err) {
      ctx.log('warn', 'listRoutes failed', { error: String(err && err.message) });
    }
    const authProviders = Array.isArray(status.providers) ? status.providers : [];
    const data = { status, authProviders, routes: usableRoutes(routes) };
    catalogCache = { at: now, data };
    return data;
  }

  function invalidateCatalog() {
    catalogCache = { at: 0, data: null };
  }

  function providerIds({ routes, authProviders }) {
    const ids = new Set();
    for (const r of routes) ids.add(slug(r.provider));
    for (const p of authProviders) ids.add(slug(p.provider_name));
    return [...ids];
  }

  function providerDisplayName(catalog, id) {
    const r = catalog.routes.find((x) => slug(x.provider) === id);
    return r ? r.provider : id;
  }

  function modelsForProvider(routes, id) {
    const seen = new Set();
    const out = [];
    for (const r of routes) {
      if (slug(r.provider) !== id || seen.has(r.model)) continue;
      seen.add(r.model);
      out.push({ name: r.model });
    }
    return out;
  }

  async function storedProviders() {
    const doc = await ctx.store.read('providers.json', {});
    return doc && typeof doc === 'object' ? doc : {};
  }

  // --- Chat models (PUBLIC) -------------------------------------------------

  app.get('/api/chat/models', async (req, res) => {
    let catalog;
    try {
      catalog = await buildCatalog();
    } catch (err) {
      ctx.log('warn', 'buildCatalog failed', { error: String(err && err.message) });
      catalog = { routes: [], authProviders: [] };
    }
    const hasKey = catalog.authProviders.length > 0 || catalog.routes.length > 0;
    const result = providerIds(catalog).map((id) => ({
      provider: id,
      providerName: providerDisplayName(catalog, id),
      providerType: 'jcode',
      hasAPIKey: hasKey,
      models: modelsForProvider(catalog.routes, id),
    }));
    ctx.json(res, 200, result);
  });

  // --- AI providers ---------------------------------------------------------

  app.get('/api/ai/providers', async (req, res) => {
    const catalog = await buildCatalog().catch(() => ({ routes: [], authProviders: [] }));
    const stored = await storedProviders();
    const seen = new Set();
    const out = [];
    for (const id of providerIds(catalog)) {
      seen.add(id);
      out.push({
        id,
        name: providerDisplayName(catalog, id),
        provider: id,
        configured: true,
        models: modelsForProvider(catalog.routes, id).map((m) => m.name),
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
        await ctx.jcode.api.setApiKey(id, body.apiKey);
        await ctx.jcode.api.notifyAuthChanged(id);
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
      await ctx.jcode.api.clearApiKey(params.id);
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
        await ctx.jcode.api.setApiKey(id, body.apiKey);
        await ctx.jcode.api.notifyAuthChanged(id);
        invalidateCatalog();
      } catch (err) {
        ctx.log('warn', 'setApiKey during model fetch failed', { error: String(err && err.message) });
      }
    }
    let models = [];
    try {
      const routes = usableRoutes(await listRoutes());
      const seen = new Set();
      for (const r of routes) {
        if (id && slug(r.provider) !== id) continue;
        if (seen.has(r.model)) continue;
        seen.add(r.model);
        models.push(r.model);
      }
    } catch (err) {
      ctx.log('warn', 'provider model fetch failed', { error: String(err && err.message) });
    }
    ctx.json(res, 200, { models });
  });

  app.post('/api/ai/providers/:id/test', async (req, res, params) => {
    const body = await ctx.readJson(req);
    ctx.requireUser(req);
    const model = ctx.jcode.resolveModel(params.id, body.model);
    const started = Date.now();
    try {
      const result = await ctx.jcode.withIsolated(async (client) => {
        const session = await ctx.jcode.createSession(client, {
          workingDir: ctx.config.workspaceDir,
          tools: toolsOption(),
        });
        try {
          if (!ctx.auth.isAdmin(req)) await applyToolProfile(client, session.session_id);
          if (model) await ctx.jcode.setModelPinned(client, session.session_id, model);
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
    const requestedModel = ctx.jcode.resolveModel(body.model && body.model.provider, body.model && body.model.model);
    try {
      const data = await ctx.jcode.withIsolated(async (client) => {
        const session = await ctx.jcode.createSession(client, {
          workingDir: ctx.config.workspaceDir,
          tools: toolsOption(),
        });
        try {
          if (!ctx.auth.isAdmin(req)) await applyToolProfile(client, session.session_id);
          if (requestedModel) {
            await ctx.jcode.setModelPinned(client, session.session_id, requestedModel);
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
      const text = await ctx.jcode.withIsolated(async (client) => {
        const session = await ctx.jcode.createSession(client, {
          workingDir: ctx.config.workspaceDir,
          tools: toolsOption(),
        });
        try {
          if (!ctx.auth.isAdmin(req)) await applyToolProfile(client, session.session_id);
          const requestedModel = ctx.jcode.resolveModel(
            body.model && body.model.provider,
            body.model && body.model.model,
          );
          if (requestedModel) {
            await ctx.jcode.setModelPinned(client, session.session_id, requestedModel);
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

  app.get('/api/providers/login-status', async (req, res) => {
    const status = await ctx.jcode.authStatus();
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
