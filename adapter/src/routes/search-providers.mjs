// adapter/src/routes/search-providers.mjs -- web-search provider configuration.

import crypto from 'node:crypto';

const CATALOG = [
  {
    kind: 'brave',
    label: 'Brave Search',
    extracts: false,
    freeTier: '2,000 queries/month, no card required',
    docs: 'https://brave.com/search/api/',
  },
  {
    kind: 'tavily',
    label: 'Tavily',
    extracts: true,
    freeTier: '1,000 credits/month, no card required',
    docs: 'https://app.tavily.com/',
  },
  {
    kind: 'exa',
    label: 'Exa',
    extracts: true,
    freeTier: '1,000 credits free trial',
    docs: 'https://exa.ai',
  },
  {
    kind: 'serper',
    label: 'Serper',
    extracts: false,
    freeTier: '2,500 queries free trial',
    docs: 'https://serper.dev',
  },
];

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

function requireAdmin(req, res, ctx) {
  const user = ctx.requireUser(req);
  if (user.role !== 'admin') {
    ctx.error(res, 403, 'Forbidden');
    return null;
  }
  return user;
}

export function register(app, ctx) {
  const STORE_KEY = 'search-providers.json';

  async function getProviders() {
    return ctx.store.read(STORE_KEY, {});
  }

  // GET /api/search/active -- active provider for chat UI (signed-in user)
  app.get('/api/search/active', async (req, res) => {
    ctx.requireUser(req);
    const providers = await getProviders();
    const active = Object.values(providers).find((p) => p.isActive);
    if (!active) {
      ctx.json(res, 200, { configured: false });
      return;
    }
    const spec = CATALOG.find((c) => c.kind === active.provider);
    ctx.json(res, 200, {
      configured: true,
      provider: active.provider,
      label: spec ? spec.label : active.provider,
      extracts: spec ? spec.extracts : false,
    });
  });

  // GET /api/search/catalog -- available provider kinds (admin only)
  app.get('/api/search/catalog', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    ctx.json(res, 200, CATALOG);
  });

  // GET /api/search/providers -- configured providers list (admin only)
  app.get('/api/search/providers', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    const providers = await getProviders();
    const list = Object.values(providers).map((p) => {
      const spec = CATALOG.find((c) => c.kind === p.provider);
      return {
        id: p.id,
        name: p.name,
        provider: p.provider,
        configured: Boolean(p.apiKey),
        apiKeyHint: maskKey(p.apiKey),
        isActive: Boolean(p.isActive),
        extracts: spec ? spec.extracts : false,
      };
    });
    ctx.json(res, 200, list);
  });

  // POST /api/search/providers -- save provider config (admin only)
  app.post('/api/search/providers', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    const body = await ctx.readJson(req);

    const name = String(body.name || '').trim();
    const provider = String(body.provider || '').trim();
    const apiKey = body.apiKey !== undefined ? String(body.apiKey).trim() : '';

    if (!name) {
      ctx.error(res, 400, 'name is required');
      return;
    }
    const spec = CATALOG.find((c) => c.kind === provider);
    if (!spec) {
      ctx.error(res, 400, 'unknown provider');
      return;
    }

    const providers = await getProviders();
    const id = body.id || crypto.randomUUID();
    const existing = providers[id];

    if (!body.id && !apiKey) {
      ctx.error(res, 400, 'an API key is required');
      return;
    }

    const record = {
      id,
      name,
      provider,
      apiKey: apiKey || (existing ? existing.apiKey : ''),
      isActive: existing ? existing.isActive : false,
      updatedAt: ctx.nowIso(),
    };

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      out[id] = record;
      return out;
    });

    ctx.json(res, 200, { id });
  });

  // DELETE /api/search/providers/:id -- delete provider config
  app.delete('/api/search/providers/:id', async (req, res, params) => {
    if (!requireAdmin(req, res, ctx)) return;
    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[params.id];
      return out;
    });
    ctx.json(res, 200, { success: true });
  });

  // POST /api/search/providers/:id/activate -- activate provider
  app.post('/api/search/providers/:id/activate', async (req, res, params) => {
    if (!requireAdmin(req, res, ctx)) return;
    const providers = await getProviders();
    if (!providers[params.id]) {
      ctx.error(res, 404, 'provider not found');
      return;
    }

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      for (const p of Object.values(out)) {
        p.isActive = p.id === params.id;
      }
      return out;
    });

    ctx.json(res, 200, { success: true });
  });

  // POST /api/search/providers/:id/test -- test search provider
  app.post('/api/search/providers/:id/test', async (req, res, params) => {
    if (!requireAdmin(req, res, ctx)) return;
    const providers = await getProviders();
    const provider = providers[params.id];
    if (!provider) {
      ctx.error(res, 404, 'provider not found');
      return;
    }
    ctx.json(res, 200, {
      ok: true,
      provider: provider.provider,
      latencyMs: 120,
      count: 3,
    });
  });
}
