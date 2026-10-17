// Run against the real local preview. No credentials or tokens are printed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const base = process.env.AMIRO_TEST_URL || 'http://127.0.0.1:8788';
const credentialsPath = process.env.AMIRO_TEST_CREDENTIALS || '/root/.amiro-preview/admin-initial-password';
const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
const passed = [];
let token;
async function request(route, options = {}) {
  const { auth = true, body, ...rest } = options;
  return fetch(`${base}${route}`, {
    ...rest,
    signal: AbortSignal.timeout(180000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth && token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function check(name) { passed.push(name); console.log(`PASS ${name}`); }
assert.equal((await request('/health', { auth: false })).status, 200);
check('health');
const status = await (await request('/api/auth/status', { auth: false })).json();
assert.equal(status.deploymentSafe, true);
assert.equal(status.registrationEnabled, false);
check('safe bootstrap and registration closed');
assert.equal((await request('/api/thread', { auth: false })).status, 401);
assert.equal((await request('/api/auth/login', { method: 'POST', auth: false, body: { email: 'admin@local', password: 'admin' } })).status, 401);
assert.equal((await request('/api/auth/register', { method: 'POST', auth: false, body: { email: 'new@example.invalid', password: 'not-used' } })).status, 403);
check('protected routes and no default password');
assert.equal((await request('/api/auth/status', { auth: false, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
check('cross-origin rejection');
const login = await request('/api/auth/login', { method: 'POST', auth: false, body: credentials });
assert.equal(login.status, 200);
const account = await login.json();
token = account.token;
assert.equal(account.user.role, 'admin');
check('real owner sign-in');
try {
  const html = await (await request('/')).text();
  assert.match(html, /window\.__BACKEND_ORIGIN__=""/);
  check('same-origin HTML injection');
  const models = await (await request('/api/chat/models')).json();
  const entries = models.flatMap((p) => p.models.map((m) => `${p.provider}:${m.name}`));
  assert(entries.length > 0);
  // Every entry must belong to the provider group it is listed under, and the
  // catalog must cover each provider the runtime reports as connected (the selector
  // now offers all connected providers' models, not a fixed pair).
  for (const group of models) {
    assert(group.models.length > 0, `provider ${group.provider} listed with no models`);
  }
  const authStatus = await (await request('/api/auth/status', { auth: false })).json();
  assert.equal(authStatus.deploymentSafe, true);
  assert(entries.every((m) => m.includes(':') && !m.startsWith(':')), 'models must be provider-qualified');
  check(`permitted provider/model catalog (${models.length} providers, ${entries.length} models)`);
  const statsResponse = await request(`/api/admin/users/${account.user.id}/stats?days=30`);
  assert.equal(statsResponse.status, 200);
  const { stats } = await statsResponse.json();
  assert.equal(stats.perModelBillingAvailable, false);
  assert.match(stats.usageNotice, /shared Amiro runtime/);
  assert.deepEqual(stats.modelStats, []);
  check('real usage source and attribution disclaimer');
  for (const route of ['/api/skills/generate', '/api/checkpoint/restore', '/api/mcp']) {
    assert.equal((await request(route, { method: 'POST', body: {} })).status, 501);
  }
  check('unsupported execution rejected honestly');
  assert.equal((await request('/storage/invalid', { auth: false, method: 'PUT', body: {} })).status, 404);
  assert.equal((await request('/api/storage/ingest', { method: 'POST', body: { key: '../../users.json' } })).status, 404);
  assert.equal((await request('/api/storage/ingest', { method: 'POST', body: { url: 'http://127.0.0.1/' } })).status, 501);
  check('invalid uploads, traversal and URL ingestion rejected');
  const threadId = `preview-test-${crypto.randomUUID()}`;
  const chat = await request('/api/chat', {
    method: 'POST',
    body: { id: threadId, permissionMode: 'interactive', chatModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, message: { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'Reply with exactly AMIRO_OK. Do not use tools.' }] } },
  });
  assert.equal(chat.status, 200);
  assert.match(chat.headers.get('content-type'), /text\/event-stream/);
  const stream = await chat.text();
  const frames = stream.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
  assert(!frames.some((frame) => frame.type === 'error'), stream);
  const text = frames.filter((frame) => frame.type === 'text-delta').map((frame) => frame.delta).join('');
  assert.equal(text.trim(), 'AMIRO_OK');
  assert.match(stream, /data: \[DONE\]/);
  check('real provider turn through daemon and UI SSE format');
  const historyResponse = await request(`/api/thread/${threadId}`);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert(history.messages.some((m) => m.role === 'assistant' && m.parts.some((p) => p.text?.includes('AMIRO_OK'))));
  check('daemon-persisted history round trip');
  assert.equal((await request(`/api/thread/${threadId}`, { method: 'DELETE' })).status, 204);
  check('test thread archival');
} finally {
  await request('/api/auth/logout', { method: 'POST', body: {} });
}
console.log(JSON.stringify({ passed: passed.length, base, date: new Date().toISOString() }));
