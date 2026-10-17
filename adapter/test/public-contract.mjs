// Supplemental acceptance checks against real public HTTP and runtime data.
// Does not change provider credentials, application users or conversations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const base = process.env.AMIRO_TEST_URL || 'http://127.0.0.1:8788';
const credentials = JSON.parse(await readFile(process.env.AMIRO_TEST_CREDENTIALS || '/root/.amiro-preview/admin-initial-password', 'utf8'));
let token;
const results = [];
async function request(route, { method = 'GET', body, auth = true, headers = {} } = {}) {
  return fetch(`${base}${route}`, {
    method, headers: { ...(auth && token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000),
  });
}
function pass(requirement, evidence) {
  results.push({ requirement, evidence });
  console.log(`PASS ${requirement}: ${evidence}`);
}
const login = await request('/api/auth/login', { method: 'POST', auth: false, body: credentials });
assert.equal(login.status, 200);
const account = await login.json();
token = account.token;
try {
  for (const route of ['/', '/sign-in', '/onboarding', '/admin/usage']) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await response.text(), /window\.__BACKEND_ORIGIN__=""/);
    pass(`static output ${route}`, 'HTTP 200 HTML, same-origin backend injection, nosniff');
  }
  const statsResponse = await request(`/api/admin/users/${account.user.id}/stats?days=30`);
  assert.equal(statsResponse.status, 200);
  const { stats } = await statsResponse.json();
  // The engine's real state directory: AMIRO_RUNTIME_HOME first, then the
  // pre-rename variable, then its own legacy on-disk directory.
  const runtimeHome = process.env.AMIRO_RUNTIME_HOME || process.env.JCODE_HOME || path.join(os.homedir(), '.jcode');
  const data = JSON.parse(await readFile(path.join(runtimeHome, 'openai_oauth_usage.json'), 'utf8'));
  const start = new Date(Date.now() - 30 * 86400000);
  start.setUTCHours(0, 0, 0, 0);
  const expected = { prompt: 0, completion: 0, cost: 0 };
  for (const accountData of Object.values(data.accounts || {})) {
    for (const [date, daily] of Object.entries(accountData.days || {})) {
      if (Date.parse(`${date}T00:00:00Z`) < start.getTime()) continue;
      expected.prompt += Number(daily.input || 0);
      expected.completion += Number(daily.output || 0);
      expected.cost += Number(daily.known_usd || 0);
    }
  }
  assert.equal(stats.promptTokens, expected.prompt);
  assert.equal(stats.completionTokens, expected.completion);
  assert.equal(stats.totalTokens, expected.prompt + expected.completion);
  assert.equal(stats.totalCost, Number(expected.cost.toFixed(4)));
  assert.equal(stats.scope, 'shared-provider-account');
  assert.equal(stats.perUserAttributionAvailable, false);
  assert.equal(stats.perModelBillingAvailable, false);
  assert.deepEqual(stats.modelStats, []);
  pass('usage exactness and scope', 'API prompt/completion/total tokens and known cost equal the real runtime daily buckets, without per-user/model allocation');
  for (const query of ['days=0', 'days=not-a-number', 'from=not-a-date', 'from=2026-10-14&to=2026-10-01']) {
    assert.equal((await request(`/api/admin/users/${account.user.id}/stats?${query}`)).status, 400);
  }
  pass('usage invalid ranges', 'zero, nonnumeric, invalid and inverted dates rejected with HTTP 400');
  const defaultStats = await (await request(`/api/admin/users/${account.user.id}/stats`)).json();
  assert.equal(defaultStats.stats.period, 'Last 30 Days');
  pass('usage default filter', 'omitted range returns Last 30 Days');
  for (const route of ['/api/skills/generate', '/api/checkpoint/restore', '/api/mcp', '/api/search/providers']) {
    assert.equal((await request(route, { method: 'POST', body: {} })).status, 501);
  }
  pass('restricted execution and search', 'public mutation interfaces reject unsupported execution with HTTP 501');
  const allowedOrigin = await request('/api/auth/status', { auth: false, headers: { Origin: 'http://localhost:3210' } });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), 'http://localhost:3210');
  assert.equal((await request('/api/auth/status', { auth: false, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  pass('desktop-development CORS boundary', 'localhost:3210 permitted, unrelated origin rejected');
  for (const route of ['/api/thread', '/api/export']) {
    const response = await request(route);
    assert.equal(response.status, 200);
    assert(Array.isArray(await response.json()));
    pass(`compatibility list ${route}`, 'authenticated list returns an array without server failure');
  }
  assert.equal((await request('/api/thread/messages/msg_0_unmapped-audit-session', { method: 'DELETE' })).status, 404);
  assert.equal((await request('/api/thread/messages/msg_0_unmapped-audit-session/truncate', { method: 'POST', body: {} })).status, 404);
  pass('unmapped daemon session isolation', 'message mutation requires an owned application mapping, HTTP 404 before daemon execution');
} finally {
  await request('/api/auth/logout', { method: 'POST', body: {} });
}
console.log(JSON.stringify({ base, date: new Date().toISOString(), results }));
