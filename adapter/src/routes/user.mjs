// adapter/src/routes/user.mjs -- user profile details and preferences.
// Password changes live in auth.mjs, which owns the hash and the in-memory copy.

import path from 'node:path';

export function register(app, ctx) {
  const usersFile = path.join(ctx.config.home, 'users.json');
  const PREFS_KEY = 'user-preferences.json';

  async function loadUsersDoc() {
    return ctx.store.readJson(usersFile, { users: [] });
  }

  async function saveUsersDoc(doc) {
    return ctx.store.writeJson(usersFile, doc);
  }

  async function getPreferences() {
    return ctx.store.read(PREFS_KEY, {});
  }

  // GET /api/user/details -- caller's user details
  app.get('/api/user/details', async (req, res) => {
    const user = ctx.requireUser(req);
    const doc = await loadUsersDoc();
    const found = (doc.users || []).find((u) => u.id === user.id) || user;
    const prefsDoc = await getPreferences();
    const prefs = prefsDoc[user.id] || {};

    ctx.json(res, 200, {
      id: found.id,
      name: found.name,
      email: found.email,
      role: found.role,
      image: found.image || null,
      preferences: prefs,
      createdAt: found.createdAt || ctx.nowIso(),
      lastLogin: found.lastLogin || null,
    });
  });

  // PUT /api/user/details -- update profile details
  app.put('/api/user/details', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);

    const doc = await loadUsersDoc();
    const found = (doc.users || []).find((u) => u.id === user.id);
    if (!found) {
      ctx.error(res, 404, 'user not found');
      return;
    }

    if (body.name !== undefined) found.name = String(body.name).trim();
    if (body.image !== undefined) found.image = body.image ? String(body.image).trim() : null;
    found.updatedAt = ctx.nowIso();

    await saveUsersDoc(doc);

    ctx.json(res, 200, {
      id: found.id,
      name: found.name,
      email: found.email,
      role: found.role,
      image: found.image || null,
      createdAt: found.createdAt || ctx.nowIso(),
      lastLogin: found.lastLogin || null,
    });
  });

  // PUT /api/user/password -- change password.
  // Delegates to the auth module, which owns the password hash and keeps its
  // in-memory user copy in step with disk so the change takes effect at once.
  app.put('/api/user/password', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      ctx.error(res, 400, 'currentPassword and newPassword are required');
      return;
    }

    const result = await ctx.auth.changePassword(user.id, currentPassword, newPassword);
    if (result.error) {
      ctx.error(res, result.status || 400, result.error);
      return;
    }

    ctx.json(res, 200, { success: true });
  });

  // GET /api/user/auth-methods -- password presence check
  app.get('/api/user/auth-methods', async (req, res) => {
    ctx.requireUser(req);
    ctx.json(res, 200, { hasPassword: true });
  });

  // GET /api/user/preferences -- user preferences
  app.get('/api/user/preferences', async (req, res) => {
    const user = ctx.requireUser(req);
    const prefsDoc = await getPreferences();
    ctx.json(res, 200, prefsDoc[user.id] || {});
  });

  // PUT /api/user/preferences -- update user preferences
  app.put('/api/user/preferences', async (req, res) => {
    const user = ctx.requireUser(req);
    const body = await ctx.readJson(req);

    const updated = {
      displayName: body.displayName || undefined,
      profession: body.profession || undefined,
      responseStyleExample: body.responseStyleExample || undefined,
      botName: body.botName || undefined,
    };

    await ctx.store.update(PREFS_KEY, {}, (doc) => {
      const out = doc || {};
      out[user.id] = updated;
      return out;
    });

    ctx.json(res, 200, updated);
  });

  // Dead routes per recon
  app.get('/api/user/stats', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
  app.get('/api/user/details/:id', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
}
