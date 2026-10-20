import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../src/routes/system.mjs';

function harness() {
  const routes = { GET: {}, POST: {} };
  const app = {
    get(path, handler) { routes.GET[path] = handler; },
    post(path, handler) { routes.POST[path] = handler; },
  };
  const calls = [];
  const ctx = {
    config: { home: '/unused' },
    requireUser(req) {
      if (req.user) return req.user;
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    },
    readJson: async (req) => req.body || {},
    json(res, status, body) {
      calls.push({ status, body });
      res.status = status;
      res.body = body;
    },
    error(res, status, message) {
      calls.push({ status, message });
      res.status = status;
      res.message = message;
    },
  };
  register(app, ctx);
  return { routes, ctx, calls };
}

const adminUser = { id: 'admin-1', role: 'admin', email: 'admin@x.test' };
const regularUser = { id: 'user-2', role: 'user', email: 'user@x.test' };

test('GET /api/system/update rejects unauthenticated callers with 401', async () => {
  const h = harness();
  const req = { url: '/api/system/update' };
  const res = {};
  await assert.rejects(
    () => h.routes.GET['/api/system/update'](req, res),
    (err) => err.status === 401,
  );
});

test('GET /api/system/update rejects non-admin users with 403', async () => {
  const h = harness();
  const req = { url: '/api/system/update', user: regularUser };
  const res = {};
  await h.routes.GET['/api/system/update'](req, res);
  assert.equal(res.status, 403);
  assert.equal(res.message, 'Forbidden');
});

test('GET /api/system/update succeeds for admin and returns status shape', async () => {
  const h = harness();
  const req = { url: '/api/system/update', user: adminUser };
  const res = {};
  await h.routes.GET['/api/system/update'](req, res);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.current, 'string');
  assert.equal(typeof res.body.updateAvailable, 'boolean');
  assert.equal(typeof res.body.checkFailed, 'boolean');
  assert.equal(typeof res.body.releaseUrl, 'string');
});

test('POST /api/system/update rejects non-admin users with 403', async () => {
  const h = harness();
  const req = { url: '/api/system/update', user: regularUser, body: {} };
  const res = {};
  await h.routes.POST['/api/system/update'](req, res);
  assert.equal(res.status, 403);
  assert.equal(res.message, 'Forbidden');
});

test('POST /api/system/update rejects unparseable versions with 400', async () => {
  const h = harness();
  const req = { url: '/api/system/update', user: adminUser, body: { version: 'invalid;shell' } };
  const res = {};
  await h.routes.POST['/api/system/update'](req, res);
  assert.equal(res.status, 400);
  assert.match(res.message, /unparseable version/);
});
