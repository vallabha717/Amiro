// adapter/src/routes/archive.mjs -- archive CRUD and items.

import crypto from 'node:crypto';

export function register(app, ctx) {
  const STORE_KEY = 'archives.json';
  const ITEMS_KEY = 'archive-items.json';

  async function getArchives() {
    return ctx.store.read(STORE_KEY, {});
  }

  async function getItems() {
    return ctx.store.read(ITEMS_KEY, {});
  }

  // GET /api/archive -- list caller's archives with itemCount
  app.get('/api/archive', async (req, res) => {
    const user = ctx.requireUser(req);
    const archives = await getArchives();
    const items = await getItems();

    const result = Object.values(archives)
      .filter((a) => a.userId === user.id)
      .map((a) => {
        const count = Object.values(items).filter((i) => i.archiveId === a.id).length;
        return {
          id: a.id,
          name: a.name,
          description: a.description || null,
          userId: a.userId,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
          itemCount: count,
        };
      });

    ctx.json(res, 200, result);
  });

  // POST /api/archive -- create an archive
  app.post('/api/archive', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const name = String(body.name || '').trim();
    if (!name) {
      ctx.error(res, 400, 'name is required');
      return;
    }
    if (name.length > 100) {
      ctx.error(res, 400, 'name must be at most 100 characters');
      return;
    }

    const id = crypto.randomUUID();
    const now = ctx.nowIso();
    const archive = {
      id,
      name,
      description: body.description && String(body.description).trim() ? String(body.description).trim() : null,
      userId: user.id,
      createdAt: now,
      updatedAt: now,
    };

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      out[id] = archive;
      return out;
    });

    ctx.json(res, 200, archive);
  });

  // GET /api/archive/:id -- get archive details with items
  app.get('/api/archive/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const archives = await getArchives();
    const archive = archives[params.id];
    if (!archive) {
      ctx.error(res, 404, 'Archive not found');
      return;
    }
    if (archive.userId !== user.id) {
      ctx.error(res, 403, 'Forbidden');
      return;
    }

    const items = await getItems();
    const archiveItems = Object.values(items).filter((i) => i.archiveId === archive.id);

    ctx.json(res, 200, {
      id: archive.id,
      name: archive.name,
      description: archive.description || null,
      userId: archive.userId,
      createdAt: archive.createdAt,
      updatedAt: archive.updatedAt,
      items: archiveItems,
    });
  });

  // PUT /api/archive/:id -- update archive
  app.put('/api/archive/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const archives = await getArchives();
    const archive = archives[params.id];
    if (!archive) {
      ctx.error(res, 404, 'Archive not found');
      return;
    }
    if (archive.userId !== user.id) {
      ctx.error(res, 403, 'Forbidden');
      return;
    }

    const body = await ctx.readJson(req);
    const name = body.name !== undefined ? String(body.name).trim() : archive.name;
    const description = body.description !== undefined ? (body.description ? String(body.description).trim() : null) : archive.description;

    archive.name = name || archive.name;
    archive.description = description;
    archive.updatedAt = ctx.nowIso();

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      out[archive.id] = archive;
      return out;
    });

    ctx.json(res, 200, archive);
  });

  // DELETE /api/archive/:id -- delete archive
  app.delete('/api/archive/:id', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const archives = await getArchives();
    const archive = archives[params.id];
    if (!archive) {
      ctx.error(res, 404, 'Archive not found');
      return;
    }
    if (archive.userId !== user.id) {
      ctx.error(res, 403, 'Forbidden');
      return;
    }

    await ctx.store.update(STORE_KEY, {}, (doc) => {
      const out = doc || {};
      delete out[params.id];
      return out;
    });

    await ctx.store.update(ITEMS_KEY, {}, (doc) => {
      const out = doc || {};
      for (const [k, v] of Object.entries(out)) {
        if (v.archiveId === params.id) delete out[k];
      }
      return out;
    });

    ctx.json(res, 200, { success: true });
  });

  // POST /api/archive/:id/items -- add thread to archive
  app.post('/api/archive/:id/items', async (req, res, params) => {
    const user = ctx.requireUser(req);
    const archives = await getArchives();
    const archive = archives[params.id];
    if (!archive) {
      ctx.error(res, 404, 'Archive not found');
      return;
    }
    if (archive.userId !== user.id) {
      ctx.error(res, 403, 'Forbidden');
      return;
    }

    const body = await ctx.readJson(req);
    if (!body.itemId) {
      ctx.error(res, 400, 'itemId is required');
      return;
    }

    const itemId = String(body.itemId);
    const items = await getItems();

    // Check if already in archive
    const existing = Object.values(items).find(
      (i) => i.archiveId === archive.id && i.itemId === itemId
    );
    if (existing) {
      ctx.json(res, 200, existing);
      return;
    }

    const id = crypto.randomUUID();
    const item = {
      id,
      archiveId: archive.id,
      itemId,
      userId: user.id,
      addedAt: ctx.nowIso(),
    };

    await ctx.store.update(ITEMS_KEY, {}, (doc) => {
      const out = doc || {};
      out[id] = item;
      return out;
    });

    ctx.json(res, 200, item);
  });

  // Dead routes per recon
  app.get('/api/archive/:id/items', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
  app.delete('/api/archive/:id/items/:itemId', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
}
