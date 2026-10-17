// adapter/src/auth.mjs -- sidecar token check + users.json + Bearer sessions.
//
// Auth model (docs/_adapter-contract.md):
//   (a) sidecar shared secret X-Amiro-Token / X-BetterChatbot-Token, enforced by
//       server.mjs when AMIRO_TOKEN is set.
//   (b) user Bearer token (Authorization: Bearer <token>) resolving to a user
//       row; required on every route except the PUBLIC list below.
//
// Stores:
//   $AMIRO_HOME/users.json     -> { users: [{id,name,email,role,passwordHash,createdAt}] }
//   $AMIRO_HOME/sessions.json  -> { sessions: { <token>: {userId, createdAt} } }

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ADMIN_EMAIL = 'admin@local';

const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /api/auth/status',
  'POST /api/auth/login',
  'POST /api/auth/register',
  'GET /api/chat/models',
  'GET /api/mcp/oauth/callback',
]);

function hardenPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, expected] = stored.split(':');
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    image: user.image ?? null,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin ?? null,
  };
}

export function createAuth({ home, store, log }) {
  const usersFile = path.join(home, 'users.json');
  const sessionsFile = path.join(home, 'sessions.json');
  const passwordFile = path.join(home, 'admin-initial-password');

  // Registration is closed by default; a fresh install (no users) may still
  // bootstrap. Seeding an admin is on by default.
  const allowRegistration = process.env.AMIRO_ALLOW_REGISTRATION === '1';
  const seedAdmin = process.env.AMIRO_SEED_ADMIN !== '0';
  const allowInsecureAdmin = process.env.AMIRO_ALLOW_INSECURE_ADMIN === '1';

  // Bearer session lifetime. Default 7 days; 0 disables expiry.
  const ttlDays = Number(process.env.AMIRO_SESSION_TTL_DAYS ?? 7);
  const ttlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60 * 1000 : 0;

  let users = [];
  let sessions = {};
  let deploymentSafe = true;

  async function init() {
    const userDoc = await store.readJson(usersFile, { users: [] });
    users = Array.isArray(userDoc.users) ? userDoc.users : [];

    if (!users.length) {
      if (seedAdmin) {
        const password = crypto.randomBytes(18).toString('base64url');
        users = [
          {
            id: crypto.randomUUID(),
            name: 'Admin',
            email: ADMIN_EMAIL,
            role: 'admin',
            passwordHash: hardenPassword(password),
            createdAt: new Date().toISOString(),
            mustChangePassword: true,
          },
        ];
        await store.writeJson(usersFile, { users });
        await store.writeJson(passwordFile, {
          email: ADMIN_EMAIL,
          password,
          createdAt: new Date().toISOString(),
        });
        try {
          await fs.chmod(passwordFile, 0o600);
        } catch {
          /* best effort */
        }
        log(
          'warn',
          'seeded admin account with a random password; read it once from the mode-0600 file and change it',
          { email: ADMIN_EMAIL, passwordFile },
        );
      } else {
        log('warn', 'no users and AMIRO_SEED_ADMIN=0; first registration may bootstrap');
      }
    } else {
      // Never reset an existing password. If the known-insecure seeded admin is
      // present, refuse to start unless the operator explicitly accepts it.
      const insecure = users.find(
        (u) => String(u.email).toLowerCase() === ADMIN_EMAIL && verifyPassword('admin', u.passwordHash),
      );
      if (insecure) {
        deploymentSafe = false;
        const message =
          'insecure seeded admin (admin@local / admin) present; no password reset is performed';
        if (!allowInsecureAdmin) {
          const err = new Error(
            `${message}. Refusing to start. Use a clean AMIRO_HOME or set AMIRO_ALLOW_INSECURE_ADMIN=1 (dev only).`,
          );
          err.code = 'insecure_admin';
          throw err;
        }
        log('error', `${message}; AMIRO_ALLOW_INSECURE_ADMIN=1 set: deployment marked UNSAFE`);
      }
    }

    const sessionDoc = await store.readJson(sessionsFile, { sessions: {} });
    sessions = sessionDoc.sessions && typeof sessionDoc.sessions === 'object' ? sessionDoc.sessions : {};
    // Drop expired sessions on boot.
    let pruned = false;
    for (const [t, s] of Object.entries(sessions)) {
      if (expired(s)) {
        delete sessions[t];
        pruned = true;
      }
    }
    if (pruned) await persistSessions();
  }

  function expired(session) {
    if (!ttlMs || !session) return false;
    const started = Date.parse(session.createdAt || '');
    if (Number.isNaN(started)) return false;
    return Date.now() - started > ttlMs;
  }

  // Re-read users.json so direct writes by routes/user.mjs (profile, image,
  // preferences) are reflected without a restart. Password hashes are preserved
  // from memory when the file row omits them.
  async function reload() {
    const doc = await store.readJson(usersFile, { users: [] });
    const fileUsers = Array.isArray(doc.users) ? doc.users : [];
    if (!fileUsers.length) return;
    const byId = new Map(users.map((u) => [u.id, u]));
    users = fileUsers.map((fu) => {
      const prev = byId.get(fu.id) || {};
      return { ...prev, ...fu, passwordHash: fu.passwordHash || prev.passwordHash };
    });
  }

  async function persistUsers() {
    await store.writeJson(usersFile, { users });
  }

  // Patch one user row on disk without writing a whole stale in-memory array,
  // so a change made by another request is never silently reverted.
  async function patchUser(userId, patch) {
    await store.updateJson(usersFile, { users: [] }, (doc) => {
      const list = Array.isArray(doc.users) ? doc.users : [];
      const row = list.find((u) => u.id === userId);
      if (row) Object.assign(row, patch);
      else if (users.length) return { users: users.map((u) => (u.id === userId ? { ...u, ...patch } : u)) };
      else list.push({ id: userId, ...patch });
      return { users: list };
    });
  }

  async function persistSessions() {
    await store.writeJson(sessionsFile, { sessions });
  }

  function findByEmail(email) {
    const needle = String(email || '').toLowerCase();
    return users.find((u) => String(u.email).toLowerCase() === needle) || null;
  }

  function getUser(id) {
    return users.find((u) => u.id === id) || null;
  }

  async function issueToken(userId) {
    const t = crypto.randomBytes(32).toString('hex');
    sessions[t] = { userId, createdAt: new Date().toISOString() };
    await persistSessions();
    return t;
  }

  function bearerToken(req) {
    const header = req.headers.authorization || req.headers.Authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    return m ? m[1].trim() : null;
  }

  async function authenticate(req) {
    const t = bearerToken(req);
    if (!t) return null;
    const s = sessions[t];
    if (!s) return null;
    if (expired(s)) {
      delete sessions[t];
      persistSessions().catch(() => {});
      return null;
    }
    return getUser(s.userId);
  }

  function isPublic(method, pathname) {
    if (pathname === '/health') return true;
    if (pathname === '/storage' || pathname.startsWith('/storage/')) return true;
    return PUBLIC_ROUTES.has(`${method} ${pathname}`);
  }

  async function login(email, password) {
    // Re-read users.json first: a password or profile change written through the
    // API must take effect without a restart, and must not be reverted by the
    // lastLogin write below using a stale in-memory copy.
    try {
      await reload();
    } catch {
      /* keep in-memory */
    }
    const user = findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) return null;
    user.lastLogin = new Date().toISOString();
    await patchUser(user.id, { lastLogin: user.lastLogin }).catch(() => {});
    const t = await issueToken(user.id);
    return { user: publicUser(user), token: t };
  }

  // Single source of truth for password changes: updates memory and disk
  // together so the running server honours the new password immediately.
  async function changePassword(userId, currentPassword, newPassword) {
    await reload();
    const user = getUser(userId);
    if (!user) return { error: 'user not found', status: 404 };
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return { error: 'Incorrect current password', status: 400 };
    }
    const passwordHash = hardenPassword(newPassword);
    const updatedAt = new Date().toISOString();
    user.passwordHash = passwordHash;
    user.updatedAt = updatedAt;
    await patchUser(userId, { passwordHash, updatedAt });
    return { ok: true };
  }

  async function register(name, email, password) {
    if (!email || !password) return { error: 'email and password are required', status: 400 };
    if (findByEmail(email)) return { error: 'email already registered', status: 409 };
    const user = {
      id: crypto.randomUUID(),
      name: name || String(email).split('@')[0],
      email,
      role: 'user',
      passwordHash: hardenPassword(password),
      createdAt: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
    };
    users.push(user);
    await persistUsers();
    const t = await issueToken(user.id);
    return { user: publicUser(user), token: t };
  }

  async function logout(req) {
    const t = bearerToken(req);
    if (t && sessions[t]) {
      delete sessions[t];
      await persistSessions();
    }
  }

  function isAdmin(req) {
    return Boolean(req && req.user && req.user.role === 'admin');
  }

  function requireAdmin(req) {
    if (!isAdmin(req)) {
      const err = new Error('admin required');
      err.status = 403;
      throw err;
    }
    return req.user;
  }

  function register_routes(app, ctx) {
    app.get('/health', (_req, res) => ctx.json(res, 200, { status: 'ok' }));

    app.get('/api/auth/status', (_req, res) => {
      ctx.json(res, 200, {
        isFirstUser: users.length === 0,
        registrationEnabled: allowRegistration || users.length === 0,
        deploymentSafe,
      });
    });

    app.post('/api/auth/login', async (req, res) => {
      const body = await ctx.readJson(req);
      const result = await login(body.email, body.password);
      if (!result) return ctx.error(res, 401, 'invalid email or password');
      ctx.json(res, 200, result);
    });

    app.post('/api/auth/register', async (req, res) => {
      // Self-registration is closed by default; only a brand-new install may
      // bootstrap its first user.
      if (!allowRegistration && users.length > 0) {
        return ctx.error(res, 403, 'registration is disabled');
      }
      const body = await ctx.readJson(req);
      const result = await register(body.name, body.email, body.password);
      if (result.error) return ctx.error(res, result.status || 400, result.error);
      ctx.json(res, 200, result);
    });

    app.post('/api/auth/logout', async (req, res) => {
      await logout(req);
      res.writeHead(204);
      res.end();
    });

    app.get('/api/auth/session', async (req, res) => {
      const user = ctx.requireUser(req);
      // Reflect direct writes by routes/user.mjs (profile/image/preferences).
      try {
        await reload();
      } catch {
        /* keep in-memory */
      }
      const fresh = getUser(user.id) || user;
      ctx.json(res, 200, publicUser(fresh));
    });
  }

  return {
    init,
    authenticate,
    reload,
    changePassword,
    isPublic,
    publicUser,
    isAdmin,
    requireAdmin,
    registrationEnabled: () => allowRegistration || users.length === 0,
    deploymentSafe: () => deploymentSafe,
    listUsers: () => users.map(publicUser),
    getUser,
    findByEmail,
    register: register_routes,
  };
}
