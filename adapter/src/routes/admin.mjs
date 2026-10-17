// adapter/src/routes/admin.mjs -- admin user listing and stats.

import path from 'node:path';
import { getUserStats } from '../usage.mjs';

function requireAdmin(req, res, ctx) {
  const user = ctx.requireUser(req);
  if (user.role !== 'admin') {
    ctx.error(res, 403, 'Forbidden');
    return null;
  }
  return user;
}

export function register(app, ctx) {
  const usersFile = path.join(ctx.config.home, 'users.json');

  async function loadUsers() {
    const doc = await ctx.store.readJson(usersFile, { users: [] });
    return Array.isArray(doc.users) ? doc.users : [];
  }

  // GET /api/admin/users -- user list with search and pagination
  app.get('/api/admin/users', async (req, res) => {
    if (!requireAdmin(req, res, ctx)) return;
    const url = new URL(req.url, 'http://localhost');
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const limit = Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

    let users = await loadUsers();
    if (q) {
      users = users.filter((u) =>
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q))
      );
    }
    const total = users.length;
    const paged = users.slice(offset, offset + limit).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      emailVerified: true,
      image: u.image || null,
      banned: false,
      banReason: null,
      createdAt: u.createdAt || ctx.nowIso(),
      updatedAt: u.updatedAt || u.createdAt || ctx.nowIso(),
      lastLogin: u.lastLogin || null,
    }));

    ctx.json(res, 200, { users: paged, total, limit, offset });
  });

  // GET /api/admin/users/:id/stats -- user stats
  app.get('/api/admin/users/:id/stats', async (req, res, params) => {
    const sessionUser = requireAdmin(req, res, ctx);
    if (!sessionUser) return;
    const users = await loadUsers();
    // Self-view must never 404: a signed-in admin whose id is absent from
    // users.json (fresh install, OAuth user never persisted) falls back to
    // the session identity. Other unknown ids still 404.
    const targetUser = users.find((u) => u.id === params.id) ||
      (params.id === sessionUser.id ? {
        id: sessionUser.id,
        name: sessionUser.name || sessionUser.email || sessionUser.id,
        email: sessionUser.email || '',
        image: sessionUser.image || null,
        role: sessionUser.role,
        createdAt: sessionUser.createdAt || ctx.nowIso(),
        lastLogin: sessionUser.lastLogin || null,
      } : null);
    if (!targetUser) {
      ctx.error(res, 404, 'user not found');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const query = {
      days: url.searchParams.get('days'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    };
    const stats = await getUserStats(ctx, params.id, query);

    const userDetail = {
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      emailVerified: true,
      image: targetUser.image || null,
      role: targetUser.role,
      banned: false,
      banReason: null,
      createdAt: targetUser.createdAt || ctx.nowIso(),
      updatedAt: targetUser.updatedAt || targetUser.createdAt || ctx.nowIso(),
      lastLogin: targetUser.lastLogin || null,
    };

    ctx.json(res, 200, { user: userDetail, stats });
  });

  // GET /api/admin/users/:id -- single user details
  app.get('/api/admin/users/:id', async (req, res, params) => {
    if (!requireAdmin(req, res, ctx)) return;
    const users = await loadUsers();
    const targetUser = users.find((u) => u.id === params.id);
    if (!targetUser) {
      ctx.error(res, 404, 'user not found');
      return;
    }
    ctx.json(res, 200, {
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      emailVerified: true,
      image: targetUser.image || null,
      role: targetUser.role,
      banned: false,
      banReason: null,
      createdAt: targetUser.createdAt || ctx.nowIso(),
      updatedAt: targetUser.updatedAt || targetUser.createdAt || ctx.nowIso(),
      lastLogin: targetUser.lastLogin || null,
    });
  });

  // Dead routes per recon
  app.put('/api/admin/users/:id/role', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
  app.put('/api/admin/users/:id/ban', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
  app.delete('/api/admin/users/:id', async (_req, res) => {
    ctx.error(res, 404, 'removed');
  });
}
