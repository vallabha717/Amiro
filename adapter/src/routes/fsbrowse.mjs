// adapter/src/routes/fsbrowse.mjs -- list-only server filesystem browsing for folder picker.
//
// GET /api/fs/roots              -> { roots: string[] }
// GET /api/fs/browse?path=<abs>  -> { path, parent, roots, entries, truncated }
// GET /api/fs/stat?path=<abs>    -> { path, name, kind, exists, usable, denied?, outsideRoots? }
//
// Security: never returns file contents. All routes require an authenticated user
// (ctx.requireUser). Admin-only is NOT required: browsing is gated by allowed roots
// and the deny list in fsbrowse.mjs, which is sufficient for list-only access.

import { resolveBrowseRoots, listDirectory, statPath } from '../fsbrowse.mjs';

export function register(app, ctx) {
  app.get('/api/fs/roots', async (req, res) => {
    ctx.requireUser(req);
    const roots = resolveBrowseRoots();
    ctx.json(res, 200, { roots });
  });

  app.get('/api/fs/browse', async (req, res) => {
    ctx.requireUser(req);
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams.get('path');
    if (!p) {
      return ctx.error(res, 400, 'path is required');
    }
    try {
      const result = await listDirectory(p);
      ctx.json(res, 200, result);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const msg = err && err.message ? err.message : 'internal error';
      return ctx.error(res, status, msg);
    }
  });

  app.get('/api/fs/stat', async (req, res) => {
    ctx.requireUser(req);
    const url = new URL(req.url, 'http://localhost');
    const p = url.searchParams.get('path');
    if (!p) {
      return ctx.error(res, 400, 'path is required');
    }
    try {
      const result = await statPath(p);
      ctx.json(res, 200, result);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const msg = err && err.message ? err.message : 'internal error';
      return ctx.error(res, status, msg);
    }
  });
}
