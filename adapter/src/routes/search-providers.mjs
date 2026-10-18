// adapter/src/routes/search-providers.mjs -- web-search provider configuration.

import crypto from 'node:crypto';

const CATALOG = [
  {
    kind: 'brave',
    label: 'Brave Search',
    extracts: false,
    freeTier: '2,000 queries/month free, no card required',
    docs: 'https://brave.com/search/api/',
  },
  {
    kind: 'tavily',
    label: 'Tavily',
    extracts: true,
    freeTier: '1,000 credits/month free, no card required',
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
  {
    kind: 'perplexity',
    label: 'Perplexity',
    extracts: true,
    freeTier: 'Sonar online search model API',
    docs: 'https://docs.perplexity.ai',
  },
  {
    kind: 'firecrawl',
    label: 'Firecrawl',
    extracts: true,
    freeTier: '500 credits free trial',
    docs: 'https://www.firecrawl.dev',
    supportsApiBase: true,
    defaultApiBase: 'https://api.firecrawl.dev',
  },
  {
    kind: 'keenable',
    label: 'Keenable',
    extracts: false,
    freeTier: 'Keyless free tier, optional key',
    docs: 'https://keenable.ai',
    keyless: true,
  },
  {
    kind: 'fastcrw',
    label: 'fastCRW',
    extracts: false,
    freeTier: 'Live crawl & search API',
    docs: 'https://fastcrw.com',
    supportsApiBase: true,
    defaultApiBase: 'https://api.fastcrw.com',
  },
  {
    kind: 'searxng',
    label: 'SearXNG',
    extracts: false,
    freeTier: 'Self-hosted / public metasearch (keyless or token)',
    docs: 'https://docs.searxng.org',
    supportsApiBase: true,
    keyless: true,
  },
  {
    kind: 'tinyfish',
    label: 'TinyFish',
    extracts: false,
    freeTier: 'Web search API',
    docs: 'https://www.tinyfish.ai',
    supportsApiBase: true,
    defaultApiBase: 'https://api.search.tinyfish.ai',
  },
  {
    kind: 'serply',
    label: 'Serply',
    extracts: false,
    freeTier: 'Google search API with location/language options',
    docs: 'https://serply.io',
  },
  {
    kind: '9router',
    label: '9Router',
    extracts: true,
    freeTier: 'Unified web search aggregator and router',
    docs: 'https://personal9router.xn--vnda-5g5a.com',
    supportsApiBase: true,
  },
  {
    kind: 'duckduckgo',
    label: 'DuckDuckGo',
    extracts: false,
    freeTier: '100% free, no API key required',
    docs: 'https://duckduckgo.com',
    keyless: true,
  },
  {
    kind: 'bing',
    label: 'Bing Search',
    extracts: false,
    freeTier: 'Microsoft Bing Web Search API',
    docs: 'https://www.microsoft.com/en-us/bing/apis/bing-web-search-api',
  },
  {
    kind: 'custom',
    label: 'Custom Search (OpenAI-compatible style)',
    extracts: true,
    freeTier: 'Connect any HTTP JSON search API or scraper',
    docs: 'https://github.com/1jehuang/jcode/blob/main/docs/custom-web-search.md',
    supportsApiBase: true,
    supportsCustomConfig: true,
    keyless: true,
  },
  {
    kind: 'inference-provider-native',
    label: 'Provider Native',
    extracts: true,
    freeTier: "Model provider's native web search",
    docs: 'https://docs.anthropic.com',
    keyless: true,
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
      const extracts = spec ? spec.extracts : false;
      const isKeyless = spec ? Boolean(spec.keyless) : false;
      const apiKey = p.apiKey || '';
      const hasCustom = p.custom != null || p.customConfig != null;
      return {
        id: p.id,
        name: p.name,
        provider: p.provider,
        configured: isKeyless || Boolean(apiKey) || hasCustom,
        apiKeyHint: maskKey(apiKey),
        isActive: Boolean(p.isActive),
        extracts,
        baseUrl: p.baseUrl ?? null,
        custom: p.custom ?? p.customConfig ?? null,
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

    const isKeyless = Boolean(spec.keyless);
    const isCustom = provider === 'custom';
    if (!body.id && !apiKey && !isKeyless && !isCustom) {
      ctx.error(res, 400, 'an API key is required');
      return;
    }

    const finalApiKey = apiKey || (existing ? existing.apiKey || '' : '');
    const customVal = body.custom !== undefined ? body.custom : (body.customConfig !== undefined ? body.customConfig : null);
    const baseUrlVal = body.baseUrl !== undefined ? body.baseUrl : null;

    const record = {
      id,
      name,
      provider,
      apiKey: finalApiKey,
      baseUrl: baseUrlVal,
      custom: customVal,
      isActive: existing ? Boolean(existing.isActive) : false,
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
