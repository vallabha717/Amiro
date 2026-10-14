// adapter/src/routes/workspace-trust.mjs -- workspace trust grants.

import path from 'node:path';

export function register(app, ctx) {
  const STORE_KEY = 'workspace-trust.json';

  async function getGrantsDoc() {
    return ctx.store.read(STORE_KEY, {});
  }

  function resolveRoot(raw) {
    if (!raw) return '';
    const clean = path.resolve(raw);
    return clean;
  }

  // GET /api/workspace-trust -- list granted roots
  app.get('/api/workspace-trust', async (req, res) => {
    const user = ctx.requireUser(req);
    const doc = await getGrantsDoc();
    const userGrants = (doc[user.id] || []).map((g) => ({
      resolvedRoot: g.resolvedRoot,
      grantedAt: g.grantedAt,
      grantedVia: g.grantedVia || 'prompt',
    }));

    ctx.json(res, 200, { grants: userGrants });
  });

  // GET /api/workspace-trust/status?root= -- check trust status
  app.get('/api/workspace-trust/status', async (req, res) => {
    const user = ctx.requireUser(req);
    const url = new URL(req.url, 'http://localhost');
    const rootParam = url.searchParams.get('root');

    if (!rootParam) {
      ctx.error(res, 400, 'root is required');
      return;
    }

    const resolved = resolveRoot(rootParam);
    const defaultRoot = resolveRoot(ctx.config.workspaceDir);

    // Default workspace is auto-trusted
    if (resolved === defaultRoot) {
      ctx.json(res, 200, { trusted: true, resolvedRoot: resolved });
      return;
    }

    const doc = await getGrantsDoc();
    const userGrants = doc[user.id] || [];
    const granted = userGrants.some((g) => g.resolvedRoot === resolved);

    ctx.json(res, 200, { trusted: granted, resolvedRoot: resolved });
  });

  // POST /api/workspace-trust/grant -- grant trust to root
  app.post('/api/workspace-trust/grant', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);

    if (!body.root) {
      ctx.error(res, 400, 'root is required');
      return;
    }

    const resolved = resolveRoot(body.root);
    const now = ctx.nowIso();

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      const list = out[user.id] || [];
      const idx = list.findIndex((g) => g.resolvedRoot === resolved);
      if (idx >= 0) {
        list[idx].grantedAt = now;
      } else {
        list.push({
          resolvedRoot: resolved,
          grantedAt: now,
          grantedVia: 'prompt',
        });
      }
      out[user.id] = list;
      return out;
    });

    ctx.json(res, 200, { trusted: true, resolvedRoot: resolved });
  });

  // POST /api/workspace-trust/revoke -- revoke trust
  app.post('/api/workspace-trust/revoke', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);

    if (!body.root) {
      ctx.error(res, 400, 'root is required');
      return;
    }

    const resolved = resolveRoot(body.root);

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      if (out[user.id]) {
        out[user.id] = out[user.id].filter((g) => g.resolvedRoot !== resolved);
      }
      return out;
    });

    ctx.json(res, 200, { success: true });
  });
}
