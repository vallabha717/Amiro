import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../src/routes/admin.mjs';

function harness({ users }) {
  const handlers = {};
  const app = {
    get(path, handler) { handlers[path] = handler; },
    put(path, handler) { handlers[path] = handler; },
    delete(path, handler) { handlers[path] = handler; },
  };
  const calls = [];
  const ctx = {
    config: { home: '/unused' },
    store: { readJson: async () => ({ users }) },
    runtime: {
      readModelUsageTurns: async () => [],
      readOpenAiOauthUsage: async () => ({ accounts: {} }),
      runtimeUsage: async () => ({ providers: [] }),
    },
    nowIso: () => '2026-10-17T00:00:00.000Z',
    requireUser(req) {
      if (req.user) return req.user;
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    },
    json(res, status, body) { calls.push({ status, body }); res.status = status; res.body = body; },
    error(res, status, message) { calls.push({ status, message }); res.status = status; res.message = message; },
  };
  register(app, ctx);
  return { handlers, ctx, calls };
}

const sessionAdmin = { id: 'self-1', name: 'Self', email: 'self@x.test', role: 'admin' };

async function getStats(harnessCtx, user, id, query = '') {
  const { handlers } = harnessCtx;
  const res = {};
  const req = { url: `/api/admin/users/${id}/stats${query}`, user };
  await handlers['/api/admin/users/:id/stats'](req, res, { id });
  return res;
}

test('self-view stats never 404 when the admin id is absent from users.json', async () => {
  const h = harness({ users: [{ id: 'other-2', name: 'Other', email: 'o@x.test', role: 'admin' }] });
  const res = await getStats(h, sessionAdmin, 'self-1', '?days=30');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, 'self-1');
  assert.equal(res.body.stats.period, 'Last 30 Days');
});

test('stats for another unknown user still 404', async () => {
  const h = harness({ users: [{ id: 'other-2', name: 'Other', email: 'o@x.test', role: 'admin' }] });
  const res = await getStats(h, sessionAdmin, 'ghost-9');
  assert.equal(res.status, 404);
});

test('stats for a listed user keep working', async () => {
  const h = harness({ users: [{ id: 'other-2', name: 'Other', email: 'o@x.test', role: 'admin' }] });
  const res = await getStats(h, sessionAdmin, 'other-2');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, 'other-2');
});

test('non-admin callers are still refused', async () => {
  const h = harness({ users: [] });
  const res = await getStats(h, { ...sessionAdmin, role: 'user' }, 'self-1');
  assert.equal(res.status, 403);
});
