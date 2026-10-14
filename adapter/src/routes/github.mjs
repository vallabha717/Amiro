// adapter/src/routes/github.mjs -- GitHub token connection status.

export function register(app, ctx) {
  const STORE_KEY = 'github.json';

  async function getGithubConfig() {
    return ctx.store.read(STORE_KEY, { connected: false });
  }

  // GET /api/github/status -- check GitHub connection status
  app.get('/api/github/status', async (req, res) => {
    ctx.requireUser(req);
    const cfg = await getGithubConfig();
    ctx.json(res, 200, { connected: Boolean(cfg && cfg.connected && cfg.token) });
  });

  // POST /api/github/connect -- connect with GitHub personal access token
  app.post('/api/github/connect', async (req, res) => {
    ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const token = String(body.token || '').trim();

    if (!token) {
      ctx.error(res, 400, 'token is required');
      return;
    }

    await ctx.store.write(STORE_KEY, {
      connected: true,
      token,
      updatedAt: ctx.nowIso(),
    });

    ctx.json(res, 200, { connected: true });
  });

  // POST /api/github/disconnect -- disconnect GitHub
  app.post('/api/github/disconnect', async (req, res) => {
    ctx.requireUser(req);
    await ctx.store.write(STORE_KEY, {
      connected: false,
      token: null,
      updatedAt: ctx.nowIso(),
    });
    ctx.json(res, 200, { success: true });
  });
}
